"""Roads from OSM (`highway=*`): through roads, streets, service roads and tracks, in
their winter state.

Footways, paths, steps, cycleways and bridleways aren't fetched (`osm.ROAD_CLASSES`): in
winter they're under the snow, and the ones a resort keeps open are mapped as pistes
(walking routes, `piste:type=hike`).

- **Width** from `width`, else `lanes` × LANE_WIDTH plus margins, else a default for the
  class (`widthSource: "estimate"`).
- **Winter state:** `cleared` (ploughed asphalt) or `snow` (a snow-covered track). Many
  alpine roads are closed in winter: `winter_road=no`, `winter_service=no`,
  `snowplowing=no`, a `seasonal` tag without winter, or a `*:conditional` closing it in
  February or under snow make it snow; tracks and unpaved roads are snow; through roads
  and streets are cleared; service roads are cleared only in a settlement (SETTLED_MIN
  buildings within SETTLED_RADIUS), elsewhere they're ski-area pistes and access tracks.
- **Built into the terrain** like a runway (`airfields.strip_profile`): level across,
  the ground's longitudinal profile kept, banks back to the natural slope. Not where a
  piste is: the piste's grading stays and its snow is the road in winter (`keep_off`).
  Bridges and tunnels aren't graded (the ground under a bridge keeps its shape).
- **Piste wins:** the sim cuts a road's surface where the piste overlay covers it;
  snowbanks and snow poles keep PISTE_MARGIN off every run.
- **Mountain roads** (cleared, outside settlements) get ploughed snowbanks (with gaps)
  and snow poles along both edges; cleared streets in a settlement get banks where no
  building fronts them.

Roads aren't pistes: they're not in the piste overlay or lookup. They get their own
coverage raster (`raster`), on the piste overlay's grid, for the terrain shader: packed
snow on snow roads, and asphalt on cleared ones beyond the distance the sim draws them.
"""

from __future__ import annotations

import logging
import math
import re

import numpy as np
from PIL import Image
from rasterio import features as rio_features
from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import substring, unary_union

from .airfields import _cells, strip_profile
from .features import _project, display_name
from .frame import LocalFrame
from .grading import TAN_CUT, TAN_FILL
from .grid import Grid, sample_bilinear

log = logging.getLogger(__name__)

#: Per class: map rank (0 most important) and default width (m) where none is tagged.
CLASSES = {
    "motorway": (0, 11.0),
    "trunk": (0, 9.0),
    "primary": (1, 7.5),
    "secondary": (2, 7.0),
    "tertiary": (3, 6.0),
    "motorway_link": (0, 5.5),
    "trunk_link": (0, 5.5),
    "primary_link": (1, 5.5),
    "secondary_link": (2, 5.0),
    "tertiary_link": (3, 5.0),
    "unclassified": (4, 5.0),
    "residential": (4, 5.0),
    "living_street": (4, 4.5),
    "service": (5, 3.5),
    "track": (6, 3.0),
}
#: Through roads and streets: ploughed unless tagged otherwise.
PUBLIC = {c for c, (rank, _) in CLASSES.items() if rank <= 4}
LANE_WIDTH = 3.0
LANE_MARGIN = 1.0  # m added to lanes × LANE_WIDTH (edge strips)
MIN_WIDTH = 2.5
MAX_WIDTH = 30.0
UNPAVED = {
    "unpaved",
    "compacted",
    "gravel",
    "fine_gravel",
    "dirt",
    "earth",
    "ground",
    "grass",
    "grass_paver",
    "mud",
    "sand",
    "pebblestone",
    "rock",
    "stone",
    "wood",
    "woodchips",
    "snow",
    "ice",
}
#: A place is a settlement with this many buildings this close (m).
SETTLED_RADIUS = 80.0
SETTLED_MIN = 6
SETTLED_STEP = 40.0  # m between the points tested along a road
#: The sim day (15 February) for `*:conditional` month ranges.
SIM_MONTH = 2
MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")

# Grading.
SHOULDER = 1.0  # level ground either side of the carriageway (m)
ROAD_BANK_REACH = 15.0
PISTE_MARGIN = 3.0  # snowbanks, poles and grading keep this far off a piste (m)
FEATHER = 2  # grid cells over which grading fades in beside a piste
# Snowbanks along cleared roads: this far outside the edge (their middle), in runs with
# gaps (to get a snowmobile through), off junctions, pistes and building frontages.
BANK_OFFSET = 1.3
BANK_RUN = 40.0
BANK_GAP = 5.0
BANK_MIN = 4.0
BANK_SIMPLIFY = 0.3  # m
FRONTAGE = 6.0  # a bank stops this close to a building (m)
# Snow poles (the tall red markers ploughs steer by) along mountain roads: one side,
# then the other, POLE_SPACING apart on each.
POLE_SPACING = 50.0
POLE_OFFSET = 2.8  # outside the edge, beyond the bank
#: Trees are cleared from the road and this much either side (m).
CLEARING = 2.0


def _number(value: str | None) -> float | None:
    if not value:
        return None
    match = re.match(r"^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m|metres?|meters?)?\s*$", value)
    return float(match.group(1).replace(",", ".")) if match else None


def width_of(tags: dict, cls: str) -> tuple[float, str]:
    """The road's width (m) and where it came from: `osm` (`width`), `lanes`, or an
    `estimate` for the class."""
    w = _number(tags.get("width") or tags.get("est_width"))
    if w is not None and MIN_WIDTH <= w <= MAX_WIDTH:
        return w, "osm"
    lanes = _number(tags.get("lanes"))
    if lanes is not None and 1 <= lanes <= 8:
        return min(lanes * LANE_WIDTH + LANE_MARGIN, MAX_WIDTH), "lanes"
    return CLASSES[cls][1], "estimate"


def structure(tags: dict) -> str | None:
    """`bridge`, `tunnel` (including building passages and avalanche galleries, which
    the terrain covers) or None. A bare `layer` isn't one: roads use it to order
    junctions and embankments."""
    if tags.get("tunnel", "no") != "no" or tags.get("covered") == "yes":
        return "tunnel"
    if tags.get("bridge", "no") != "no":
        return "bridge"
    return None


def _month_in(month: int, a: int, b: int) -> bool:
    return a <= month <= b if a <= b else month >= a or month <= b


def closed_by_condition(value: str, month: int = SIM_MONTH) -> bool:
    """Whether an OSM `*:conditional` value ("no @ (Nov 15-May 1)", "no @ snow",
    "no @ winter", "no@(Dec-Mar)") closes the road on the sim's day."""
    for part in value.split(";"):
        if "@" not in part:
            continue
        what, when = (s.strip().lower() for s in part.split("@", 1))
        if what not in ("no", "private", "forestry", "agricultural"):
            continue
        when = when.strip("() ")
        if "snow" in when or "winter" in when or "ice" in when:
            return True
        found = re.findall(r"(" + "|".join(MONTHS) + r")[a-z]*", when)
        if len(found) >= 2 and "-" in when:
            a, b = MONTHS.index(found[0]) + 1, MONTHS.index(found[1]) + 1
            if _month_in(month, a, b):
                return True
        elif len(found) == 1 and MONTHS.index(found[0]) + 1 == month:
            return True
    return False


def closed_in_winter(tags: dict) -> bool | None:
    """True if tags say it isn't ploughed in winter, False if they say it is, None if
    they don't say."""
    for key in ("winter_road", "winter_service", "snowplowing"):
        if tags.get(key) == "no":
            return True
        if tags.get(key) == "yes":
            return False
    seasonal = tags.get("seasonal")
    if seasonal == "yes" or (
        seasonal and seasonal != "no" and "winter" not in seasonal.lower().split(";")
    ):
        return True
    for key in ("motor_vehicle", "access", "vehicle", "motorcar"):
        value = tags.get(f"{key}:conditional")
        if value and closed_by_condition(value):
            return True
    return None


def winter_state(tags: dict, cls: str, settled: bool) -> str:
    """`cleared` (ploughed asphalt) or `snow` (a snow-covered track); see the module
    docstring."""
    closed = closed_in_winter(tags)
    if closed is not None:
        return "snow" if closed else "cleared"
    surface = (tags.get("surface") or "").lower()
    if cls == "track" or surface in UNPAVED:
        return "snow"
    if tags.get("motor_vehicle") == "no" or tags.get("access") == "no":
        return "snow"
    if cls in PUBLIC:
        return "cleared"
    return "cleared" if settled else "snow"


def collect(elements: list[dict], frame: LocalFrame, extent) -> list[dict]:
    """Every road way with a point on the terrain `extent`, in local metres, with its
    class, width, structure and tags (the winter state needs the buildings: `finish`)."""
    roads = []
    for el in elements:
        tags = el.get("tags", {})
        cls = tags.get("highway")
        if el.get("type") != "way" or cls not in CLASSES or len(el.get("geometry") or []) < 2:
            continue
        if tags.get("area") == "yes":
            continue
        pts = _project(frame, el["geometry"])
        inside = (
            (pts[:, 0] >= extent.west)
            & (pts[:, 0] <= extent.east)
            & (pts[:, 1] >= extent.south)
            & (pts[:, 1] <= extent.north)
        )
        if not inside.any():
            continue
        line = LineString(pts)
        if line.length < 1:
            continue
        width, source = width_of(tags, cls)
        roads.append(
            {
                "id": el["id"],
                "class": cls,
                "rank": CLASSES[cls][0],
                "name": display_name(tags),
                "ref": tags.get("ref"),
                "width": width,
                "widthSource": source,
                "surface": tags.get("surface"),
                "structure": structure(tags),
                "line": line,
                "tags": tags,
            }
        )
    return roads


# --- Grading -----------------------------------------------------------------------------


def _blur(mask: np.ndarray, r: int) -> np.ndarray:
    """Mean over a (2r+1)² window (edges clamped)."""
    k = 2 * r + 1
    padded = np.pad(mask.astype(np.float32), r, mode="edge")
    integral = np.pad(padded.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return (integral[k:, k:] - integral[:-k, k:] - integral[k:, :-k] + integral[:-k, :-k]) / (k * k)


def keep_off(piste_shapes: list, grid: Grid) -> np.ndarray:
    """How much of a road's grading applies per cell (0..1): none on a piste (plus
    PISTE_MARGIN), fading in over FEATHER cells beyond it."""
    shapes = [s.buffer(PISTE_MARGIN) for s in piste_shapes if not s.is_empty]
    if not shapes:
        return np.ones((grid.height, grid.width), dtype=np.float32)
    core = rio_features.rasterize(
        [(s, 1) for s in shapes],
        out_shape=(grid.height, grid.width),
        transform=grid.transform,
        fill=0,
        all_touched=True,
        dtype="uint8",
    ).astype(bool)
    return np.where(core, 0.0, 1.0 - np.clip(_blur(core, FEATHER) * 2, 0, 1)).astype(np.float32)


def stamp(
    heights: np.ndarray,
    grid: Grid,
    p: dict,
    half: float,
    weight: np.ndarray,
    benched: np.ndarray,
) -> None:
    """Write a level-across road (profile `p`, bench half-width `half`) into `heights`
    in place, with banks back to the ground, scaled by `weight` per cell. Banks leave
    cells already on another road's bench (`benched`, updated) alone, so a hairpin's
    banks don't reshape the leg below."""
    pts, dist = p["pts"], p["dist"]
    cells = _cells(grid, LineString(pts), half + ROAD_BANK_REACH)
    if cells is None:
        return
    rows, cols, e, n = cells
    nearest = np.empty(len(e), dtype=int)
    for k in range(0, len(e), 4096):
        de = e[k : k + 4096, None] - pts[None, :, 0]
        dn = n[k : k + 4096, None] - pts[None, :, 1]
        nearest[k : k + 4096] = np.argmin(de * de + dn * dn, axis=1)
    re_, rn = e - pts[nearest, 0], n - pts[nearest, 1]
    along = re_ * p["tangent"][nearest, 0] + rn * p["tangent"][nearest, 1]
    side = re_ * p["normal"][nearest, 0] + rn * p["normal"][nearest, 1]
    s = dist[nearest] + along
    beyond = np.maximum(np.maximum(-s, s - dist[-1]), 0)
    out = np.hypot(np.maximum(np.abs(side) - half, 0), beyond)
    sc = np.clip(s, 0, dist[-1])
    z = np.interp(sc, dist, p["z"])
    h = heights[rows, cols].astype(float)
    sign = np.where(side >= 0, 1.0, -1.0)
    station = np.rint(np.interp(sc, dist, np.arange(len(pts)))).astype(int)
    edge_e = pts[station, 0] + p["normal"][station, 0] * sign * half
    edge_n = pts[station, 1] + p["normal"][station, 1] * sign * half
    mismatch = z - sample_bilinear(heights, grid, edge_e, edge_n)
    rate = np.where(mismatch > 0, TAN_FILL, TAN_CUT)
    banked = h + np.sign(mismatch) * np.maximum(np.abs(mismatch) - out * rate, 0)
    bench = out <= 0
    target = np.where(bench, z, banked)
    w = weight[rows, cols] * np.where(bench | ~benched[rows, cols], 1.0, 0.0)
    heights[rows, cols] = (h + w * (target - h)).astype(heights.dtype)
    benched[rows[bench & (w > 0.5)], cols[bench & (w > 0.5)]] = True


def graded_lines(road: dict) -> list[LineString]:
    """The parts of a road built into the ground: none on bridges or in tunnels."""
    return [] if road["structure"] else [road["line"]]


def grade(roads: list[dict], heights: np.ndarray, grid: Grid, piste_shapes: list) -> dict:
    """Build every road into `heights` (in place), minor roads first so a main road
    wins at a junction, and nowhere on a piste. Returns stats."""

    def ground(e, n):
        return sample_bilinear(heights, grid, e, n)

    weight = keep_off(piste_shapes, grid)
    benched = np.zeros(heights.shape, dtype=bool)
    stats = {"roads": 0, "km": 0.0, "skippedBridgesTunnels": 0}
    for road in sorted(roads, key=lambda r: -r["rank"]):
        lines = graded_lines(road)
        if not lines:
            stats["skippedBridgesTunnels"] += 1
        for line in lines:
            if line.length < 4:
                continue
            p = strip_profile(line, road["width"] / 2, ground)
            stamp(heights, grid, p, road["width"] / 2 + SHOULDER, weight, benched)
            stats["roads"] += 1
            stats["km"] += line.length / 1000
    stats["km"] = round(stats["km"], 1)
    return stats


# --- After the buildings: winter state, banks, poles, records ----------------------------


class Settlements:
    """Where the buildings are: `settled(e, n)` is SETTLED_MIN buildings within
    SETTLED_RADIUS."""

    def __init__(self, buildings: list[dict]):
        centres = [
            Point(np.mean(np.asarray(b["footprint"]), axis=0))
            for b in buildings
            if not b.get("raised") and len(b["footprint"]) >= 3
        ]
        self.tree = STRtree(centres) if centres else None

    def settled(self, e: float, n: float) -> bool:
        if self.tree is None:
            return False
        hits = self.tree.query(Point(e, n), predicate="dwithin", distance=SETTLED_RADIUS)
        return len(hits) >= SETTLED_MIN

    def along(self, line: LineString) -> list[bool]:
        """Settled or not at points SETTLED_STEP apart along `line` (both ends too)."""
        count = max(int(math.ceil(line.length / SETTLED_STEP)), 1)
        return [
            self.settled(*line.interpolate(line.length * k / count).coords[0])
            for k in range(count + 1)
        ]


def _pieces(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, LineString) and g.length > 0]


def _drawn(road: dict) -> bool:
    return road["winter"] == "cleared" and road["structure"] != "tunnel"


class Obstacles:
    """Shapes kept clear, indexed: `cut(line)` is the line outside them, `outside(points)`
    which points are outside (no union of thousands of shapes needed)."""

    def __init__(self, shapes: list):
        self.shapes = [s for s in shapes if s is not None and not s.is_empty]
        self.tree = STRtree(self.shapes) if self.shapes else None

    def cut(self, line: LineString) -> list[LineString]:
        if self.tree is None:
            return [line]
        hits = self.tree.query(line, predicate="intersects")
        if not len(hits):
            return [line]
        return _pieces(line.difference(unary_union([self.shapes[i] for i in hits])))

    def outside(self, points: np.ndarray) -> np.ndarray:
        if self.tree is None or not len(points):
            return np.ones(len(points), dtype=bool)
        inside = self.tree.query(
            [Point(p) for p in points], predicate="within"
        )  # (2, k): point index, shape index
        keep = np.ones(len(points), dtype=bool)
        keep[inside[0]] = False
        return keep


def _surfaces(roads: list[dict], margin: float) -> list:
    return [r["line"].buffer(r["width"] / 2 + margin) for r in roads if r["structure"] != "tunnel"]


def snowbanks(roads: list[dict], blocked: list, frontage: list) -> list[list]:
    """Ploughed bank lines along cleared roads (not bridges), off every road surface
    (junctions), `blocked` (pistes, airfields, terminals) and, in settlements, building
    `frontage`; cut into BANK_RUN runs with BANK_GAP gaps, simplified to BANK_SIMPLIFY."""
    lines = []
    for road in roads:
        if not _drawn(road) or road["structure"] == "bridge":
            continue
        for side in (1, -1):
            edge = road["line"].offset_curve(side * (road["width"] / 2 + BANK_OFFSET))
            lines += _pieces(edge)
    if not lines:
        return []
    no_go = Obstacles([*_surfaces(roads, 0.5), *blocked, *frontage])
    out: list[list] = []
    for line in lines:
        for piece in no_go.cut(line):
            at = 0.0
            while at < piece.length:
                run = substring(piece, at, min(at + BANK_RUN, piece.length))
                if run.length >= BANK_MIN:
                    run = run.simplify(BANK_SIMPLIFY)
                    out.append(np.round(np.asarray(run.coords), 1).tolist())
                at += BANK_RUN + BANK_GAP
    return out


def snow_poles(roads: list[dict], blocked: list, settlements: Settlements) -> list[list]:
    """Snow poles along cleared roads outside settlements: [east, north], alternating
    sides POLE_SPACING / 2 apart, off `blocked` and every road surface."""
    points: list[tuple[float, float]] = []
    for road in roads:
        if not _drawn(road) or road["structure"] == "bridge":
            continue
        line = road["line"]
        offset = road["width"] / 2 + POLE_OFFSET
        step = POLE_SPACING / 2
        count = int(line.length // step)
        for k in range(count + 1):
            at = min(step / 2 + k * step, line.length)
            p = line.interpolate(at)
            if settlements.settled(p.x, p.y):
                continue
            # Offset from the local direction.
            a = line.interpolate(max(at - 1.0, 0))
            b = line.interpolate(min(at + 1.0, line.length))
            de, dn = b.x - a.x, b.y - a.y
            norm = math.hypot(de, dn)
            if norm < 1e-6:
                continue
            side = 1 if k % 2 else -1
            points.append((p.x + side * dn / norm * offset, p.y - side * de / norm * offset))
    if not points:
        return []
    arr = np.array(points)
    keep = Obstacles([*_surfaces(roads, 1.0), *blocked]).outside(arr)
    return [[round(e, 1), round(n, 1)] for (e, n), k in zip(arr, keep, strict=True) if k]


def classify(roads: list[dict], settlements: Settlements) -> dict:
    """Set each road's `winter` state (in place); returns counts by state."""
    counts = {"cleared": 0, "snow": 0}
    for road in roads:
        settled = any(settlements.along(road["line"]))
        road["winter"] = winter_state(road["tags"], road["class"], settled)
        counts[road["winter"]] += 1
    return counts


def finish(
    roads: list[dict],
    buildings: list[dict],
    piste_shapes: list,
    airfield_surfaces: list = (),
    keep_clear: list = (),
) -> dict:
    """The `roads` record for features.json, on the final ground: each road's winter
    state, and the snowbanks and snow poles of the cleared ones. A road's surface isn't
    drawn on an airfield's (`airfield_surfaces`: the runway or apron is on top; `drawn`
    is what's left); banks and poles stay off those, pistes and `keep_clear` (terminal
    pads)."""
    settlements = Settlements(buildings)
    counts = classify(roads, settlements)
    fields = Obstacles(list(airfield_surfaces))
    for road in roads:
        pieces = fields.cut(road["line"])
        road["drawn"] = (
            None
            if len(pieces) == 1 and pieces[0].equals(road["line"])
            else [np.round(np.asarray(g.coords), 1).tolist() for g in pieces if g.length >= 1]
        )
    blocked = [s.buffer(PISTE_MARGIN) for s in piste_shapes if not s.is_empty]
    blocked += [s for s in (*airfield_surfaces, *keep_clear) if not s.is_empty]
    frontage = [
        Polygon(b["footprint"]).buffer(FRONTAGE)
        for b in buildings
        if not b.get("raised") and len(b["footprint"]) >= 3
    ]
    banks = snowbanks(roads, blocked, [f for f in frontage if f.is_valid])
    poles = snow_poles(roads, blocked, settlements)
    records = [
        {
            "id": r["id"],
            "class": r["class"],
            "name": r["name"],
            "ref": r["ref"],
            "width": round(r["width"], 1),
            "widthSource": r["widthSource"],
            "surface": r["surface"],
            "winter": r["winter"],
            "structure": r["structure"],
            "line": np.round(np.asarray(r["line"].coords), 1).tolist(),
            **({"drawn": r["drawn"]} if r["drawn"] is not None else {}),
        }
        for r in sorted(roads, key=lambda r: -r["rank"])
    ]
    log.info(
        "%d roads (%d cleared, %d snow-covered), %d snowbanks, %d snow poles",
        len(records),
        counts["cleared"],
        counts["snow"],
        len(banks),
        len(poles),
    )
    return {"roads": records, "snowbanks": banks, "poles": poles}


def manifest_entry(record: dict, grading: dict, pistes_meta: dict) -> dict:
    """The manifest's `roads`: the coverage raster (same grid as the piste overlay) and
    what the roads are made of."""
    roads = record["roads"]
    by_source: dict[str, int] = {}
    for r in roads:
        by_source[r["widthSource"]] = by_source.get(r["widthSource"], 0) + 1
    km = {
        state: round(
            sum(LineString(r["line"]).length for r in roads if r["winter"] == state) / 1000, 1
        )
        for state in ("cleared", "snow")
    }
    return {
        "raster": {
            "file": "roads.png",
            "cellSize": pistes_meta["overlay"]["cellSize"],
            "extent": pistes_meta["extent"],
            "channels": "R cleared asphalt, G snow-covered road (coverage)",
        },
        "count": len(roads),
        "km": km,
        "widths": by_source,
        "widthsEstimated": "class defaults where OSM has no width or lanes",
        "graded": grading,
        "snowbanks": len(record["snowbanks"]),
        "poles": len(record["poles"]),
        "winter": "closed-in-winter tags, tracks and unpaved roads snow-covered; through "
        "roads and streets cleared; service roads cleared in settlements",
        "synthetic": "snowbanks and snow poles are placed along cleared roads, not mapped",
    }


def clearing_shapes(roads: list[dict]) -> list:
    """Where trees must not stand: every road but tunnels, plus CLEARING either side."""
    return [
        r["line"].buffer(r["width"] / 2 + CLEARING, cap_style="flat")
        for r in roads
        if r["structure"] != "tunnel"
    ]


def centred_mean(fine: np.ndarray, factor: int, band: int = 1024) -> np.ndarray:
    """Mean of a uint8 grid over a (2·factor-1)² window centred on every factor-th
    sample (as `pistes._box_average`), in bands of rows with integer sums, so a 2 m grid
    over a whole resort neither runs out of memory nor of float precision."""
    pad = factor - 1
    k = 2 * factor - 1
    padded = np.pad(fine, pad, mode="edge")
    rows = range(0, fine.shape[0], factor)
    out = np.empty((len(rows), len(range(0, fine.shape[1], factor))), dtype=np.float32)
    for i0 in range(0, len(rows), band):
        r0 = rows[i0]
        chunk = padded[r0 : min(r0 + band * factor + k, padded.shape[0])].astype(np.int32)
        col = np.pad(chunk.cumsum(axis=1), ((0, 0), (1, 0)))
        across = (col[:, k:] - col[:, :-k])[:, ::factor]
        row = np.pad(across.cumsum(axis=0), ((1, 0), (0, 0)))
        sums = (row[k:] - row[:-k])[::factor]
        n = min(band, len(rows) - i0)
        out[i0 : i0 + n] = sums[:n] / (k * k)
    return out


def raster(roads: list[dict], extent, factor: int) -> Image.Image:
    """Coverage on the piste overlay's grid (`pistes.RASTER_CELL` × `factor`), RGB: R
    cleared asphalt, G snow-covered road. Bridges and tunnels aren't on the ground."""
    from .pistes import RASTER_CELL

    grid = Grid(extent, RASTER_CELL)
    channels = []
    for state in ("cleared", "snow"):
        shapes = [
            (r["line"].buffer(r["width"] / 2, cap_style="flat"), 255)
            for r in roads
            if r["winter"] == state and not r["structure"]
        ]
        fine = (
            rio_features.rasterize(
                shapes,
                out_shape=(grid.height, grid.width),
                transform=grid.transform,
                fill=0,
                dtype="uint8",
            )
            if shapes
            else np.zeros((grid.height, grid.width), dtype=np.uint8)
        )
        channels.append(centred_mean(fine, factor))
    rgb = np.dstack([channels[0], channels[1], np.zeros_like(channels[0])])
    return Image.fromarray(np.clip(np.round(rgb), 0, 255).astype(np.uint8), mode="RGB")
