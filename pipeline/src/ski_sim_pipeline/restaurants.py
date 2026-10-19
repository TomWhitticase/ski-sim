"""Mountain restaurants: OSM food and drink places out on the ski area.

Restaurants, bars, pubs, cafés, fast food and alpine huts all count as "restaurants".
Village places are left out: a place counts if it is near a piste and either clearly
above the nearest start village, or right beside the piste outside a built-up centre
(ski-in, e.g. a hut at the bottom of a run). Each one is attached to its OSM building
where there is one.

Restaurant buildings are restyled as mountain huts: the site is levelled into the slope
(as huts are built on a cut platform), with a low-pitch roof with deep eaves, a sun
terrace and a name board. The terrace is the OSM `leisure=outdoor_seating` area
where one is mapped; otherwise it is placed on the building's sunny, downhill side and
flagged `source: "synthetic"`. `outdoor_seating=no` means no terrace.
"""

from __future__ import annotations

import logging
import math

import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

from . import terminals as terminal_pads
from .config import Area
from .features import GroundSampler, _project, gable_roof
from .frame import LocalFrame
from .grid import Grid, sample_bilinear

log = logging.getLogger(__name__)

FOOD_AMENITIES = {"restaurant", "bar", "cafe", "pub", "fast_food", "biergarten"}

NEAR_PISTE = 150.0  # m: further than this from any piste isn't on the ski area
SKI_IN = 30.0  # m: this close to a piste counts even down in a village
ABOVE_VILLAGE = 60.0  # m above the nearest start village
VILLAGE_RADIUS = 100.0  # m: count buildings within this...
VILLAGE_BUILDINGS = 30  # ...this many or more is a village centre
BUILDING_MATCH = 12.0  # m: a POI node this close to a footprint belongs to it
DUPLICATE_NAME = 60.0  # m: same name this close together is one place

ROOF_PITCH = 22.0  # alpine huts: low roofs that hold the snow
EAVES = 1.3  # m of roof overhang
TERRACE_DEPTH = 7.0
TERRACE_MAX_WIDTH = 20.0
TERRACE_MIN_WIDTH = 5.0
TERRACE_MAX_DROP = 5.0  # m from deck down to the ground (a stone-walled terrace)
TERRACE_MAX_BURY = 1.2  # m the ground may rise above the deck
SIGN_MAX_WIDTH = 9.0
SITE_MARGIN = 3.0  # m of level ground round the hut before it blends into the slope
SITE_CLEARANCE = 5.0  # m: leave the slope alone if a lift tower is this close to the site


def is_food(tags: dict) -> bool:
    return tags.get("amenity") in FOOD_AMENITIES or tags.get("tourism") == "alpine_hut"


def _position(el: dict, frame: LocalFrame) -> tuple[float, float] | None:
    if el["type"] == "node":
        return frame.to_local(el["lon"], el["lat"])
    geometry = el.get("geometry") or []
    if len(geometry) < 3:
        return None
    ring = _project(frame, geometry)
    c = Polygon(ring).centroid if len(ring) >= 4 else Point(ring.mean(axis=0))
    return float(c.x), float(c.y)


def _ring(el: dict, frame: LocalFrame) -> Polygon | None:
    geometry = el.get("geometry") or []
    if el["type"] != "way" or len(geometry) < 4 or geometry[0] != geometry[-1]:
        return None
    polygon = Polygon(_project(frame, geometry[:-1]))
    return polygon if polygon.is_valid and polygon.area > 4 else None


# Hut heights where OSM has none: about two storeys under the roof, by footprint size.
HUT_HEIGHTS = ((250, 5.0), (600, 6.5), (1200, 8.0))
HUT_HEIGHT_MAX = 10.0


def on_mountain(piste_distance: float, height_above_village: float, neighbours: int) -> bool:
    """Out on the ski area rather than down in a village."""
    if piste_distance > NEAR_PISTE:
        return False
    if height_above_village >= ABOVE_VILLAGE:
        return True
    return piste_distance <= SKI_IN and neighbours < VILLAGE_BUILDINGS


def extract(
    elements: list[dict],
    frame: LocalFrame,
    extent: Area,
    heights: np.ndarray,
    grid: Grid,
    buildings: list[dict],
    lifts: list[dict],
    piste_records: list[dict],
    bases: list[dict],
) -> list[dict]:
    """Restaurant records; marks their buildings `use: "restaurant"` and restyles them.
    Levels each hut's site in `heights` (in place)."""

    def ground(east: np.ndarray, north: np.ndarray) -> np.ndarray:
        return sample_bilinear(heights, grid, east, north)

    lines = [LineString(line) for r in piste_records for line in r["lines"] if len(line) > 1]
    lines += [Polygon(a).exterior for r in piste_records for a in r.get("areas", []) if len(a) > 3]
    if not lines:
        return []
    piste_tree = STRtree(lines)
    footprints = [Polygon(b["footprint"]).buffer(0) for b in buildings]
    building_tree = STRtree(footprints)
    seating = [
        poly
        for el in elements
        if el.get("tags", {}).get("leisure") == "outdoor_seating"
        and (poly := _ring(el, frame)) is not None
    ]
    by_id = {b["id"]: i for i, b in enumerate(buildings)}

    found: list[dict] = []
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name or not is_food(tags):
            continue
        at = _position(el, frame)
        if at is None or not extent.contains(*at):
            continue
        point = Point(at)
        piste_distance = float(lines[int(piste_tree.nearest(point))].distance(point))
        g = float(ground(np.array([at[0]]), np.array([at[1]]))[0])
        village = min(
            bases,
            key=lambda b: math.hypot(b["east"] - at[0], b["north"] - at[1]),
            default=None,
        )
        above = g - village["ground"] if village else math.inf
        neighbours = len(building_tree.query(point.buffer(VILLAGE_RADIUS)))
        if not on_mountain(piste_distance, above, neighbours):
            continue

        building = None
        if el["type"] == "way" and el["id"] in by_id:
            building = by_id[el["id"]]
        else:
            hits = building_tree.query(point.buffer(BUILDING_MATCH))
            if len(hits):
                building = int(min(hits, key=lambda i: footprints[int(i)].distance(point)))
        found.append(
            {
                "id": el["id"],
                "name": name,
                "east": round(at[0], 2),
                "north": round(at[1], 2),
                "ground": round(g, 2),
                "_building": building,
                "_seating": tags.get("outdoor_seating"),
            }
        )

    # One record per place: the same name nearby, or two POIs in one building (a hotel
    # and its restaurant), are the same restaurant.
    kept: list[dict] = []
    for r in found:
        same = next(
            (
                k
                for k in kept
                if (r["_building"] is not None and k["_building"] == r["_building"])
                or (
                    k["name"] == r["name"]
                    and math.hypot(k["east"] - r["east"], k["north"] - r["north"]) < DUPLICATE_NAME
                )
            ),
            None,
        )
        if same is None:
            kept.append(r)

    out = []
    for r in kept:
        b_index = r.pop("_building")
        seating_tag = r.pop("_seating")
        r["building"] = None
        r["terrace"] = None
        r["sign"] = None
        if b_index is not None:
            b = buildings[b_index]
            polygon = footprints[b_index]
            b["use"] = "restaurant"
            r["building"] = b["id"]
            level_site(b, polygon, heights, grid, lifts, buildings, footprints, building_tree)
            restyle(b, polygon, ground)
            others = [footprints[int(i)] for i in building_tree.query(polygon.buffer(15))]
            others = [p for p in others if p is not polygon]
            if seating_tag != "no":
                r["terrace"] = terrace(polygon, ground, lines, others, seating)
            r["sign"] = sign(r["name"], b, polygon, r["terrace"], piste_tree, lines)
        out.append(r)
    out.sort(key=lambda r: r["name"])
    mapped = sum(1 for r in out if r["terrace"] and r["terrace"]["source"] == "osm")
    log.info(
        "%d mountain restaurants (%d with buildings, %d terraces: %d mapped, %d synthetic)",
        len(out),
        sum(1 for r in out if r["building"] is not None),
        sum(1 for r in out if r["terrace"]),
        mapped,
        sum(1 for r in out if r["terrace"]) - mapped,
    )
    return out


def _interior_ground(polygon: Polygon, ground: GroundSampler) -> np.ndarray:
    x0, y0, x1, y1 = polygon.bounds
    xs, ys = np.meshgrid(np.arange(x0, x1, 2.0), np.arange(y0, y1, 2.0))
    inside = [
        (x, y) for x, y in zip(xs.ravel(), ys.ravel(), strict=True) if polygon.contains(Point(x, y))
    ]
    if not inside:
        c = polygon.centroid
        inside = [(c.x, c.y)]
    pts = np.asarray(inside)
    return ground(pts[:, 0], pts[:, 1])


def level_site(
    b: dict,
    polygon: Polygon,
    heights: np.ndarray,
    grid: Grid,
    lifts: list[dict],
    buildings: list[dict],
    footprints: list[Polygon],
    building_tree: STRtree,
) -> None:
    """Cut a level platform for the hut (at the median ground under it, plus a margin),
    blended back into the slope, then re-seat the hut and any neighbours on the new ground.
    Lift station pads are left as they are; next to a lift tower (placed on the old
    ground) the slope isn't touched at all."""
    if b.get("raised"):
        return

    def ground(east: np.ndarray, north: np.ndarray) -> np.ndarray:
        return sample_bilinear(heights, grid, east, north)

    corners = np.asarray(polygon.minimum_rotated_rectangle.exterior.coords)[:4]
    centre = corners.mean(axis=0)
    e1, e2 = corners[1] - corners[0], corners[2] - corners[1]
    half_u, half_v = float(np.hypot(*e1)) / 2, float(np.hypot(*e2)) / 2
    d = e1 / max(2 * half_u, 1e-6)
    a = e2 / max(2 * half_v, 1e-6)
    reach = max(half_u, half_v) + SITE_MARGIN + terminal_pads.FALLOFF
    towers = [
        (s["east"], s["north"])
        for lift in lifts
        for s in lift["supports"]
        if s["kind"] != "station"
    ]
    if any(math.hypot(e - centre[0], n - centre[1]) < reach + SITE_CLEARANCE for e, n in towers):
        return
    pads = [t for lift in lifts for t in lift.get("terminals", [])]

    level = float(np.median(_interior_ground(polygon, ground)))
    neighbours = [int(i) for i in building_tree.query(Point(centre).buffer(reach + 2))]
    before = {}
    for i in neighbours:
        ring = np.asarray(buildings[i]["footprint"])
        before[i] = ground(ring[:, 0], ring[:, 1])
    terminal_pads._rect_stamp(
        heights,
        grid,
        centre,
        d,
        a,
        (-half_u - SITE_MARGIN, half_u + SITE_MARGIN),
        (-half_v - SITE_MARGIN, half_v + SITE_MARGIN),
        lambda u, v: level + 0 * u,
        protect=(lambda e, n: terminal_pads._on_pads(pads, e, n)) if pads else None,
    )
    for i in neighbours:
        n = buildings[i]
        if n.get("raised"):
            continue
        ring = np.asarray(n["footprint"])
        after = ground(ring[:, 0], ring[:, 1])
        n["top"] = round(n["top"] + float(after.mean() - before[i].mean()), 2)
        n["base"] = round(float(after.min()) - 1.0, 2)


def restyle(b: dict, polygon: Polygon, ground: GroundSampler) -> None:
    """Hut proportions: an estimated height that suits a hut rather than an apartment
    block, measured from the uphill side (on a slope the downhill side shows a stone
    basement, `footing` m high above the base), and a low-pitch roof with deep eaves
    (unless the roof is flat)."""
    if b.get("raised"):
        return
    ring = np.asarray(b["footprint"])
    uphill = float(ground(ring[:, 0], ring[:, 1]).max())
    if b["heightSource"] == "estimate":
        height = next((h for limit, h in HUT_HEIGHTS if polygon.area < limit), HUT_HEIGHT_MAX)
        b["top"] = round(uphill + height, 2)
    b["footing"] = round(max(0.0, min(uphill - b["base"], b["top"] - b["base"] - 3.0)), 2)
    if b.get("roof") is None:
        return
    roof = gable_roof(polygon, "restaurant", None, pitch=ROOF_PITCH, eaves=EAVES)
    if roof is not None:
        b["roof"] = roof


def _sides(polygon: Polygon) -> list[tuple[np.ndarray, np.ndarray, float]]:
    """The four sides of the footprint's oriented bounding box: (midpoint, outward
    normal, length)."""
    corners = np.asarray(polygon.minimum_rotated_rectangle.exterior.coords)[:4]
    centre = corners.mean(axis=0)
    out = []
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        mid = (a + b) / 2
        length = float(np.hypot(*(b - a)))
        normal = mid - centre
        normal = normal / max(float(np.hypot(*normal)), 1e-6)
        out.append((mid, normal, length))
    return out


def _deck_level(ground: GroundSampler, mid: np.ndarray) -> float:
    """Deck surface: level with the ground at the wall (the hut's door)."""
    return float(ground(np.array([mid[0]]), np.array([mid[1]]))[0]) + 0.3


def terrace(
    polygon: Polygon,
    ground: GroundSampler,
    pistes: list,
    others: list[Polygon],
    seating: list[Polygon],
) -> dict | None:
    """The sun terrace: the mapped outdoor seating if there is any, else a deck on the
    best side (facing downhill and south, clear of pistes and other buildings)."""
    near = polygon.buffer(15)
    for area in seating:
        if area.intersects(near) and area.area < 1500:
            ring = np.asarray(area.exterior.coords)[:-1]
            level = float(ground(ring[:, 0], ring[:, 1]).max()) + 0.15
            return {"ring": np.round(ring, 2).tolist(), "top": round(level, 2), "source": "osm"}

    centre = np.asarray(polygon.centroid.coords[0])
    h = ground(
        np.array([centre[0] - 10, centre[0] + 10, centre[0], centre[0]]),
        np.array([centre[1], centre[1], centre[1] - 10, centre[1] + 10]),
    )
    downhill = np.array([h[0] - h[1], h[2] - h[3]])
    downhill = downhill / max(float(np.hypot(*downhill)), 1e-6)

    best = None
    for mid, normal, _length, width in (
        (mid, normal, length, w * min(length - 1.0, TERRACE_MAX_WIDTH))
        for mid, normal, length in _sides(polygon)
        for w in (1.0, 0.7, 0.5)
    ):
        if width < TERRACE_MIN_WIDTH:
            continue
        along = np.array([-normal[1], normal[0]])
        # Start the deck at the wall (the footprint may sit inside its bounding box).
        inner = mid - normal * 0.5
        outer = mid + normal * TERRACE_DEPTH
        ring = np.array(
            [
                inner - along * width / 2,
                inner + along * width / 2,
                outer + along * width / 2,
                outer - along * width / 2,
            ]
        )
        deck = Polygon(ring)
        if any(deck.difference(polygon).intersects(p) for p in pistes):
            continue
        if any(deck.intersection(o).area > 1.0 for o in others):
            continue
        level = _deck_level(ground, mid)
        g = ground(ring[:, 0], ring[:, 1])
        if level - float(g.min()) > TERRACE_MAX_DROP or float(g.max()) - level > TERRACE_MAX_BURY:
            continue
        # Sunny and downhill first; then the bigger deck.
        score = float(normal @ downhill) + 0.6 * float(normal @ np.array([0.0, -1.0]))
        score += 0.02 * width
        if best is None or score > best[0]:
            best = (score, ring, level)
    if best is None:
        return None
    return {"ring": np.round(best[1], 2).tolist(), "top": round(best[2], 2), "source": "synthetic"}


def sign(
    name: str,
    b: dict,
    polygon: Polygon,
    deck: dict | None,
    piste_tree: STRtree,
    pistes: list,
) -> dict | None:
    """A name board under the eaves: over the terrace, or on the wall facing the piste."""
    if deck is not None:
        target = np.asarray(deck["ring"]).mean(axis=0)
    else:
        middle = polygon.centroid
        nearest = pistes[int(piste_tree.nearest(middle))]
        target = np.asarray(nearest.interpolate(nearest.project(middle)).coords[0])
    to_target = target - np.asarray(polygon.centroid.coords[0])
    to_target = to_target / max(float(np.hypot(*to_target)), 1e-6)
    # The longest stretch of real wall that faces the guests (a bounding-box side can
    # cut across an L-shaped footprint and put the board inside the building).
    ring = np.asarray(polygon.exterior.coords)
    ccw = polygon.exterior.is_ccw
    best = None
    for a, c in zip(ring[:-1], ring[1:], strict=True):
        edge = c - a
        length = float(np.hypot(*edge))
        if length < 2.5:
            continue
        direction = edge / length
        normal = (
            np.array([direction[1], -direction[0]])
            if ccw
            else -np.array([direction[1], -direction[0]])
        )
        facing = float(normal @ to_target)
        if facing <= 0.3:
            continue
        score = facing * min(length, 12.0)
        if best is None or score > best[0]:
            best = (score, (a + c) / 2, normal, length)
    if best is None:
        return None
    _, face, normal, length = best
    width = min(length * 0.8, SIGN_MAX_WIDTH, 0.5 * len(name) + 2.0)
    height = b["top"] - 0.9  # board centre, just under the eaves
    if height - b["base"] < 2.5:
        return None
    heading = math.degrees(math.atan2(normal[0], normal[1])) % 360
    return {
        "east": round(float(face[0] + normal[0] * 0.12), 2),
        "north": round(float(face[1] + normal[1] * 0.12), 2),
        "height": round(height, 2),
        "heading": round(heading, 1),
        "width": round(float(width), 2),
    }
