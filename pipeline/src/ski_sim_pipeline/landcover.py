"""Land cover from ESA WorldCover: forests, bare rock, glaciers and water, as textures the
sim shades the terrain with and places trees from.

Each layer is the fraction of a cell covered by that class (WorldCover's 10 m classes
averaged onto our grid). Tree cover is then cleared where trees can't stand: groomed
pistes, lift corridors and stations, and buildings. The sim scatters individual trees
from the cleared tree cover; their positions, heights and species are synthetic (seeded
per cell) and only the tree cover itself is data.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio import features as rio_features
from rasterio.crs import CRS
from rasterio.warp import Resampling, reproject
from shapely.geometry import LineString, Point, Polygon

from . import terminals
from .grid import Grid, sample_bilinear
from .sources import worldcover

log = logging.getLogger(__name__)

#: Coverage layers. The texture is RGB (an alpha channel would be premultiplied away when
#: browsers decode it): R tree, G rock, B 128 + 127·ice - 128·water (lakes and glaciers
#: don't overlap, and a blend between them passes through "neither").
LAYERS = {
    "tree": (worldcover.TREE_COVER,),
    "rock": (worldcover.BARE,),
    "ice": (worldcover.SNOW_ICE,),
    "water": (worldcover.WATER,),
}
NEAR_CELL = 8.0  # WorldCover is 10 m; finer would only add bytes
FAR_SOURCE_RESOLUTION = 40.0

# Where trees are cleared (half-widths, m). Real lift corridors through forest are cut
# ~20-30 m wide: the carriers ride ~3-4 m either side of the line and a valley spruce's
# branches spread up to ~5 m from its trunk. Cable cars span high over the forest.
CORRIDOR_HALF_WIDTH = {"chair": 14.0, "gondola": 14.0, "cabin": 5.0, "drag": 5.0}
PISTE_MARGIN = 3.0
BUILDING_MARGIN = 4.0
STATION_MARGIN = 12.0

# Shadowed rock at altitude is sometimes classed as tree cover: drop "trees" well above
# the resort's tree line or on cliffs.
TREE_LINE_PERCENTILE = 99.0
ABOVE_TREE_LINE = 120.0
MAX_TREE_SLOPE = 55.0  # degrees

#: Synthetic tree heights (m) the sim scales between: tall in the valleys, stunted at the
#: tree line. Typical of montane / subalpine conifers (spruce, fir, larch, pine).
TREE_HEIGHT = {"valley": 26.0, "treeLine": 7.0}


def fractions(paths: list[Path], grid: Grid, frame) -> dict[str, np.ndarray]:
    """Coverage fraction (0-1) of each layer per grid cell."""
    out = {name: np.zeros((grid.height, grid.width), dtype=np.float32) for name in LAYERS}
    dst_crs = CRS.from_wkt(frame.crs.to_wkt())
    for path in paths:
        with rasterio.open(path) as src:
            classes = src.read(1)
            for name, codes in LAYERS.items():
                onehot = np.isin(classes, codes).astype(np.float32)
                onehot[classes == 0] = np.nan  # no data
                layer = np.full_like(out[name], np.nan)
                reproject(
                    source=onehot,
                    destination=layer,
                    src_transform=src.transform,
                    src_crs=src.crs,
                    src_nodata=np.nan,
                    dst_transform=grid.transform,
                    dst_crs=dst_crs,
                    dst_nodata=np.nan,
                    resampling=Resampling.average,
                )
                covered = ~np.isnan(layer)
                out[name][covered] = layer[covered]
    return out


def soften(values: np.ndarray) -> np.ndarray:
    """3x3 box blur (edges clamped): soft class boundaries instead of stair-stepped cells."""
    padded = np.pad(values, 1, mode="edge")
    total = np.zeros_like(values)
    for dr in range(3):
        for dc in range(3):
            total += padded[dr : dr + values.shape[0], dc : dc + values.shape[1]]
    return total / 9


def clearings(
    grid: Grid,
    piste_shapes: list[tuple],
    groomed: set[int],
    lifts: list[dict],
    buildings: list[dict],
    terraces: list[list] | None = None,
) -> np.ndarray:
    """True where trees must not stand: groomed pistes, lift lines and stations, buildings
    and restaurant terraces (`terraces`: their rings)."""
    shapes = [geom.buffer(PISTE_MARGIN) for idx, geom, _, _ in piste_shapes if idx in groomed]
    for lift in lifts:
        kind = terminals.KIND.get(lift["type"])
        line = [(s["east"], s["north"]) for s in lift["supports"]]
        if kind is not None and len(line) >= 2:
            shapes.append(LineString(line).buffer(CORRIDOR_HALF_WIDTH[kind], cap_style="flat"))
        for t in lift.get("terminals", []):
            size = (t["length"] + t["back"] + t["width"]) / 2
            shapes.append(Point(t["east"], t["north"]).buffer(size + STATION_MARGIN))
    for b in buildings:
        polygon = Polygon(b["footprint"])
        if polygon.is_valid:
            shapes.append(polygon.buffer(BUILDING_MARGIN))
    for ring in terraces or []:
        polygon = Polygon(ring)
        if polygon.is_valid:
            shapes.append(polygon.buffer(BUILDING_MARGIN))
    if not shapes:
        return np.zeros((grid.height, grid.width), dtype=bool)
    return rio_features.rasterize(
        [(s, 1) for s in shapes],
        out_shape=(grid.height, grid.width),
        transform=grid.transform,
        fill=0,
        all_touched=True,
        dtype="uint8",
    ).astype(bool)


def slope_degrees(heights: np.ndarray, cell: float) -> np.ndarray:
    dn, de = np.gradient(heights, cell)
    return np.degrees(np.arctan(np.hypot(de, dn)))


def tree_line(tree: np.ndarray, heights: np.ndarray) -> float | None:
    """Elevation (m) below which nearly all of the resort's forest grows."""
    forest = heights[tree > 0.5]
    if forest.size < 100:
        return None
    return float(np.percentile(forest, TREE_LINE_PERCENTILE))


def encode(layers: dict[str, np.ndarray]) -> Image.Image:
    def clip(name: str) -> np.ndarray:
        return np.clip(layers[name], 0, 1)

    blue = 128 + 127 * clip("ice") - 128 * clip("water")
    rgb = np.dstack([clip("tree") * 255, clip("rock") * 255, blue])
    return Image.fromarray(np.round(rgb).astype(np.uint8), mode="RGB")


def build(
    frame,
    raw_dir: Path,
    out_dir: Path,
    near: np.ndarray,
    near_grid: Grid,
    far_grid: Grid,
    piste_shapes: list[tuple],
    groomed: set[int],
    features: dict,
) -> tuple[dict, dict, object]:
    """Writes landcover-near.png / landcover-far.png. Returns the manifest entry, stats and
    a sampler of the (cleared) tree cover: `tree_cover(east, north)`."""
    cache = raw_dir / "worldcover"
    cell = near_grid.cell_size * max(1, round(NEAR_CELL / near_grid.cell_size))
    grid = Grid(near_grid.extent, cell)
    lonlat = frame.bounds_in("EPSG:4326", grid.extent, margin=100)
    layers = fractions(worldcover.fetch(lonlat, cache), grid, frame)
    east, north = np.broadcast_arrays(*grid.coords())
    heights = sample_bilinear(near, near_grid, east, north).astype(np.float32)

    tree = layers["tree"]
    line = tree_line(tree, heights)
    stray = np.zeros(tree.shape, dtype=bool)
    if line is not None:
        stray |= heights > line + ABOVE_TREE_LINE
    stray |= slope_degrees(heights, cell) > MAX_TREE_SLOPE
    terraces = [r["terrace"]["ring"] for r in features.get("restaurants", []) if r["terrace"]]
    cleared = clearings(
        grid, piste_shapes, groomed, features["lifts"], features["buildings"], terraces
    )
    forest_before = float(tree.sum())
    tree[stray | cleared] = 0
    layers = {name: soften(values) for name, values in layers.items()}
    encode(layers).save(out_dir / "landcover-near.png", optimize=True)

    far_lonlat = frame.bounds_in("EPSG:4326", far_grid.extent, margin=far_grid.cell_size)
    far_layers = fractions(
        worldcover.fetch(far_lonlat, cache, FAR_SOURCE_RESOLUTION), far_grid, frame
    )
    encode(far_layers).save(out_dir / "landcover-far.png", optimize=True)

    km2 = cell * cell / 1e6
    stats = {
        "treeLine": round(line, 1) if line is not None else None,
        "forestKm2": round(float(layers["tree"].sum()) * km2, 2),
        "forestClearedKm2": round((forest_before - float(tree.sum())) * km2, 2),
        "rockKm2": round(float(layers["rock"].sum()) * km2, 2),
        "iceKm2": round(float(layers["ice"].sum()) * km2, 2),
        "waterKm2": round(float(layers["water"].sum()) * km2, 2),
    }
    log.info(
        "Land cover: %.1f km² forest (%.1f km² cleared for pistes, lifts, buildings and "
        "stray cells), tree line %s m, %.1f km² bare rock, %.1f km² snow & ice, %.2f km² water",
        stats["forestKm2"],
        stats["forestClearedKm2"],
        f"{line:.0f}" if line is not None else "n/a",
        stats["rockKm2"],
        stats["iceKm2"],
        stats["waterKm2"],
    )
    meta = {
        "channels": "R tree, G rock, B 128 + 127 ice - 128 water",
        "near": {"file": "landcover-near.png", "cellSize": cell, "extent": grid.extent.to_json()},
        "far": {
            "file": "landcover-far.png",
            "cellSize": far_grid.cell_size,
            "extent": far_grid.extent.to_json(),
        },
        "trees": {
            "treeLine": stats["treeLine"],
            "height": TREE_HEIGHT,
            "synthetic": "positions, heights and species are generated per cell from the "
            "tree cover (seeded, deterministic); heights scale with elevation below the tree "
            "line",
        },
    }

    def tree_cover(east: np.ndarray, north: np.ndarray) -> np.ndarray:
        return sample_bilinear(layers["tree"], grid, east, north)

    return meta, stats, tree_cover
