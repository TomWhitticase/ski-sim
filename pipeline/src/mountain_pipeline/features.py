"""Lifts and buildings from OSM, placed on the terrain in the local frame.

Lift geometry: OSM gives the lift line with stations at the ends and (usually) towers as
intermediate nodes. Where the straight cable between supports would come too close to
the ground, or a span is implausibly long, we insert synthetic towers and flag them as
such so they can be told apart from surveyed ones.

Building heights: OSM rarely tags them here, so most come from a footprint-size estimate
(flagged via `heightSource`).
"""

from __future__ import annotations

import logging
import math
import re
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from shapely.geometry import Point, Polygon

from .config import Extent
from .frame import LocalFrame

log = logging.getLogger(__name__)

# (east, north) arrays -> ground height arrays
GroundSampler = Callable[[np.ndarray, np.ndarray], np.ndarray]


@dataclass(frozen=True)
class LiftProfile:
    tower_height: float  # cable height above ground at a tower
    station_height: float  # cable height above ground at a station
    min_clearance: float  # minimum cable height above ground anywhere
    max_span: float  # longest plausible distance between supports
    gauge: float  # distance between the up and down cables


_DRAG = LiftProfile(6, 4, 2.5, 120, 2.5)
LIFT_PROFILES = {
    "cable_car": LiftProfile(25, 8, 15, 3000, 8),
    "gondola": LiftProfile(14, 6, 6, 400, 6),
    "mixed_lift": LiftProfile(13, 6, 6, 350, 6),
    "chair_lift": LiftProfile(11, 5, 5, 300, 5),
    "drag_lift": _DRAG,
    "t-bar": _DRAG,
    "j-bar": _DRAG,
    "platter": _DRAG,
    "rope_tow": LiftProfile(1.5, 1.5, 0.5, 60, 1),
}

SKIPPED_BUILDING_TYPES = {"ruins", "roof", "construction"}
BUILDING_TYPE_HEIGHTS = {"church": 14.0, "chapel": 7.0, "garage": 3.0, "service": 4.0}
STATION_BUILDING_HEIGHT = 8.0
STATION_MATCH_DISTANCE = 15.0
CABLE_SAMPLE_STEP = 4.0


def _project(frame: LocalFrame, geometry: list[dict]) -> np.ndarray:
    lons = np.array([p["lon"] for p in geometry])
    lats = np.array([p["lat"] for p in geometry])
    return np.column_stack(frame.to_local(lons, lats))


def _inside(extent: Extent, points: np.ndarray) -> bool:
    e, n = points[:, 0], points[:, 1]
    return bool(
        (e >= extent.west).all()
        and (e <= extent.east).all()
        and (n >= extent.south).all()
        and (n <= extent.north).all()
    )


# --- Lifts -------------------------------------------------------------------------------


def _support(east: float, north: float, ground: float, height: float, kind: str) -> dict:
    return {"east": east, "north": north, "ground": ground, "top": ground + height, "kind": kind}


def _fill_span(a: dict, b: dict, ground: GroundSampler, profile: LiftProfile, depth: int = 0):
    """Synthetic towers needed between supports a and b (recursively)."""
    span = math.hypot(b["east"] - a["east"], b["north"] - a["north"])
    if depth > 12 or span < 2 * CABLE_SAMPLE_STEP:
        return []
    t = np.linspace(0, 1, max(int(span / CABLE_SAMPLE_STEP), 2) + 1)[1:-1]
    east = a["east"] + (b["east"] - a["east"]) * t
    north = a["north"] + (b["north"] - a["north"]) * t
    cable = a["top"] + (b["top"] - a["top"]) * t
    clearance = cable - ground(east, north)

    worst = int(np.argmin(clearance))
    if clearance[worst] >= profile.min_clearance:
        if span <= profile.max_span:
            return []
        worst = len(t) // 2  # too long a span: split in the middle
    e, n = float(east[worst]), float(north[worst])
    g = float(ground(np.array([e]), np.array([n]))[0])
    tower = _support(e, n, g, profile.tower_height, "synthetic-tower")
    return (
        _fill_span(a, tower, ground, profile, depth + 1)
        + [tower]
        + _fill_span(tower, b, ground, profile, depth + 1)
    )


def place_supports(points: np.ndarray, ground: GroundSampler, profile: LiftProfile) -> list[dict]:
    """Stations at the ends, OSM nodes as towers, plus synthetic towers for clearance."""
    heights = ground(points[:, 0], points[:, 1])
    last = len(points) - 1
    surveyed = [
        _support(
            float(e),
            float(n),
            float(g),
            profile.station_height if i in (0, last) else profile.tower_height,
            "station" if i in (0, last) else "tower",
        )
        for i, ((e, n), g) in enumerate(zip(points, heights, strict=True))
    ]
    supports = [surveyed[0]]
    for a, b in zip(surveyed, surveyed[1:], strict=False):
        supports += _fill_span(a, b, ground, profile)
        supports.append(b)
    return supports


def extract_lifts(
    elements: list[dict],
    frame: LocalFrame,
    extent: Extent,
    ground: GroundSampler,
    station_footprints: list[Polygon],
) -> list[dict]:
    lifts = []
    for el in elements:
        tags = el.get("tags", {})
        kind = tags.get("aerialway")
        profile = LIFT_PROFILES.get(kind or "")
        if el["type"] != "way" or profile is None or len(el.get("geometry", [])) < 2:
            continue
        points = _project(frame, el["geometry"])
        if not _inside(extent, points):
            log.info("Skipping lift %s (%s): outside terrain extent", tags.get("name"), el["id"])
            continue
        # Orient bottom -> top so the first support is always the lower station.
        ends = ground(points[[0, -1], 0], points[[0, -1], 1])
        if ends[0] > ends[1]:
            points = points[::-1]

        supports = place_supports(points, ground, profile)
        for s in (supports[0], supports[-1]):
            p = Point(s["east"], s["north"])
            s["stationBuilding"] = any(
                fp.distance(p) <= STATION_MATCH_DISTANCE for fp in station_footprints
            )

        length = float(np.sum(np.hypot(*np.diff(points, axis=0).T)))
        lifts.append(
            {
                "id": el["id"],
                "name": tags.get("name"),
                "type": kind,
                "gauge": profile.gauge,
                "length": round(length, 1),
                "vertical": round(supports[-1]["ground"] - supports[0]["ground"], 1),
                "supports": [_round(s) for s in supports],
            }
        )
    return lifts


# --- Buildings ---------------------------------------------------------------------------


def _parse_metres(value: str | None) -> float | None:
    if not value:
        return None
    match = re.match(r"^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m)?\s*$", value)
    return float(match.group(1).replace(",", ".")) if match else None


def estimate_height(tags: dict, area: float) -> tuple[float, str]:
    """Building height in metres and where it came from."""
    if (h := _parse_metres(tags.get("height"))) is not None:
        return h, "osm-height"
    if (levels := _parse_metres(tags.get("building:levels"))) is not None:
        return levels * 3.0 + 1.5, "osm-levels"
    if "aerialway" in tags and "building" not in tags:
        return STATION_BUILDING_HEIGHT, "estimate"
    if (h := BUILDING_TYPE_HEIGHTS.get(tags.get("building", ""))) is not None:
        return h, "estimate"
    for limit, height in ((25, 3.5), (100, 6.0), (400, 10.0), (1500, 15.0)):
        if area < limit:
            return height, "estimate"
    return 20.0, "estimate"


def extract_buildings(
    elements: list[dict], frame: LocalFrame, extent: Extent, ground: GroundSampler
) -> tuple[list[dict], list[Polygon]]:
    """Returns building records and the footprints of lift stations."""
    buildings = []
    station_footprints = []
    for el in elements:
        tags = el.get("tags", {})
        is_station = tags.get("aerialway") == "station"
        if el["type"] != "way" or not ("building" in tags or is_station):
            continue
        if tags.get("building") in SKIPPED_BUILDING_TYPES:
            continue
        geometry = el.get("geometry", [])
        if len(geometry) < 4 or geometry[0] != geometry[-1]:
            continue  # not a closed footprint
        ring = _project(frame, geometry[:-1])
        if not _inside(extent, ring):
            continue
        polygon = Polygon(ring)
        if not polygon.is_valid or polygon.area < 4:
            continue
        if is_station:
            station_footprints.append(polygon)

        height, source = estimate_height(tags, polygon.area)
        g = ground(ring[:, 0], ring[:, 1])
        top = max(float(g.mean()) + height, float(g.max()) + 2.0)
        buildings.append(
            {
                "id": el["id"],
                "type": "lift_station" if is_station else tags.get("building"),
                "footprint": np.round(ring, 2).tolist(),
                "base": round(float(g.min()) - 1.0, 2),
                "top": round(top, 2),
                "heightSource": source,
            }
        )
    return buildings, station_footprints


def _round(support: dict) -> dict:
    return {k: round(v, 2) if isinstance(v, float) else v for k, v in support.items()}
