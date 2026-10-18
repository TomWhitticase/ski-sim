"""Downhill pistes from OSM: rasterised coverage for rendering, a lookup grid for
"which piste am I on", edge marker poles, and teleport destinations.

OSM maps pistes as centrelines (no width tag here, so a per-difficulty default width is
used) and, for many runs, as area polygons with the true extent. Both are combined.
Difficulty follows the OSM convention, which in France maps to the piste colours:
novice = green, easy = blue, intermediate = red, advanced = black.
"""

from __future__ import annotations

import logging
import math

import numpy as np
from PIL import Image
from rasterio import features as rio_features
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from .config import Extent
from .frame import LocalFrame
from .grid import Grid

log = logging.getLogger(__name__)

# Codes stored in the lookup grid; 0 = no piste.
DIFFICULTY_CODES = {
    "novice": 1,
    "easy": 2,
    "intermediate": 3,
    "advanced": 4,
    "expert": 5,
    "freeride": 6,
}
DIFFICULTY_COLOURS = {  # French piste colours (RGB)
    1: (46, 158, 68),
    2: (28, 110, 220),
    3: (214, 40, 40),
    4: (25, 25, 28),
    5: (25, 25, 28),
    6: (240, 140, 0),
}
DEFAULT_WIDTH = {1: 30.0, 2: 35.0, 3: 30.0, 4: 25.0, 5: 20.0, 6: 20.0}
FREERIDE = DIFFICULTY_CODES["freeride"]
MARKER_SPACING = 40.0
RASTER_CELL = 2.0  # rasterise finer than the terrain, then downsample for soft edges
LOOKUP_CELL = 8.0


def _name(tags: dict) -> str | None:
    return tags.get("piste:name") or tags.get("name")


def _difficulty(tags: dict) -> int:
    if tags.get("piste:grooming") == "backcountry":
        return FREERIDE
    return DIFFICULTY_CODES.get(tags.get("piste:difficulty", ""), DIFFICULTY_CODES["easy"])


def collect(
    elements: list[dict], frame: LocalFrame, extent: Extent
) -> tuple[list[dict], list[tuple]]:
    """Group OSM ways into pistes. Returns (pistes, shapes) where shapes are
    (piste_index, shapely geometry already buffered to width, is_area, centreline|None)."""
    pistes: list[dict] = []
    index_of: dict[tuple, int] = {}
    shapes = []
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] != "way" or tags.get("piste:type") != "downhill":
            continue
        geometry = el.get("geometry", [])
        if len(geometry) < 2:
            continue
        lons = np.array([p["lon"] for p in geometry])
        lats = np.array([p["lat"] for p in geometry])
        east, north = frame.to_local(lons, lats)
        pts = np.column_stack([east, north])
        inside = (
            (pts[:, 0] >= extent.west)
            & (pts[:, 0] <= extent.east)
            & (pts[:, 1] >= extent.south)
            & (pts[:, 1] <= extent.north)
        )
        if not inside.any():
            continue

        name = _name(tags)
        difficulty = _difficulty(tags)
        # Named runs group across segments; unnamed segments group by difficulty only.
        key = (name, difficulty)
        if key not in index_of:
            index_of[key] = len(pistes)
            pistes.append(
                {
                    "index": len(pistes) + 1,  # 0 is reserved for "no piste"
                    "name": name,
                    "difficulty": difficulty,
                    "groomed": difficulty != FREERIDE,
                    "lines": [],
                    "areas": [],
                }
            )
        piste = pistes[index_of[key]]

        closed = geometry[0] == geometry[-1] and len(geometry) >= 4
        is_area = closed and (tags.get("area") == "yes" or "landuse" in tags)
        if is_area:
            polygon = Polygon(pts[:-1])
            if polygon.is_valid and polygon.area > 1:
                piste["areas"].append(polygon)
                shapes.append((piste["index"], polygon, True, None))
        else:
            line = LineString(pts)
            width = DEFAULT_WIDTH[difficulty]
            piste["lines"].append(line)
            shapes.append((piste["index"], line.buffer(width / 2, cap_style="round"), False, line))
    return pistes, shapes


def rasterise(shapes: list[tuple], grid: Grid, pistes: list[dict] | None = None) -> np.ndarray:
    """Piste index per cell (0 = none). Later shapes win where they overlap: named runs
    beat unnamed connectors, then surveyed areas beat buffered centrelines."""
    named = {p["index"] for p in pistes if p.get("name")} if pistes else set()
    ordered = sorted(shapes, key=lambda s: (s[0] in named, s[2]))
    return rio_features.rasterize(
        [(geom, idx) for idx, geom, _, _ in ordered],
        out_shape=(grid.height, grid.width),
        transform=grid.transform,
        fill=0,
        dtype="uint16",
    )


def _box_average(values: np.ndarray, factor: int) -> np.ndarray:
    """Mean over a (2·factor-1)² window centred on every factor-th sample."""
    pad = factor - 1
    padded = np.pad(values, pad, mode="edge")
    integral = np.pad(padded.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    k = 2 * factor - 1
    window = (integral[k:, k:] - integral[:-k, k:] - integral[k:, :-k] + integral[:-k, :-k]) / (
        k * k
    )
    return window[::factor, ::factor]


def overlay_image(fine: np.ndarray, pistes: list[dict], factor: int) -> Image.Image:
    """RGBA texture on the terrain grid: A = groomed-piste coverage, RGB = piste colour
    premultiplied by coverage (so soft edges fade out instead of toward another hue).
    Freeride itineraries are left out: they're not groomed pistes."""
    colours = np.zeros((len(pistes) + 1, 4), dtype=np.float32)
    for p in pistes:
        if p["groomed"]:
            colours[p["index"]] = (*DIFFICULTY_COLOURS[p["difficulty"]], 255)
    per_cell = colours[fine]  # fine-grid RGBA, A = 255 inside groomed pistes
    channels = [_box_average(per_cell[..., c], factor) for c in range(4)]
    coverage = channels[3] / 255
    rgba = np.dstack([channels[0], channels[1], channels[2], coverage * 255])
    # RGB averaged with zeros outside pistes is already premultiplied by coverage.
    return Image.fromarray(np.clip(np.round(rgba), 0, 255).astype(np.uint8), mode="RGBA")


def lookup_image(fine: np.ndarray, pistes: list[dict], factor: int) -> Image.Image:
    """Coarse RGB lookup grid: R,G = piste index (16-bit, little-endian), B = difficulty."""
    ids = fine[::factor, ::factor].astype(np.uint16)
    difficulty = np.zeros(len(pistes) + 1, dtype=np.uint8)
    for p in pistes:
        difficulty[p["index"]] = p["difficulty"]
    rgb = np.dstack([ids & 0xFF, ids >> 8, difficulty[ids]]).astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB")


def edge_markers(
    shapes: list[tuple], pistes: list[dict], fine: np.ndarray, grid: Grid, ground
) -> list[list]:
    """Poles every MARKER_SPACING m along the outer edge of the groomed skiable area,
    each tagged with the index of the piste it borders."""
    groomed_ids = {p["index"] for p in pistes if p["groomed"]}
    groomed = [geom for idx, geom, _, _ in shapes if idx in groomed_ids]
    if not groomed:
        return []
    union = unary_union(groomed).simplify(1.0)
    rings = []
    for poly in getattr(union, "geoms", [union]):
        rings.append(poly.exterior)
        rings.extend(poly.interiors)

    points = []
    for ring in rings:
        n = int(ring.length // MARKER_SPACING)
        for i in range(n):
            p = ring.interpolate(i * MARKER_SPACING)
            points.append((p.x, p.y))
    if not points:
        return []
    pts = np.array(points)

    # Colour: the piste index found just inside the edge (search a few fine cells).
    cols = np.round((pts[:, 0] - grid.extent.west) / grid.cell_size).astype(int)
    rows = np.round((grid.extent.north - pts[:, 1]) / grid.cell_size).astype(int)
    found = np.zeros(len(pts), dtype=np.uint16)
    for r in range(4):
        for dr in range(-r, r + 1):
            for dc in range(-r, r + 1):
                rr = np.clip(rows + dr, 0, grid.height - 1)
                cc = np.clip(cols + dc, 0, grid.width - 1)
                v = fine[rr, cc]
                take = (found == 0) & (v > 0)
                found[take] = v[take]
    heights = ground(pts[:, 0], pts[:, 1])
    return [
        [round(float(e), 1), round(float(n), 1), round(float(h), 1), int(i)]
        for (e, n), h, i in zip(pts, heights, found, strict=True)
        if i in groomed_ids
    ]


def summarise(pistes: list[dict], ground) -> list[dict]:
    """JSON-ready piste records with length, a label point and the top of the run."""
    out = []
    for p in pistes:
        lines = p["lines"]
        geoms = lines + [a.exterior for a in p["areas"]]
        coords = np.vstack([np.asarray(g.coords) for g in geoms])
        heights = ground(coords[:, 0], coords[:, 1])
        top = int(np.argmax(heights))
        te, tn = coords[top]
        heading = _start_heading(lines, (te, tn), ground)
        if heading is None:  # area-only run: follow the fall line
            be, bn = coords[int(np.argmin(heights))]
            heading = (math.degrees(math.atan2(be - te, bn - tn)) + 360) % 360
        label = (
            max(lines, key=lambda line: line.length).interpolate(0.5, normalized=True)
            if lines
            else p["areas"][0].representative_point()
        )
        out.append(
            {
                "index": p["index"],
                "name": p["name"],
                "difficulty": p["difficulty"],
                "groomed": p["groomed"],
                "length": round(sum(line.length for line in lines), 1),
                "top": {
                    "east": round(float(te), 1),
                    "north": round(float(tn), 1),
                    "ground": round(float(heights[top]), 1),
                    "heading": round(heading, 1),
                },
                "vertical": round(float(heights[top] - heights.min()), 1),
                "label": {"east": round(label.x, 1), "north": round(label.y, 1)},
                "lines": [np.round(np.asarray(line.coords), 1).tolist() for line in lines],
                "areas": [np.round(np.asarray(a.exterior.coords), 1).tolist() for a in p["areas"]],
            }
        )
    return out


START_LOOKAHEAD = 60.0  # metres down the run used to aim a skier starting at the top


def _start_heading(lines: list[LineString], top: tuple[float, float], ground) -> float | None:
    """Compass heading from the top of a run toward a point a little way down it, along
    whichever centreline starts there. None if no centreline touches the top."""
    best = None
    start = Point(top)
    for line in lines:
        if line.distance(start) > 1:
            continue
        d = line.project(start)
        for along in (d + START_LOOKAHEAD, d - START_LOOKAHEAD):
            p = line.interpolate(min(max(along, 0), line.length))
            h = float(ground(np.array([p.x]), np.array([p.y]))[0])
            if best is None or h < best[0]:
                best = (h, p.x, p.y)
    if best is None:
        return None
    _, x, y = best
    return (math.degrees(math.atan2(x - top[0], y - top[1])) + 360) % 360
