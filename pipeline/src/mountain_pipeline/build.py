"""Builds a resort's processed assets: terrain heightmaps, minimap and manifest."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from rasterio.warp import Resampling

from . import minimap
from .config import ResortConfig, load_resort
from .export import write_heightmap
from .frame import LocalFrame
from .grid import Grid, reproject_into, sample_bilinear, stitch_far_to_near
from .sources import copernicus, ign

log = logging.getLogger(__name__)

MANIFEST_VERSION = 1
LANDMARK_SEARCH_RADIUS = 30.0  # OSM summit nodes are often a few metres off the true top
LANDMARK_TOLERANCE = 15.0


def build_far(cfg: ResortConfig, frame: LocalFrame, raw_dir: Path) -> tuple[np.ndarray, Grid]:
    if cfg.far.sources != ("copernicus-glo30",):
        raise ValueError(f"Unsupported far terrain sources {cfg.far.sources!r}")
    grid = Grid(cfg.far.extent, cfg.far.cell_size)
    bounds = frame.bounds_in("EPSG:4326", grid.extent, margin=cfg.far.cell_size * 2)
    heights = grid.empty()
    for path in copernicus.fetch(bounds, raw_dir / "copernicus-glo30"):
        reproject_into(heights, grid, frame, path, Resampling.bilinear)
    missing = np.isnan(heights)
    if missing.any():
        log.warning("Far terrain: %d cells without data, filling with 0 m", missing.sum())
        heights[missing] = 0.0
    return heights, grid


def build_near(
    cfg: ResortConfig, frame: LocalFrame, raw_dir: Path, far: np.ndarray, far_grid: Grid
) -> tuple[np.ndarray, Grid, dict[str, float]]:
    """Fill the near grid from each source in priority order; returns per-source coverage."""
    grid = Grid(cfg.near.extent, cfg.near.cell_size)
    fetch_cell = cfg.near.fetch_cell_size or cfg.near.cell_size
    bounds = frame.bounds_in(ign.CRS, grid.extent, margin=cfg.near.cell_size * 4)
    heights = grid.empty()
    coverage: dict[str, float] = {}

    for source in cfg.near.sources:
        layer = ign.LAYERS.get(source)
        if layer is None:
            raise ValueError(f"Unsupported near terrain source {source!r}")
        layer_heights = grid.empty()
        for path in ign.fetch(layer, bounds, fetch_cell, raw_dir):
            reproject_into(
                layer_heights,
                grid,
                frame,
                path,
                Resampling.average,
                src_crs=ign.CRS,
                src_nodata=ign.NODATA,
            )
        fill = np.isnan(heights) & ~np.isnan(layer_heights)
        heights[fill] = layer_heights[fill]
        coverage[source] = round(float(fill.mean()), 6)
        log.info("Near terrain: %.2f%% of cells from %s", 100 * fill.mean(), source)
        if not np.isnan(heights).any():
            break

    holes = np.isnan(heights)
    if holes.any():
        log.warning("Near terrain: %d cells filled from far terrain", holes.sum())
        east, north = np.broadcast_arrays(*grid.coords())
        heights[holes] = sample_bilinear(far, far_grid, east[holes], north[holes])
        coverage["far"] = round(float(holes.mean()), 6)
    return heights, grid, coverage


def validate_landmarks(
    cfg: ResortConfig, frame: LocalFrame, heights: np.ndarray, grid: Grid
) -> list[dict]:
    """Compare DEM summit heights against published elevations."""
    results = []
    r = int(np.ceil(LANDMARK_SEARCH_RADIUS / grid.cell_size))
    for lm in cfg.landmarks:
        east, north = frame.to_local(lm.lon, lm.lat)
        if not grid.extent.contains(east, north):
            continue
        col = round((east - grid.extent.west) / grid.cell_size)
        row = round((grid.extent.north - north) / grid.cell_size)
        window = heights[max(row - r, 0) : row + r + 1, max(col - r, 0) : col + r + 1]
        dem = float(window.max())
        error = dem - lm.ele
        ok = abs(error) <= LANDMARK_TOLERANCE
        (log.info if ok else log.warning)(
            "Landmark %-22s published %6.0f m  DEM %7.1f m  error %+6.1f m%s",
            lm.name,
            lm.ele,
            dem,
            error,
            "" if ok else "  <-- OUT OF TOLERANCE",
        )
        results.append(
            {"name": lm.name, "published": lm.ele, "dem": round(dem, 1), "error": round(error, 1)}
        )
    return results


def build(resort_dir: Path, raw_root: Path, out_root: Path) -> Path:
    """Source caches under `raw_root` are shared across resorts."""
    cfg = load_resort(resort_dir / "resort.json")
    frame = LocalFrame(cfg.origin)
    out_dir = out_root / cfg.id
    out_dir.mkdir(parents=True, exist_ok=True)

    log.info("Building far terrain (%s)", ", ".join(cfg.far.sources))
    far, far_grid = build_far(cfg, frame, raw_root)
    log.info("Building near terrain (%s)", ", ".join(cfg.near.sources))
    near, near_grid, coverage = build_near(cfg, frame, raw_root, far, far_grid)
    stitch_far_to_near(far, far_grid, near, near_grid)

    validation = validate_landmarks(cfg, frame, near, near_grid)

    log.info("Writing outputs to %s", out_dir)
    near_meta = write_heightmap(out_dir / "terrain-near.bin", near, near_grid)
    far_meta = write_heightmap(out_dir / "terrain-far.bin", far, far_grid)

    factor = max(1, round(cfg.minimap.cell_size / near_grid.cell_size))
    mm_heights = minimap.downsample(near, factor)
    minimap.render(mm_heights, near_grid.cell_size * factor, cfg.minimap.contour_interval).save(
        out_dir / "minimap.png", optimize=True
    )
    mm_cell = near_grid.cell_size * factor
    ext = near_grid.extent
    # Each minimap pixel covers a block of grid samples; its edges are half a sample out.
    half = near_grid.cell_size / 2
    minimap_meta = {
        "file": "minimap.png",
        "extent": {
            "west": ext.west - half,
            "north": ext.north + half,
            "east": ext.west - half + mm_heights.shape[1] * mm_cell,
            "south": ext.north + half - mm_heights.shape[0] * mm_cell,
        },
    }

    spawn_east, spawn_north = frame.to_local(cfg.spawn.lon, cfg.spawn.lat)
    now = datetime.now(UTC).replace(microsecond=0).isoformat()
    manifest = {
        "version": MANIFEST_VERSION,
        "generatedAt": now,
        "resort": {"id": cfg.id, "name": cfg.name, "country": cfg.country},
        "origin": {"lat": cfg.origin.lat, "lon": cfg.origin.lon},
        "projection": frame.proj4,
        "spawn": {
            "east": round(spawn_east, 2),
            "north": round(spawn_north, 2),
            "altitude": cfg.spawn.altitude,
            "heading": cfg.spawn.heading,
        },
        "terrain": {"near": near_meta, "far": far_meta},
        "minimap": minimap_meta,
        "validation": {"landmarks": validation, "nearCoverage": coverage},
        "provenance": [
            *(
                {
                    "layer": "terrain.near",
                    **ign.LAYERS[source].provenance,
                    "processedResolution": near_grid.cell_size,
                    "coverage": fraction,
                }
                for source, fraction in coverage.items()
                if source in ign.LAYERS and fraction > 0
            ),
            {
                "layer": "terrain.far",
                **copernicus.PROVENANCE,
                "processedResolution": far_grid.cell_size,
            },
        ],
    }
    path = out_dir / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    log.info("Done: %s", path)
    return path
