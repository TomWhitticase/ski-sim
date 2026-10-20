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
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import split

from .config import Area, Extent
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
# Shorter ways are mapped station pieces (e.g. a turn at an angle station), not lifts.
MIN_LIFT_LENGTH = 40.0
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
    area: Area | None = None,
) -> list[dict]:
    """Lifts inside the terrain `extent`; with an `area` (the resort's own bounds), only
    those with a station in it, so a neighbouring resort's lifts at the edge are left out."""
    lifts = []
    for el in elements:
        tags = el.get("tags", {})
        kind = tags.get("aerialway")
        profile = LIFT_PROFILES.get(kind or "")
        if el["type"] != "way" or profile is None or len(el.get("geometry", [])) < 2:
            continue
        # A closed ring is a station outline mistagged as the lift, not a cable line.
        if el["geometry"][0] == el["geometry"][-1]:
            log.info("Skipping lift %s (%s): closed way", tags.get("name"), el["id"])
            continue
        points = _project(frame, el["geometry"])
        if not _inside(extent, points):
            log.info("Skipping lift %s (%s): outside terrain extent", tags.get("name"), el["id"])
            continue
        if area is not None and not any(area.contains(e, n) for e, n in points[[0, -1]]):
            log.info("Skipping lift %s (%s): outside the resort", tags.get("name"), el["id"])
            continue
        length = float(np.sum(np.hypot(*np.diff(points, axis=0).T)))
        if length < MIN_LIFT_LENGTH:
            log.info("Skipping lift %s (%s): %.0f m long", tags.get("name"), el["id"], length)
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

        lifts.append(
            {
                "id": el["id"],
                "name": display_name(tags),
                "type": kind,
                "gauge": profile.gauge,
                "length": round(length, 1),
                "vertical": round(supports[-1]["ground"] - supports[0]["ground"], 1),
                "supports": [_round(s) for s in supports],
                **lift_specs(tags),
            }
        )
    return lifts


def parse_duration(value: str | None) -> float | None:
    """OSM aerialway:duration in seconds. Bare numbers are minutes; "mm:ss" or
    "hh:mm:ss" are clock style."""
    if not value:
        return None
    value = value.strip()
    try:
        if ":" in value:
            parts = [float(p) for p in value.split(":")]
            seconds = 0.0
            for part in parts:
                seconds = seconds * 60 + part
            return seconds
        return float(value.replace(",", ".")) * 60
    except ValueError:
        return None


def lift_specs(tags: dict) -> dict:
    """Published operating specs from OSM, where tagged (None otherwise)."""

    def number(key: str) -> float | None:
        try:
            return float(tags[key].replace(",", "."))
        except (KeyError, ValueError):
            return None

    occupancy = number("aerialway:occupancy")
    return {
        "occupancy": int(occupancy) if occupancy else None,
        "capacity": number("aerialway:capacity"),
        "duration": parse_duration(tags.get("aerialway:duration")),
        "bubble": tags.get("aerialway:bubble") == "yes",
    }


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
        kind = "lift_station" if is_station else tags.get("building")
        buildings.append(
            {
                "id": el["id"],
                "type": kind,
                "footprint": np.round(ring, 2).tolist(),
                "base": round(float(g.min()) - 1.0, 2),
                "top": round(top, 2),
                "heightSource": source,
                "roof": gable_roof(polygon, kind, tags.get("roof:shape")),
            }
        )
    return dedupe_buildings(buildings), station_footprints


DUPLICATE_OVERLAP = 0.5


def dedupe_buildings(buildings: list[dict]) -> list[dict]:
    """Drop footprints mapped twice in OSM (e.g. a station area and a building with the
    same outline). Coincident walls and roofs would z-fight. Of each duplicate pair the
    larger footprint is kept, taking the taller top and the lift-station type if either
    had it."""
    from shapely import make_valid
    from shapely.strtree import STRtree

    # Rounded footprints can self-touch; repair them so the overlap test can't throw.
    polygons = [make_valid(Polygon(b["footprint"])) for b in buildings]
    order = sorted(range(len(buildings)), key=lambda i: -polygons[i].area)
    tree = STRtree(polygons)
    dropped: set[int] = set()
    for i in order:
        if i in dropped:
            continue
        for j in tree.query(polygons[i]):
            j = int(j)
            if j == i or j in dropped:
                continue
            small = min(polygons[i].area, polygons[j].area)
            if polygons[i].intersection(polygons[j]).area > DUPLICATE_OVERLAP * small:
                keep, other = buildings[i], buildings[j]
                keep["top"] = max(keep["top"], other["top"])
                keep["base"] = min(keep["base"], other["base"])
                if other["type"] == "lift_station":
                    keep["type"] = "lift_station"
                dropped.add(j)
    if dropped:
        log.info("Merged %d duplicate building footprints", len(dropped))
    return [b for k, b in enumerate(buildings) if k not in dropped]


FLAT_ROOF_TYPES = {"industrial", "warehouse", "garage", "garages", "service", "commercial"}
ROOF_PITCH = {"church": 40.0, "chapel": 40.0, "lift_station": 14.0}
DEFAULT_PITCH = 24.0
MAX_RIDGE_RISE = 7.0


def gable_roof(
    polygon: Polygon,
    kind: str | None,
    shape: str | None,
    pitch: float | None = None,
    eaves: float = 0.0,
) -> dict | None:
    """A gable roof over the footprint: ridge along the long axis of its oriented
    bounding box, one planar face each side. Returns None for flat roofs.

    The footprint is split along the ridge so each piece is a single plane, which keeps
    irregular (e.g. L-shaped) footprints watertight. Height above the wall tops at a point
    is rise * (1 - |distance to ridge| / halfWidth). With `eaves`, the faces are the
    footprint grown by that much, so the roof overhangs the walls (and dips below their
    tops beyond them, continuing the same planes).
    """
    if shape == "flat" or (kind in FLAT_ROOF_TYPES and polygon.area > 600):
        return None
    if polygon.area > 5000:
        return None
    corners = np.asarray(polygon.minimum_rotated_rectangle.exterior.coords)[:4]
    e1 = corners[1] - corners[0]
    e2 = corners[2] - corners[1]
    long_axis, short_axis = (e1, e2) if np.hypot(*e1) >= np.hypot(*e2) else (e2, e1)
    half_width = float(np.hypot(*short_axis)) / 2
    if half_width < 1.5 or half_width > 25:
        return None
    centre = corners.mean(axis=0)
    direction = long_axis / np.hypot(*long_axis)
    reach = float(np.hypot(*long_axis)) + 10
    a = centre - direction * reach
    b = centre + direction * reach
    if pitch is None:
        pitch = ROOF_PITCH.get(kind or "", DEFAULT_PITCH)
    rise = min(half_width * math.tan(math.radians(pitch)), MAX_RIDGE_RISE)

    cover = polygon.buffer(eaves, join_style="mitre") if eaves > 0 else polygon
    pieces = [g for g in split(cover, LineString([a, b])).geoms if g.area > 0.05]
    halves = [np.round(np.asarray(g.exterior.coords)[:-1], 2).tolist() for g in pieces]
    roof = {
        "ridge": [np.round(a, 2).tolist(), np.round(b, 2).tolist()],
        "halfWidth": round(half_width, 2),
        "rise": round(rise, 2),
        "faces": halves,
    }
    if eaves > 0:
        roof["eaves"] = eaves
    return roof


def _round(support: dict) -> dict:
    return {k: round(v, 2) if isinstance(v, float) else v for k, v in support.items()}


# --- Peaks -------------------------------------------------------------------------------

PEAK_SNAP_RADIUS = 30.0  # OSM summit nodes are often a few metres off the true top
FAR_PEAK_MIN_ELE = 3500.0  # outside the near extent, only label major summits


_NON_LATIN = re.compile(r"[^\W\d_A-Za-z\u00C0-\u024F\u1E00-\u1EFF]")


def display_name(tags: dict) -> str | None:
    """The name to show: OSM `name`, or `name:en` when `name` isn't in Latin script
    (Everest's `name` is Chinese, Tibetan and Nepali in one string)."""
    name = tags.get("name")
    if name and _NON_LATIN.search(name) and tags.get("name:en"):
        return tags["name:en"]
    return name


def extract_peaks(
    elements: list[dict],
    frame: LocalFrame,
    near: np.ndarray,
    near_grid,
    far: np.ndarray,
    far_grid,
) -> list[dict]:
    """Named peaks, snapped to the DEM summit. Near-extent peaks are all kept; beyond it only
    those of at least FAR_PEAK_MIN_ELE, so the horizon shows the big names."""
    peaks = []
    for el in elements:
        tags = el.get("tags", {})
        name = display_name(tags)
        if el["type"] != "node" or not name:
            continue
        ele = _parse_metres(tags.get("ele"))
        east, north = frame.to_local(el["lon"], el["lat"])
        if near_grid.extent.contains(east, north):
            east, north, ground = _snap_to_summit(near, near_grid, east, north)
        elif far_grid.extent.contains(east, north) and ele is not None and ele >= FAR_PEAK_MIN_ELE:
            east, north, ground = _snap_to_summit(far, far_grid, east, north)
        else:
            continue
        peaks.append(
            {
                "id": el["id"],
                "name": name,
                "ele": ele,
                "east": round(east, 2),
                "north": round(north, 2),
                "ground": round(ground, 2),
            }
        )
    return peaks


def _snap_to_summit(heights: np.ndarray, grid, east: float, north: float):
    """Highest grid sample within PEAK_SNAP_RADIUS of a point."""
    r = max(1, int(np.ceil(PEAK_SNAP_RADIUS / grid.cell_size)))
    col = round((east - grid.extent.west) / grid.cell_size)
    row = round((grid.extent.north - north) / grid.cell_size)
    r0, c0 = max(row - r, 0), max(col - r, 0)
    window = heights[r0 : row + r + 1, c0 : col + r + 1]
    i, j = np.unravel_index(int(np.argmax(window)), window.shape)
    return (
        grid.extent.west + (c0 + j) * grid.cell_size,
        grid.extent.north - (r0 + i) * grid.cell_size,
        float(window[i, j]),
    )
