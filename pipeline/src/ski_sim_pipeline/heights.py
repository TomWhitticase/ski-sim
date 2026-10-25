"""Building heights from lidar: IGN LiDAR HD MNH (height above ground) where it covers.

OSM has a height on hardly any building (12 of 20,706 in Les 3 Vallées), so heights were
estimated from footprint area, which makes a 1,400 m² gondola station five storeys tall.
The MNH measures every roof. For each building (wing) it's sampled every MNH_CELL inside
the footprint shrunk by EDGE (eaves and walls blur into the ground at the edge):
- the eaves height is a low percentile (EAVES_PCT) of the roof samples, the ridge a high
  one (RIDGE_PCT): the walls stand to the eaves, the roof rises to the ridge;
- a roof rising less than FLAT_RISE is flat (big blocks often are);
- too few samples, or a roof lower than MIN_HEIGHT (a building that's gone, or a
  footprint off its building), keep the estimate.
An OSM `height` tag still wins. Heights are written as `heightSource: "lidar"`.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from shapely import contains_xy
from shapely.geometry import Polygon

from .frame import LocalFrame
from .sources import ign

log = logging.getLogger(__name__)

MNH_CELL = 1.0
EDGE = 0.75
MIN_SAMPLES = 8
EAVES_PCT = 25
RIDGE_PCT = 95
FLAT_RISE = 0.7
MIN_HEIGHT = 2.0
MAX_RISE = 9.0
#: Pixels in a tile this far below 0 or marked nodata aren't measurements.
NODATA_BELOW = -50.0


def apply(buildings: list[dict], frame: LocalFrame, raw_dir: Path, ground) -> dict:
    """Set lidar heights (and roof rises) in place. Returns counts."""
    stats = {"lidar": 0, "flat": 0, "kept": 0, "tiles": 0}
    if not buildings:
        return stats
    to_l93 = Transformer.from_crs(frame.crs, ign.CRS, always_xy=True)
    by_tile: dict[tuple[int, int], list[int]] = {}
    shapes = []
    for i, b in enumerate(buildings):
        ring = np.asarray(b["footprint"])
        x, y = to_l93.transform(ring[:, 0], ring[:, 1])
        poly = Polygon(np.column_stack([x, y])).buffer(0)
        shapes.append(poly)
        minx, miny, maxx, maxy = poly.bounds
        for tx in range(math.floor(minx / ign.MNH_TILE), math.floor(maxx / ign.MNH_TILE) + 1):
            for ty in range(math.floor(miny / ign.MNH_TILE), math.floor(maxy / ign.MNH_TILE) + 1):
                by_tile.setdefault((tx, ty), []).append(i)
    samples: dict[int, list[np.ndarray]] = {}
    for (tx, ty), members in sorted(by_tile.items()):
        try:
            path = ign.fetch_mnh_tile(tx * ign.MNH_TILE, ty * ign.MNH_TILE, MNH_CELL, raw_dir)
        except Exception as err:  # noqa: BLE001 - a missing tile only loses lidar heights there
            log.warning("MNH tile %d,%d unavailable (%s); estimates kept there", tx, ty, err)
            continue
        stats["tiles"] += 1
        with rasterio.open(path) as src:
            data = src.read(1)
            nodata = src.nodata
            inv = ~src.transform
        for i in members:
            inner = shapes[i].buffer(-EDGE)
            if inner.is_empty:
                continue
            minx, miny, maxx, maxy = inner.bounds
            gx, gy = np.meshgrid(
                np.arange(math.floor(minx) + 0.5, maxx, MNH_CELL),
                np.arange(math.floor(miny) + 0.5, maxy, MNH_CELL),
            )
            gx, gy = gx.ravel(), gy.ravel()
            keep = contains_xy(inner, gx, gy)
            gx, gy = gx[keep], gy[keep]
            col, row = inv @ (gx, gy)
            col, row = np.floor(col).astype(int), np.floor(row).astype(int)
            ok = (row >= 0) & (row < data.shape[0]) & (col >= 0) & (col < data.shape[1])
            v = data[row[ok], col[ok]]
            v = v[(v > NODATA_BELOW) & ((v != nodata) if nodata is not None else True)]
            if v.size:
                samples.setdefault(i, []).append(v)
    for i, b in enumerate(buildings):
        if b["heightSource"] == "osm-height" or i not in samples:
            continue
        v = np.concatenate(samples[i])
        if v.size < MIN_SAMPLES:
            stats["kept"] += 1
            continue
        eaves = float(np.percentile(v, EAVES_PCT))
        ridge = float(np.percentile(v, RIDGE_PCT))
        if ridge < MIN_HEIGHT:
            stats["kept"] += 1
            continue
        ring = np.asarray(b["footprint"])
        g = ground(ring[:, 0], ring[:, 1])
        rise = ridge - eaves
        roof = b.get("roof")
        if roof is not None and rise < FLAT_RISE and Polygon(ring).area > 150:
            b["roof"] = None
            roof = None
            stats["flat"] += 1
        if roof is None:
            height = ridge
        else:
            height = max(eaves, MIN_HEIGHT)
            roof["rise"] = round(float(np.clip(rise, 0.5, MAX_RISE)), 2)
        b["top"] = round(max(float(g.mean()) + height, float(g.max()) + 1.0), 2)
        b["heightSource"] = "lidar"
        stats["lidar"] += 1
    return stats
