"""Airfields and helipads: runways, taxiways, aprons, helipads and windsocks from OSM
(`aeroway=*`), cross-checked and filled in from OurAirports.

Only the ground side: no aircraft. Each surface is built into the terrain the way it is
built for real, before lift terminals and buildings are placed (like `grading.py`):

- Runways and taxiways are level across but keep their real longitudinal profile (an
  altiport's runway climbs: Courchevel's is 537 m at up to ~18.6%, with a level top). The
  profile is the ground's along the centreline, lightly smoothed; beyond the bench a
  fill or cut bank closes the gap to the natural slope, as for pistes.
- Aprons are fitted with a plane (at most MAX_APRON_GRADE) and helipads are level pads.
- Winter state follows the surface: paved surfaces are cleared (ploughed snowbanks along
  their edges, with gaps to ski through), anything else is a groomed snow surface lined
  with edge markers. A taxiway or apron with no surface tag that joins a cleared one is
  cleared too.
- A helipad tagged `location=roof` (or `layer` >= 1, or mapped inside a building's
  footprint) sits on that building's roof, which is made flat.

Markings (threshold bars, designators, centreline, aiming points, edge lines, a helipad's
H and touchdown circle) are not data: the sim draws them from the ICAO Annex 14
standard, so they're recorded as synthetic. Runways and helipads aren't pistes: they're
not in the piste overlay or lookup, and skiing across them is allowed.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass

import numpy as np
from rasterio import features as rio_features
from rasterio.windows import Window
from rasterio.windows import transform as window_transform
from shapely import contains_xy
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import substring, unary_union
from shapely.strtree import STRtree

from .features import _project, display_name
from .frame import LocalFrame
from .grading import TAN_CUT, TAN_FILL
from .grid import Grid, sample_bilinear
from .sources.ourairports import Airport
from .sources.ourairports import Runway as OurRunway

log = logging.getLogger(__name__)

PAVED = ("asphalt", "concrete", "paved", "bitumen", "tarmac", "paving_stones", "con", "asp")
DEFAULT_WIDTH = {"cleared": 20.0, "groomed": 30.0}  # runways with no width anywhere (m)
TAXIWAY_WIDTH = 10.0
HELIPAD_SIZE = 15.0  # a node helipad's pad (m): a light helicopter's FATO
#: A runway way mapped this much shorter than its published length is lengthened to it
#: (more than EXTEND_MAX short is taken as mapped differently, and left alone).
EXTEND_MIN = 0.02
EXTEND_MAX = 0.15
SHOULDER = 3.0  # level ground either side of a runway or taxiway beyond its surface (m)
END_MARGIN = 3.0  # and beyond a runway's ends
STEP = 2.0  # centreline station spacing (m)
SMOOTH_ALONG = 10.0  # m: the longitudinal profile is a moving average over this
CROSS_SAMPLES = 9
BANK_REACH = 25.0  # how far beyond the bench a bank can reach (m)
MAX_APRON_GRADE = 0.03
PAD_MARGIN = 2.0  # level ground round a helipad or apron before the bank (m)
CONNECTED = 5.0  # m: surfaces this close join (a taxiway onto an apron)
LABEL_MERGE = 600.0  # m: aerodrome names this close are one place
#: Ploughed snowbanks: this far outside the cleared edge, in runs this long with gaps
#: between (the sim's banks are solid; the gaps let you ski across).
BANK_OFFSET = 3.0
BANK_RUN = 50.0
BANK_GAP = 6.0
BANK_MIN = 3.0
MARKER_SPACING = 30.0  # edge markers along groomed snow runways and taxiways (m)
MARKER_OFFSET = 1.0  # outside the edge (m)
#: Trees are cleared from the surfaces and their strips (beyond the surface's edge).
STRIP = {"runway": 15.0, "runwayEnd": 30.0, "taxiway": 8.0, "apron": 8.0, "helipad": 15.0}
ROOF_TAGS = ("roof", "rooftop")


@dataclass(frozen=True)
class RunwayRef:
    """Published figures for one runway (resort config `runways`), for validation."""

    icao: str
    ref: str | None = None
    length: float | None = None
    width: float | None = None
    #: Steepest published gradient, % (an altiport's slope).
    slope: float | None = None
    #: Threshold elevations by designator (m).
    elevations: tuple[tuple[str, float], ...] = ()
    source: str | None = None


def is_paved(surface: str | None) -> bool:
    if not surface:
        return False
    s = surface.lower()
    return s.startswith(PAVED) or s in ("metal", "paved")


def _number(value: str | None) -> float | None:
    if not value:
        return None
    match = re.match(r"^\s*(-?[0-9]+(?:[.,][0-9]+)?)\s*(m|%)?\s*$", value)
    return float(match.group(1).replace(",", ".")) if match else None


def bearing(a, b) -> float:
    """Compass bearing (deg) from a to b, both (east, north)."""
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360


def _angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def _designator(heading: float) -> str:
    n = round(heading / 10) % 36
    return f"{n or 36:02d}"


def designators(ref: str | None, heading: float) -> tuple[str, str, bool]:
    """The designators of a runway's two ends for a centreline drawn on `heading`, and
    whether the line runs backwards (its first point is the second designator's end).
    From OSM `ref` ("04/22", "10-28", "4L/22R"), else from the heading."""
    parts = re.split(r"\s*[/-]\s*", ref.strip()) if ref else []
    ok = len(parts) == 2 and all(re.fullmatch(r"\d{1,2}[LRC]?", p, re.I) for p in parts)
    if not ok:
        return _designator(heading), _designator(heading + 180), False
    a, b = (re.sub(r"^(\d)(?!\d)", r"0\1", p.upper()) for p in parts)
    # You land on runway 04 heading ~040°: its threshold is the end the line starts from
    # when the line runs on that heading.
    reverse = _angle_diff(int(a[:2]) * 10, heading) > 90
    return (b, a, True) if reverse else (a, b, False)


def _same_ident(a: str, b: str) -> bool:
    return a.lstrip("0").upper() == b.lstrip("0").upper() or (
        _number_of(a) is not None and _number_of(a) == _number_of(b)
    )


def _closed(el: dict) -> bool:
    g = el.get("geometry") or []
    return len(g) >= 4 and g[0] == g[-1]


def _rectangle(poly: Polygon) -> tuple[LineString, float]:
    """Centreline along the long axis of a polygon's oriented rectangle, and its width."""
    corners = np.asarray(poly.minimum_rotated_rectangle.exterior.coords)[:4]
    e1, e2 = corners[1] - corners[0], corners[2] - corners[1]
    if np.hypot(*e1) >= np.hypot(*e2):
        a, b, width = (corners[0] + corners[3]) / 2, (corners[1] + corners[2]) / 2, np.hypot(*e2)
    else:
        a, b, width = (corners[0] + corners[1]) / 2, (corners[3] + corners[2]) / 2, np.hypot(*e1)
    return LineString([a, b]), float(width)


def _position(el: dict, frame: LocalFrame) -> tuple[float, float] | None:
    if el["type"] == "node":
        return frame.to_local(el["lon"], el["lat"])
    if el["type"] == "way" and el.get("geometry"):
        ring = _project(frame, el["geometry"])
        if _closed(el) and len(ring) >= 4:
            c = Polygon(ring).centroid
            return float(c.x), float(c.y)
        return tuple(ring.mean(axis=0))
    b = el.get("bounds")
    if b:
        return frame.to_local((b["minlon"] + b["maxlon"]) / 2, (b["minlat"] + b["maxlat"]) / 2)
    return None


def collect(
    elements: list[dict],
    frame: LocalFrame,
    extent,
    airports: list[Airport] = (),
    our_runways: list[OurRunway] = (),
    building_rings: list[list] = (),
) -> dict:
    """Runways, taxiways, aprons, helipads, windsocks and named aerodromes inside the
    terrain `extent`, in local metres. `building_rings` (OSM building footprints) find
    the helipads on roofs."""
    by_airport: dict[str, list[OurRunway]] = {}
    for r in our_runways:
        if not r.closed:
            by_airport.setdefault(r.airport, []).append(r)
    ours = []
    for a in airports:
        e, n = frame.to_local(a.lon, a.lat)
        ours.append((a, e, n))

    def inside(points: np.ndarray) -> bool:
        return bool(
            (points[:, 0] >= extent.west).all()
            and (points[:, 0] <= extent.east).all()
            and (points[:, 1] >= extent.south).all()
            and (points[:, 1] <= extent.north).all()
        )

    footprints = [Polygon(r) for r in building_rings if len(r) >= 3]
    footprints = [p for p in footprints if p.is_valid]

    runways, taxiways, aprons, helipads, windsocks, names = [], [], [], [], [], []
    for el in elements:
        tags = el.get("tags", {})
        kind = tags.get("aeroway")
        geometry = el.get("geometry") or []
        if kind == "windsock" and el["type"] == "node":
            e, n = frame.to_local(el["lon"], el["lat"])
            if extent.contains(e, n):
                windsocks.append({"id": el["id"], "east": round(e, 2), "north": round(n, 2)})
            continue
        if kind in ("aerodrome", "airstrip", "heliport") and display_name(tags):
            at = _position(el, frame)
            if at is not None and extent.contains(*at):
                names.append(
                    {
                        "id": el["id"],
                        "name": display_name(tags),
                        "kind": "heliport" if kind == "heliport" else "airfield",
                        "icao": tags.get("icao"),
                        "iata": tags.get("iata"),
                        "east": round(at[0], 1),
                        "north": round(at[1], 1),
                        "ele": _number(tags.get("ele")),
                        "source": "osm",
                    }
                )
            continue
        if kind == "helipad":
            pad = _helipad(el, frame, footprints)
            if pad is not None and extent.contains(pad["east"], pad["north"]):
                helipads.append(pad)
                if pad["name"]:
                    names.append(
                        {
                            "id": el["id"],
                            "name": pad["name"],
                            "kind": "heliport",
                            "icao": None,
                            "iata": None,
                            "east": pad["east"],
                            "north": pad["north"],
                            "ele": None,
                            "source": "osm",
                        }
                    )
            continue
        if el["type"] != "way" or len(geometry) < 2:
            continue
        points = _project(frame, geometry)
        if not inside(points):
            continue
        surface = tags.get("surface")
        if kind == "runway":
            if _closed(el):
                line, width = _rectangle(Polygon(points[:-1]))
            else:
                line, width = LineString(points), _number(tags.get("width"))
            runways.append(
                {
                    "id": el["id"],
                    "line": line,
                    "ref": tags.get("ref"),
                    "width": _number(tags.get("width")) or width,
                    "surface": surface,
                    "source": "osm",
                    "published": {
                        "length": _number(tags.get("length")),
                        "width": _number(tags.get("width")),
                        "incline": _number(tags.get("incline")),
                    },
                }
            )
        elif kind == "taxiway":
            if _closed(el):
                aprons.append(
                    {"id": el["id"], "ring": Polygon(points[:-1]), "surface": surface, "name": None}
                )
            else:
                taxiways.append(
                    {
                        "id": el["id"],
                        "line": LineString(points),
                        "width": _number(tags.get("width")) or TAXIWAY_WIDTH,
                        "surface": surface,
                    }
                )
        elif kind == "apron" and _closed(el):
            ring = Polygon(points[:-1])
            if ring.is_valid and ring.area > 20:
                aprons.append(
                    {"id": el["id"], "ring": ring, "surface": surface, "name": tags.get("name")}
                )

    # OurAirports: fill in what OSM's runway ways don't say, and add runways OSM lacks.
    for rw in runways:
        _match_runway(rw, ours, by_airport, frame)
    for a, _e, _n in ours:
        for r in by_airport.get(a.id, []):
            ends = [(x.lat, x.lon) for x in r.ends]
            if any(lat is None or lon is None for lat, lon in ends):
                continue
            p = np.array([frame.to_local(lon, lat) for lat, lon in ends])
            line = LineString(p)
            if not inside(p) or line.length < 50:
                continue
            if any(rw["line"].distance(line.centroid) < 100 for rw in runways):
                continue
            runways.append(
                {
                    "id": f"ourairports-{a.ident}-{r.ends[0].ident}",
                    "line": line,
                    "ref": f"{r.ends[0].ident}/{r.ends[1].ident}",
                    "width": r.width,
                    "surface": r.surface,
                    "source": "ourairports",
                    "airport": a,
                    "ourRunway": r,
                    "published": {"length": r.length, "width": r.width, "incline": None},
                }
            )
    for a, e, n in ours:
        if a.type not in ("small_airport", "medium_airport", "large_airport", "heliport"):
            continue
        if not extent.contains(e, n):
            continue
        names.append(
            {
                "id": f"ourairports-{a.ident}",
                "name": a.name,
                "kind": "heliport" if a.type == "heliport" else "airfield",
                "icao": a.icao,
                "iata": a.iata,
                "east": round(e, 1),
                "north": round(n, 1),
                "ele": a.elevation,
                "source": "ourairports",
            }
        )

    for rw in runways:
        _finish_runway(rw)
    surfaces = _winter(runways, taxiways, aprons, helipads)
    log.info(
        "Airfields: %d runways, %d taxiways, %d aprons, %d helipads (%d on roofs), "
        "%d windsocks; cleared %s",
        len(runways),
        len(taxiways),
        len(aprons),
        len(helipads),
        sum(p["roof"] for p in helipads),
        len(windsocks),
        surfaces,
    )
    return {
        "runways": runways,
        "taxiways": taxiways,
        "aprons": aprons,
        "helipads": helipads,
        "windsocks": windsocks,
        "aerodromes": _merge_names(names, runways),
    }


def _helipad(el: dict, frame: LocalFrame, footprints: list[Polygon]) -> dict | None:
    tags = el.get("tags", {})
    ring = None
    heading = 0.0
    shape = "square"
    if el["type"] == "node":
        e, n = frame.to_local(el["lon"], el["lat"])
        size = _number(tags.get("width")) or HELIPAD_SIZE
    elif el["type"] == "way" and _closed(el):
        poly = Polygon(_project(frame, el["geometry"])[:-1])
        if not poly.is_valid or poly.area < 4:
            return None
        rect = poly.minimum_rotated_rectangle
        corners = np.asarray(rect.exterior.coords)[:4]
        sides = [corners[1] - corners[0], corners[2] - corners[1]]
        long = max(sides, key=lambda s: np.hypot(*s))
        size = float(max(np.hypot(*s) for s in sides))
        heading = bearing((0, 0), long) % 180
        shape = "circle" if poly.area < 0.86 * rect.area else "square"
        c = poly.centroid
        e, n = float(c.x), float(c.y)
        ring = np.round(np.asarray(poly.exterior.coords)[:-1], 2).tolist()
    else:
        return None
    centre = Point(e, n)
    layer = _number(tags.get("layer")) or 0
    roof = (
        tags.get("location") in ROOF_TAGS
        or layer >= 1
        or any(fp.contains(centre) and fp.area > 0.5 * size * size for fp in footprints)
    )
    return {
        "id": el["id"],
        "name": display_name(tags),
        "east": round(e, 2),
        "north": round(n, 2),
        "ring": ring,
        "shape": shape,
        "size": round(min(max(size, 6.0), 40.0), 1),
        "heading": round(heading, 1),
        "surface": tags.get("surface"),
        "roof": bool(roof),
    }


def _match_runway(rw: dict, ours, by_airport, frame: LocalFrame) -> None:
    """The OurAirports runway this OSM one is (nearest airport within 3 km, same
    designators, or its only runway), and what it fills in."""
    mid = rw["line"].interpolate(0.5, normalized=True)
    near = sorted(
        ((math.hypot(e - mid.x, n - mid.y), a) for a, e, n in ours if by_airport.get(a.id)),
        key=lambda t: t[0],
    )
    if not near or near[0][0] > 3000:
        return
    airport = near[0][1]
    candidates = by_airport[airport.id]
    heading = bearing(rw["line"].coords[0], rw["line"].coords[-1])
    first, second, _ = designators(rw["ref"], heading)
    match = next(
        (
            r
            for r in candidates
            if {_number_of(r.ends[0].ident), _number_of(r.ends[1].ident)}
            == {_number_of(first), _number_of(second)}
        ),
        # An airport's only runway is this one if OSM gives no designators to tell.
        candidates[0] if len(candidates) == 1 and not rw["ref"] else None,
    )
    rw["airport"] = airport
    if match is None:
        return
    rw["ourRunway"] = match
    rw["thresholds"] = {
        end.ident: frame.to_local(end.lon, end.lat)
        for end in match.ends
        if end.lat is not None and end.lon is not None
    }
    published = rw["published"]
    published["length"] = published["length"] or match.length
    published["width"] = published["width"] or match.width
    rw["width"] = rw["width"] or match.width
    rw["surface"] = rw["surface"] or match.surface


def _finish_runway(rw: dict) -> None:
    line: LineString = rw["line"]
    heading = bearing(line.coords[0], line.coords[-1])
    # In the line's own order: its first point is the first designator's threshold.
    first, second, _ = designators(rw["ref"], heading)
    rw["designators"] = [first, second]
    line, rw["extended"] = extend_to(
        line, rw["published"]["length"], rw.get("thresholds", {}), rw["designators"]
    )
    rw["line"] = line
    rw["heading"] = round(bearing(line.coords[0], line.coords[-1]), 1)
    rw["winter"] = "cleared" if is_paved(rw["surface"]) else "groomed"
    rw["width"] = float(rw["width"] or DEFAULT_WIDTH[rw["winter"]])


def extend_to(
    line: LineString, published: float | None, thresholds: dict, names: list[str]
) -> tuple[LineString, float]:
    """A runway mapped shorter than its published length (by EXTEND_MIN to EXTEND_MAX)
    lengthened along its end segments to it: at the end that isn't on a published
    threshold (OurAirports), or both ends equally. Returns the line and metres added."""
    if not published or line.length >= published * (1 - EXTEND_MIN):
        return line, 0.0
    if line.length < published * (1 - EXTEND_MAX):
        return line, 0.0
    missing = published - line.length
    pts = [np.array(p, dtype=float) for p in line.coords]

    def on_threshold(i: int) -> bool:
        at = next((v for k, v in thresholds.items() if _same_ident(k, names[i])), None)
        return at is not None and math.hypot(at[0] - pts[-i][0], at[1] - pts[-i][1]) < 15

    fixed = [on_threshold(0), on_threshold(1)]
    share = (
        (0.0, 1.0)
        if fixed[0] and not fixed[1]
        else (1.0, 0.0)
        if fixed[1] and not fixed[0]
        else (0.5, 0.5)
    )
    d0 = pts[0] - pts[1]
    d1 = pts[-1] - pts[-2]
    pts[0] = pts[0] + d0 / np.hypot(*d0) * missing * share[0]
    pts[-1] = pts[-1] + d1 / np.hypot(*d1) * missing * share[1]
    return LineString(pts), round(missing, 1)


def _winter(runways, taxiways, aprons, helipads) -> dict:
    """Winter state of every surface: paved is cleared, other surfaces groomed snow. A
    taxiway, apron or helipad with no surface tag takes "cleared" from a cleared
    surface it joins (an unmarked taxiway onto an asphalt runway is asphalt too)."""
    for item in (*taxiways, *aprons, *helipads):
        item["winter"] = "cleared" if is_paved(item["surface"]) or item.get("roof") else "groomed"
    shapes = {
        id(x): _shape(x, kind)
        for kind, xs in _kinds(runways, taxiways, aprons, helipads)
        for x in xs
    }
    for _ in range(3):
        cleared = [
            shapes[id(x)]
            for _, xs in _kinds(runways, taxiways, aprons, helipads)
            for x in xs
            if x["winter"] == "cleared"
        ]
        if not cleared:
            break
        union = unary_union(cleared).buffer(CONNECTED)
        changed = False
        for item in (*taxiways, *aprons, *helipads):
            if item["surface"] or item["winter"] == "cleared":
                continue
            if shapes[id(item)].intersects(union):
                item["winter"] = "cleared"
                item["winterFrom"] = "connected"
                changed = True
        if not changed:
            break
    out = {"runways": sum(r["winter"] == "cleared" for r in runways)}
    for name, xs in (("taxiways", taxiways), ("aprons", aprons), ("helipads", helipads)):
        out[name] = sum(x["winter"] == "cleared" for x in xs)
    return out


def _kinds(runways, taxiways, aprons, helipads):
    return (("runway", runways), ("taxiway", taxiways), ("apron", aprons), ("helipad", helipads))


def _shape(item: dict, kind: str, margin: float = 0.0):
    """The ground a surface covers (plus `margin`)."""
    if kind in ("runway", "taxiway"):
        return item["line"].buffer(item["width"] / 2 + margin, cap_style="flat")
    if kind == "apron":
        return item["ring"].buffer(margin) if margin else item["ring"]
    if item["ring"] is not None:
        return Polygon(item["ring"]).buffer(margin)
    return Point(item["east"], item["north"]).buffer(item["size"] / 2 + margin, cap_style="square")


def _merge_names(names: list[dict], runways: list[dict]) -> list[dict]:
    """One label per place: OSM aerodromes first, then OSM-named heliports, then
    OurAirports' names, each dropped within LABEL_MERGE of one already kept (OurAirports'
    ICAO code and elevation fill in a kept OSM one)."""
    order = {"osm": 0, "ourairports": 1}
    names = sorted(names, key=lambda x: (order[x["source"]], x["kind"] != "airfield"))
    kept: list[dict] = []
    for x in names:
        twin = next(
            (
                k
                for k in kept
                if math.hypot(k["east"] - x["east"], k["north"] - x["north"])
                < (LABEL_MERGE if k["kind"] == x["kind"] else 150)
            ),
            None,
        )
        if twin is not None:
            twin["icao"] = twin["icao"] or x["icao"]
            twin["iata"] = twin["iata"] or x["iata"]
            twin["ele"] = twin["ele"] or x["ele"]
            continue
        kept.append(dict(x))
    # An aerodrome label sits over its runway's middle, where one is near.
    for k in kept:
        if k["kind"] != "airfield":
            continue
        near = [
            r for r in runways if r["line"].distance(Point(k["east"], k["north"])) < LABEL_MERGE
        ]
        if near:
            mid = max(near, key=lambda r: r["line"].length)["line"].interpolate(
                0.5, normalized=True
            )
            k["east"], k["north"] = round(mid.x, 1), round(mid.y, 1)
    return kept


# --- Grading -----------------------------------------------------------------------------


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    if len(x) < 3 or k < 2:
        return x.copy()
    k = min(k, len(x) - (1 - len(x) % 2))
    pad = k // 2
    return np.convolve(np.pad(x, pad, mode="edge"), np.ones(k) / k, mode="valid")[: len(x)]


def _stations(line: LineString) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    n = max(int(math.ceil(line.length / STEP)), 1) + 1
    dist = np.linspace(0, line.length, n)
    pts = np.array([line.interpolate(d).coords[0] for d in dist])
    tangent = np.gradient(pts, axis=0)
    tangent /= np.maximum(np.linalg.norm(tangent, axis=1, keepdims=True), 1e-9)
    normal = np.column_stack([-tangent[:, 1], tangent[:, 0]])
    return pts, dist, tangent, normal


def strip_profile(line: LineString, half: float, ground) -> dict:
    """A runway or taxiway built level across: its centreline heights are the ground's
    across the surface (median of CROSS_SAMPLES), smoothed along over SMOOTH_ALONG, so
    the real longitudinal profile (slope breaks included) stays."""
    pts, dist, tangent, normal = _stations(line)
    offsets = np.linspace(-half, half, CROSS_SAMPLES)
    e = pts[:, 0:1] + normal[:, 0:1] * offsets
    n = pts[:, 1:2] + normal[:, 1:2] * offsets
    h = ground(e.ravel(), n.ravel()).reshape(e.shape)
    z = _smooth(np.median(h, axis=1), max(int(round(SMOOTH_ALONG / STEP)), 1) | 1)
    return {"pts": pts, "dist": dist, "tangent": tangent, "normal": normal, "z": z}


def _window(grid: Grid, bounds: tuple[float, float, float, float], reach: float):
    ext = grid.extent
    w, s, e, n = bounds
    c0 = max(int((w - reach - ext.west) / grid.cell_size), 0)
    c1 = min(int((e + reach - ext.west) / grid.cell_size) + 1, grid.width - 1)
    r0 = max(int((ext.north - n - reach) / grid.cell_size), 0)
    r1 = min(int((ext.north - s + reach) / grid.cell_size) + 1, grid.height - 1)
    if c1 < c0 or r1 < r0:
        return None
    return Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1)


def _cells(grid: Grid, shape, reach: float):
    """Rows, cols and (east, north) of the grid cells within `reach` of `shape`."""
    window = _window(grid, shape.bounds, reach)
    if window is None:
        return None
    mask = rio_features.geometry_mask(
        [shape.buffer(reach)],
        out_shape=(window.height, window.width),
        transform=window_transform(window, grid.transform),
        invert=True,
    )
    rows, cols = np.nonzero(mask)
    if not len(rows):
        return None
    rows, cols = rows + window.row_off, cols + window.col_off
    e = grid.extent.west + cols * grid.cell_size
    n = grid.extent.north - rows * grid.cell_size
    return rows, cols, e, n


def stamp_strip(heights: np.ndarray, grid: Grid, p: dict, half: float, ends: float) -> None:
    """Write a level-across strip (profile `p`, bench half-width `half`, reaching `ends`
    beyond each end) into `heights` in place, with banks back to the natural ground."""
    pts, dist = p["pts"], p["dist"]
    cells = _cells(grid, LineString(pts), half + max(ends, 0) + BANK_REACH)
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
    # Interior cells are within half a station along; only the ends reach further.
    inner = (s >= 0) & (s <= dist[-1])
    side_out = np.maximum(np.abs(side) - half, 0)
    end_out = np.where(inner, 0.0, np.maximum(beyond - ends, 0))
    out = np.hypot(side_out, end_out)
    sc = np.clip(s, 0, dist[-1])
    z = np.interp(sc, dist, p["z"])

    h = heights[rows, cols].astype(float)
    # The bench edge's height off the natural ground, per side and station: the bank
    # bridges that back to zero.
    sign = np.where(side >= 0, 1.0, -1.0)
    station = np.rint(np.interp(sc, dist, np.arange(len(pts)))).astype(int)
    edge_e = pts[station, 0] + p["normal"][station, 0] * sign * half
    edge_n = pts[station, 1] + p["normal"][station, 1] * sign * half
    mismatch = z - sample_bilinear(heights, grid, edge_e, edge_n)
    rate = np.where(mismatch > 0, TAN_FILL, TAN_CUT)
    banked = h + np.sign(mismatch) * np.maximum(np.abs(mismatch) - out * rate, 0)
    heights[rows, cols] = np.where(out <= 0, z, banked).astype(heights.dtype)


def stamp_area(heights: np.ndarray, grid: Grid, poly, max_grade: float) -> float:
    """Fit a plane (gradient at most `max_grade`) to the ground under `poly` plus
    PAD_MARGIN, write it in place with banks back to the ground. Returns its mean."""
    flat = poly.buffer(PAD_MARGIN)
    cells = _cells(grid, flat, BANK_REACH)
    if cells is None:
        return float("nan")
    rows, cols, e, n = cells
    h = heights[rows, cols].astype(float)
    inside = contains_xy(flat, e, n)
    if inside.sum() < 1:
        c = flat.centroid
        inside = np.hypot(e - c.x, n - c.y) <= max(grid.cell_size, PAD_MARGIN)
    c = flat.centroid
    de, dn = e - c.x, n - c.y
    if inside.sum() >= 3 and max_grade > 0:
        a = np.column_stack([np.ones(inside.sum()), de[inside], dn[inside]])
        coef, *_ = np.linalg.lstsq(a, h[inside], rcond=None)
        grad = math.hypot(coef[1], coef[2])
        if grad > max_grade:
            coef[1:] *= max_grade / grad
    else:
        coef = np.array([float(np.median(h[inside])), 0.0, 0.0])
    plane = coef[0] + coef[1] * de + coef[2] * dn
    # Banks: the gap between the plane at the pad's edge and the ground there closes at
    # the fill or cut rate going out.
    boundary = flat.exterior
    ring_d = boundary.project([Point(x, y) for x, y in zip(e, n, strict=True)])
    edge = np.array([boundary.interpolate(d).coords[0] for d in ring_d])
    out = np.where(inside, 0.0, np.hypot(e - edge[:, 0], n - edge[:, 1]))
    edge_plane = coef[0] + coef[1] * (edge[:, 0] - c.x) + coef[2] * (edge[:, 1] - c.y)
    mismatch = edge_plane - sample_bilinear(heights, grid, edge[:, 0], edge[:, 1])
    rate = np.where(mismatch > 0, TAN_FILL, TAN_CUT)
    banked = h + np.sign(mismatch) * np.maximum(np.abs(mismatch) - out * rate, 0)
    heights[rows, cols] = np.where(inside, plane, banked).astype(heights.dtype)
    return float(coef[0])


def grade(fields: dict, heights: np.ndarray, grid: Grid) -> dict:
    """Build every surface into `heights` (in place): aprons, then ground-level helipads
    not on an apron, then taxiways, then runways (the runway wins where they meet)."""

    def ground(e, n):
        return sample_bilinear(heights, grid, e, n)

    stats = {"aprons": 0, "helipads": 0, "taxiways": 0, "runways": 0}
    apron_union = unary_union([a["ring"] for a in fields["aprons"]]) if fields["aprons"] else None
    for apron in fields["aprons"]:
        stamp_area(heights, grid, apron["ring"], MAX_APRON_GRADE)
        stats["aprons"] += 1
    for pad in fields["helipads"]:
        if pad["roof"] or (
            apron_union is not None and apron_union.contains(Point(pad["east"], pad["north"]))
        ):
            continue
        stamp_area(heights, grid, _shape(pad, "helipad"), 0.0)
        stats["helipads"] += 1
    for taxi in fields["taxiways"]:
        half = taxi["width"] / 2 + SHOULDER
        p = strip_profile(taxi["line"], taxi["width"] / 2, ground)
        stamp_strip(heights, grid, p, half, 0.0)
        stats["taxiways"] += 1
    for rw in fields["runways"]:
        p = strip_profile(rw["line"], rw["width"] / 2, ground)
        stamp_strip(heights, grid, p, rw["width"] / 2 + SHOULDER, END_MARGIN)
        stats["runways"] += 1
    return stats


# --- After the buildings: roofs, snowbanks, markers, records -----------------------------


def clearing_shapes(fields: dict) -> list:
    """Where trees must not stand: every ground-level surface plus its strip."""
    shapes = []
    for rw in fields["runways"]:
        line = rw["line"]
        a, b = np.array(line.coords[0]), np.array(line.coords[-1])
        d = (b - a) / max(np.hypot(*(b - a)), 1e-9)
        ext = STRIP["runwayEnd"]
        longer = LineString([a - d * ext, *line.coords[1:-1], b + d * ext])
        shapes.append(longer.buffer(rw["width"] / 2 + STRIP["runway"], cap_style="flat"))
    for kind in ("taxiway", "apron", "helipad"):
        for item in fields[kind + "s"]:
            if not item.get("roof"):
                shapes.append(_shape(item, kind, STRIP[kind]))
    return shapes


def _bank_lines(fields: dict) -> list[LineString]:
    lines: list = []
    for rw in fields["runways"]:
        if rw["winter"] == "cleared":
            for side in (1, -1):
                lines.append(rw["line"].offset_curve(side * (rw["width"] / 2 + BANK_OFFSET)))
    for taxi in fields["taxiways"]:
        if taxi["winter"] == "cleared":
            for side in (1, -1):
                lines.append(taxi["line"].offset_curve(side * (taxi["width"] / 2 + BANK_OFFSET)))
    for apron in fields["aprons"]:
        if apron["winter"] == "cleared":
            lines.append(apron["ring"].buffer(BANK_OFFSET, join_style="mitre").exterior)
    for pad in fields["helipads"]:
        if pad["winter"] == "cleared" and not pad["roof"]:
            lines.append(_shape(pad, "helipad", BANK_OFFSET).exterior)
    out = []
    for line in lines:
        out += list(getattr(line, "geoms", [line]))
    return [g for g in out if isinstance(g, LineString) and not g.is_empty]


def snowbanks(fields: dict, keep_clear) -> list[list]:
    """Ploughed snowbank lines along every cleared surface: off the surfaces themselves
    (where a taxiway joins, a bank would block it) and `keep_clear`, cut into BANK_RUN
    runs with BANK_GAP gaps."""
    surfaces = [
        _shape(x, kind, 1.5)
        for kind, xs in _kinds(
            fields["runways"], fields["taxiways"], fields["aprons"], fields["helipads"]
        )
        for x in xs
        if not x.get("roof")
    ]
    blocked = unary_union([*surfaces, *keep_clear]) if surfaces or keep_clear else None
    out: list[list] = []
    for line in _bank_lines(fields):
        pieces = line.difference(blocked) if blocked is not None else line
        if isinstance(pieces, LineString):
            pieces = [pieces]
        else:
            pieces = [g for g in getattr(pieces, "geoms", []) if isinstance(g, LineString)]
        for piece in pieces:
            at = 0.0
            while at < piece.length:
                run = substring(piece, at, min(at + BANK_RUN, piece.length))
                if run.length >= BANK_MIN:
                    out.append(np.round(np.asarray(run.coords), 2).tolist())
                at += BANK_RUN + BANK_GAP
    return out


def edge_markers(fields: dict, ground) -> list[list]:
    """Marker cones along the edges of groomed snow runways and taxiways, and at the
    corners of snow helipads: [east, north, ground]."""
    points: list[tuple[float, float]] = []

    def along(line: LineString, offset: float) -> None:
        for side in (1, -1):
            edge = line.offset_curve(side * offset)
            for g in getattr(edge, "geoms", [edge]):
                count = max(int(round(g.length / MARKER_SPACING)), 1)
                for k in range(count + 1):
                    p = g.interpolate(g.length * k / count)
                    points.append((p.x, p.y))

    for rw in fields["runways"]:
        if rw["winter"] == "groomed":
            along(rw["line"], rw["width"] / 2 + MARKER_OFFSET)
    for taxi in fields["taxiways"]:
        if taxi["winter"] == "groomed":
            along(taxi["line"], taxi["width"] / 2 + MARKER_OFFSET)
    for pad in fields["helipads"]:
        if pad["winter"] == "groomed" and not pad["roof"]:
            r = pad["size"] / 2 + MARKER_OFFSET
            t = math.radians(pad["heading"])
            for u, v in ((1, 1), (1, -1), (-1, -1), (-1, 1)):
                du = (math.sin(t) * u + math.cos(t) * v) * r
                dv = (math.cos(t) * u - math.sin(t) * v) * r
                points.append((pad["east"] + du, pad["north"] + dv))
    if not points:
        return []
    arr = np.array(points)
    g = ground(arr[:, 0], arr[:, 1])
    return [
        [round(e, 2), round(n, 2), round(float(z), 2)] for (e, n), z in zip(arr, g, strict=True)
    ]


def finish(fields: dict, ground, buildings: list[dict], keep_clear=()) -> dict:
    """The `airfields` record for features.json, on the final ground. Rooftop helipads
    are put on their building (made flat-roofed)."""
    footprints = [(b, Polygon(b["footprint"]).buffer(0)) for b in buildings if not b.get("raised")]
    helipads = []
    for pad in fields["helipads"]:
        at = Point(pad["east"], pad["north"])
        building = None
        if pad["roof"]:
            hits = [(b, fp) for b, fp in footprints if fp.contains(at)]
            if hits:
                building = max(hits, key=lambda h: h[0]["top"])[0]
                building["roof"] = None  # a helipad needs a flat roof
                building["helipad"] = True
        top = (
            building["top"]
            if building
            else float(ground(np.array([pad["east"]]), np.array([pad["north"]]))[0])
        )
        helipads.append(
            {
                **{
                    k: pad[k]
                    for k in (
                        "id",
                        "name",
                        "east",
                        "north",
                        "ring",
                        "shape",
                        "size",
                        "heading",
                        "surface",
                        "winter",
                    )
                },
                "roof": building is not None,
                "building": building["id"] if building else None,
                "top": round(top, 2),
            }
        )
    keep = [fp.buffer(1.0) for _, fp in footprints] + list(keep_clear)

    def round_line(line: LineString) -> list:
        return np.round(np.asarray(line.coords), 2).tolist()

    runways = []
    for rw in fields["runways"]:
        a, b = rw["line"].coords[0], rw["line"].coords[-1]
        z = ground(np.array([a[0], b[0]]), np.array([a[1], b[1]]))
        runways.append(
            {
                "id": rw["id"],
                "ref": "/".join(rw["designators"]),
                "designators": rw["designators"],
                "line": round_line(rw["line"]),
                "length": round(rw["line"].length, 1),
                "width": round(rw["width"], 1),
                "heading": rw["heading"],
                "surface": rw["surface"],
                "winter": rw["winter"],
                "ends": [round(float(z[0]), 2), round(float(z[1]), 2)],
                "source": rw["source"],
                # Metres added to reach the published length (see `extend_to`).
                "extended": rw["extended"],
            }
        )
    aerodromes = []
    for a in fields["aerodromes"]:
        g = float(ground(np.array([a["east"]]), np.array([a["north"]]))[0])
        aerodromes.append({**a, "ground": round(g, 1)})
    windsocks = []
    for w in fields["windsocks"]:
        g = float(ground(np.array([w["east"]]), np.array([w["north"]]))[0])
        windsocks.append({**w, "ground": round(g, 2)})
    return {
        "aerodromes": aerodromes,
        "runways": runways,
        "taxiways": [
            {
                "id": t["id"],
                "line": round_line(t["line"]),
                "width": round(t["width"], 1),
                "surface": t["surface"],
                "winter": t["winter"],
            }
            for t in fields["taxiways"]
        ],
        "aprons": [
            {
                "id": a["id"],
                "name": a["name"],
                "ring": np.round(np.asarray(a["ring"].exterior.coords)[:-1], 2).tolist(),
                "surface": a["surface"],
                "winter": a["winter"],
            }
            for a in fields["aprons"]
        ],
        "helipads": helipads,
        "windsocks": windsocks,
        "snowbanks": snowbanks(fields, keep),
        "markers": _outside(edge_markers(fields, ground), [fp for _, fp in footprints]),
    }


def _outside(points: list[list], polygons: list) -> list[list]:
    """The points not inside any of the polygons."""
    if not polygons or not points:
        return points
    tree = STRtree(polygons)
    return [p for p in points if not len(tree.query(Point(p[0], p[1]), predicate="within"))]


# --- Validation --------------------------------------------------------------------------


def slopes(line: LineString, ground, window: float = 100.0) -> dict:
    """End-to-end and steepest sustained gradient (over `window`, or a third of a short
    runway) along a centreline, in %."""
    pts, dist, _, _ = _stations(line)
    z = ground(pts[:, 0], pts[:, 1])
    span = min(window, line.length / 3)
    k = max(int(round(span / STEP)), 1)
    steepest = float(np.max(np.abs(z[k:] - z[:-k])) / (k * STEP)) if len(z) > k else 0.0
    return {
        "mean": round(100 * abs(float(z[-1] - z[0])) / max(line.length, 1e-9), 2),
        "steepest": round(100 * steepest, 2),
        "window": round(k * STEP, 1),
        "ends": [round(float(z[0]), 1), round(float(z[-1]), 1)],
    }


def cross_slope(line: LineString, half: float, ground) -> float:
    """Steepest gradient across the surface along the line, %."""
    pts, _, _, normal = _stations(line)
    left = ground(pts[:, 0] + normal[:, 0] * half, pts[:, 1] + normal[:, 1] * half)
    right = ground(pts[:, 0] - normal[:, 0] * half, pts[:, 1] - normal[:, 1] * half)
    inner = slice(2, -2) if len(pts) > 6 else slice(None)
    return round(100 * float(np.max(np.abs(left - right)[inner])) / (2 * half), 2)


def validate(fields: dict, ground, refs: tuple[RunwayRef, ...] = ()) -> list[dict]:
    """Each runway's mapped length, gradient and threshold heights against the
    published figures: the resort config's `runways` first, then OSM's `length` and
    `incline` tags, then OurAirports."""
    results = []
    for rw in fields["runways"]:
        airport = rw.get("airport")
        icao = airport.icao if airport is not None else None
        ref = next(
            (
                r
                for r in refs
                if icao
                and r.icao == icao
                and (
                    r.ref is None
                    or {_strip(x) for x in re.split(r"[/-]", r.ref)}
                    == {_strip(d) for d in rw["designators"]}
                )
            ),
            None,
        )
        published = dict(rw["published"])
        thresholds: dict[str, float] = {}
        if (our := rw.get("ourRunway")) is not None:
            for end in our.ends:
                if end.elevation is not None:
                    thresholds[end.ident] = end.elevation
        source = "osm/ourairports"
        if ref is not None:
            published["length"] = ref.length or published["length"]
            published["width"] = ref.width or published["width"]
            published["incline"] = ref.slope or published["incline"]
            if ref.elevations:
                thresholds = dict(ref.elevations)
            source = ref.source or "resort config"
        s = slopes(rw["line"], ground)
        entry = {
            "runway": rw["id"],
            "airfield": airport.name if airport is not None else None,
            "icao": icao,
            "ref": "/".join(rw["designators"]),
            "source": source,
            "length": {
                "mapped": round(rw["line"].length - rw["extended"], 1),
                "built": round(rw["line"].length, 1),
                "published": published["length"],
            },
            "width": {"mapped": round(rw["width"], 1), "published": published["width"]},
            "slope": {
                "steepest": s["steepest"],
                "mean": s["mean"],
                "window": s["window"],
                "published": published["incline"],
            },
            "crossSlope": cross_slope(rw["line"], rw["width"] / 2, ground),
            "thresholds": [],
        }
        if published["length"]:
            entry["length"]["error"] = round(rw["line"].length - published["length"], 1)
            # How far OSM's way itself is off (before any lengthening to the published).
            entry["length"]["mappedError"] = round(
                rw["line"].length - rw["extended"] - published["length"], 1
            )
        if published["incline"] is not None:
            entry["slope"]["error"] = round(s["steepest"] - abs(published["incline"]), 2)
        # By designator, or "low" / "high" for the runway's lower and upper ends.
        lower = int(np.argmin(s["ends"]))
        for i, (designator, z) in enumerate(zip(rw["designators"], s["ends"], strict=True)):
            end = "low" if i == lower else "high"
            match = next(
                (v for k, v in thresholds.items() if k == end or _same_ident(k, designator)),
                None,
            )
            if match is not None:
                entry["thresholds"].append(
                    {
                        "designator": designator,
                        "published": match,
                        "dem": z,
                        "error": round(z - match, 1),
                    }
                )
        log.info(
            "Runway %s %s: %.0f m (published %s), steepest %.1f%% over %.0f m (published %s), "
            "mean %.1f%%, cross %.1f%%",
            entry["airfield"] or rw["id"],
            entry["ref"],
            rw["line"].length,
            published["length"],
            s["steepest"],
            s["window"],
            published["incline"],
            s["mean"],
            entry["crossSlope"],
        )
        results.append(entry)
    return results


def _number_of(ident: str) -> int | None:
    """A designator's number ("04" -> 4; French altisurfaces add A / D: "10A")."""
    match = re.match(r"\s*(\d{1,2})", ident)
    return int(match.group(1)) if match else None


def _strip(ident: str) -> str:
    return ident.strip().lstrip("0").upper()
