"""Lift terminals (stations), generated from the lift line alone so they work anywhere.

For each end of each lift this decides the terminal's kind and size from the lift type
and specs. It then:
- flattens a pad (and, at the top of chairs and drags, a ski-off ramp) into the
  terrain, blended into the surrounding lidar, with nearby terminals sharing one height;
- picks each terminal's entrance side (side door or behind the bullwheel) where it's
  least built-up, and guarantees a walkway from it out to open snow;
- cuts buildings only as much as needed, as 3D volumes: the station up to its roof, the
  walkways up to head height, the cable corridor only between the carriers' lowest point
  and the rope. Whatever is above a cut stays (so a station sits in a building's ground
  floor, roofed by the rest of it); a small building that *is* the station is replaced.

Conventions (local ENU metres): `dir` is the unit vector from a terminal's bullwheel into
the line (toward the other end). `across` is the right-hand perpendicular of the
bottom-to-top direction, and the uphill track runs on its +1 side. The sim's
`LiftLine.across` uses the same convention.
"""

from __future__ import annotations

import logging
import math

import numpy as np
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from .grid import Grid

log = logging.getLogger(__name__)

KIND = {
    "chair_lift": "chair",
    "gondola": "gondola",
    "mixed_lift": "gondola",
    "cable_car": "cabin",
    "platter": "drag",
    "t-bar": "drag",
    "j-bar": "drag",
    "drag_lift": "drag",
    "rope_tow": "drag",
}
#: Speed (m/s) above which a chairlift must be detachable (fixed grips top out ~2.5 m/s).
DETACHABLE_SPEED = 3.2
PAD_MARGIN = 6.0  # flat ground around the terminal (m), past every column and footing
FALLOFF = 14.0  # blend from the pad back into the lidar (m)
RAMP = {"length": 14.0, "drop": 2.4, "halfWidth": 4.0}
CLUSTER_DISTANCE = 45.0
CUT_MARGIN = 0.1  # terminals this close share one pad height (m)
#: Station top above the pad: rope height + structure above it (canopy, roof, housing).
ROOF_ABOVE_RAIL = {"chair": 2.1, "chair-detachable": 2.6, "gondola": 1.9, "cabin": 2.7, "drag": 1.5}
#: The operator's hut stands this far out on the hall's -across side (chair and drag).
HUT_DEPTH = 3.6
#: Walkways: minimum length, how far they may tunnel through buildings, width, headroom.
WALK_MIN = 5.0
WALK_MAX = 25.0
#: Side walkways match the sim's 6 m side door; back ones its 4 m door beside the track.
#: The headroom leaves room for the name board over the door.
WALK_HALF_WIDTH = 3.0
BACK_WALK = (0.8, 4.8)
WALK_HEIGHT = 4.5
#: Building slabs thinner than this left above a cut are dropped, not floated.
MIN_SLAB = 2.0
#: Rope corridor cut piece length (m): the cut follows the rope height this finely.
CABLE_STEP = 4.0
#: How far below the cable a carrier and its load reach (m), for building clearance.
HANG_DEPTH = {"chair": 3.2, "gondola": 4.6, "cabin": 8.5, "drag": 99.0}


def detachable(lift: dict) -> bool:
    kind = KIND.get(lift["type"])
    if kind in ("gondola", "cabin"):
        return kind == "gondola"
    if kind != "chair":
        return False
    if (
        lift.get("duration")
        and lift.get("length")
        and lift["length"] / lift["duration"] > DETACHABLE_SPEED
    ):
        return True
    return (lift.get("occupancy") or 0) >= 6


def dimensions(kind: str, gauge: float, is_detachable: bool) -> dict:
    """Station hall extent along the line (`length`, in front of the bullwheel; `back`,
    behind it) and `width` across it, plus where loading/unloading happens along it."""
    r = gauge / 2
    if kind == "chair" and is_detachable:
        return {"length": 16.0, "back": r + 2.0, "width": gauge + 5.0, "load": 5.0, "unload": 4.0}
    if kind == "chair":
        return {"length": 5.0, "back": r + 1.5, "width": gauge + 3.0, "load": 3.0, "unload": 2.5}
    if kind == "gondola":
        return {"length": 20.0, "back": r + 2.5, "width": gauge + 7.0, "load": 9.0, "unload": 11.0}
    if kind == "cabin":
        return {"length": 18.0, "back": 3.0, "width": 14.0, "load": 9.0, "unload": 9.0}
    return {"length": 3.0, "back": 1.5, "width": 4.0, "load": 2.0, "unload": 1.0}


def plan(lifts: list[dict]) -> list[dict]:
    """Terminals for both ends of every lift (bottom first), before any flattening."""
    out = []
    for lift in lifts:
        kind = KIND.get(lift["type"])
        if kind is None:
            continue
        s = lift["supports"]
        b = np.array([s[0]["east"], s[0]["north"]])
        t = np.array([s[-1]["east"], s[-1]["north"]])
        along = (t - b) / max(np.hypot(*(t - b)), 1e-6)
        across = np.array([along[1], -along[0]])
        det = detachable(lift)
        dims = dimensions(kind, lift["gauge"], det)

        def beyond(at, seq, dims=dims):
            # Aim along the line, not at a tower that may sit inside the station.
            for sup in seq:
                p = np.array([sup["east"], sup["north"]])
                if np.hypot(*(p - at)) > dims["length"] + 10:
                    return sup
            return seq[-1]

        for end, at, nxt in (("bottom", b, beyond(b, s[1:])), ("top", t, beyond(t, s[-2::-1]))):
            d = np.array([nxt["east"], nxt["north"]]) - at
            d = d / max(np.hypot(*d), 1e-6)
            ramp = None
            if end == "top" and kind in ("chair", "drag"):
                ramp = {**RAMP}
            out.append(
                {
                    "lift": lift["id"],
                    "end": end,
                    "kind": kind,
                    "detachable": det,
                    "east": round(float(at[0]), 2),
                    "north": round(float(at[1]), 2),
                    "dir": [round(float(d[0]), 5), round(float(d[1]), 5)],
                    "across": [round(float(across[0]), 5), round(float(across[1]), 5)],
                    "gauge": lift["gauge"],
                    **dims,
                    "ramp": ramp,
                    "hut": kind in ("chair", "drag"),
                    "roofTop": round(_rail(kind) + ROOF_ABOVE_RAIL[_roof_key(kind, det)], 2),
                }
            )
    return out


def _rail(kind: str) -> float:
    from .approach import RAIL

    return RAIL[kind]


def _roof_key(kind: str, det: bool) -> str:
    return "chair-detachable" if kind == "chair" and det else kind


def _frame(t: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return np.array([t["east"], t["north"]]), np.array(t["dir"]), np.array(t["across"])


def hall_polygon(t: dict, margin: float = 0.8) -> Polygon:
    """The station hall's footprint (what buildings are cut away from)."""
    o, d, a = _frame(t)
    w = t["width"] / 2 + margin
    w_hut = w + (HUT_DEPTH if t.get("hut") else 0.0)
    return _rect(t, -t["back"] - margin, t["length"] + margin, -w_hut, w)


def _rect(t: dict, u0: float, u1: float, v0: float, v1: float) -> Polygon:
    """Rectangle in a terminal's (u along dir, v along across) frame."""
    o, d, a = _frame(t)
    return Polygon(
        [o + d * u0 + a * v0, o + d * u1 + a * v0, o + d * u1 + a * v1, o + d * u0 + a * v1]
    )


def _rect_stamp(
    heights: np.ndarray,
    grid: Grid,
    origin: np.ndarray,
    d: np.ndarray,
    a: np.ndarray,
    u_range: tuple[float, float],
    v_range: tuple[float, float],
    target,
    protect=None,
) -> None:
    """Blend `target(u, v)` into the heightmap over an oriented rectangle (u along `d`,
    v along `a`), fading out over FALLOFF beyond its edges."""
    reach = max(abs(u_range[0]), abs(u_range[1])) + max(abs(v_range[0]), abs(v_range[1]))
    reach += FALLOFF + 2
    ext = grid.extent
    c0 = max(int((origin[0] - reach - ext.west) / grid.cell_size), 0)
    c1 = min(int((origin[0] + reach - ext.west) / grid.cell_size) + 1, grid.width - 1)
    r0 = max(int((ext.north - (origin[1] + reach)) / grid.cell_size), 0)
    r1 = min(int((ext.north - (origin[1] - reach)) / grid.cell_size) + 1, grid.height - 1)
    if c0 > c1 or r0 > r1:
        return
    cols = np.arange(c0, c1 + 1)
    rows = np.arange(r0, r1 + 1)
    east = ext.west + cols[np.newaxis, :] * grid.cell_size
    north = ext.north - rows[:, np.newaxis] * grid.cell_size
    de, dn = east - origin[0], north - origin[1]
    u = de * d[0] + dn * d[1]
    v = de * a[0] + dn * a[1]
    du = np.maximum(np.maximum(u_range[0] - u, u - u_range[1]), 0)
    dv = np.maximum(np.maximum(v_range[0] - v, v - v_range[1]), 0)
    outside = np.hypot(du, dv)
    x = np.clip(outside / FALLOFF, 0, 1)
    weight = 1 - x * x * (3 - 2 * x)
    block = heights[r0 : r1 + 1, c0 : c1 + 1]
    goal = target(np.clip(u, *u_range), np.clip(v, *v_range))
    if protect is not None:
        weight = weight * ~protect(east + 0 * north, north + 0 * east)
    heights[r0 : r1 + 1, c0 : c1 + 1] = block + (goal - block) * weight


def _pad_ranges(t: dict) -> tuple[tuple[float, float], tuple[float, float]]:
    w = t["width"] / 2 + PAD_MARGIN
    hut = HUT_DEPTH if t.get("hut") else 0.0
    return (-t["back"] - PAD_MARGIN, t["length"] + PAD_MARGIN), (-w - hut, w)


def flatten(terminals: list[dict], heights: np.ndarray, grid: Grid, ground) -> None:
    """Flatten pads (and carve top ramps) in place; sets each terminal's `pad` height."""
    # Pad height: median ground under the pad, shared across nearby terminals.
    for t in terminals:
        o, d, a = _frame(t)
        (u0, u1), (v0, v1) = _pad_ranges(t)
        us, vs = np.meshgrid(np.linspace(u0, u1, 9), np.linspace(v0, v1, 5))
        e = o[0] + us * d[0] + vs * a[0]
        n = o[1] + us * d[1] + vs * a[1]
        t["_median"] = float(np.median(ground(e.ravel(), n.ravel())))
    parent = list(range(len(terminals)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, ti in enumerate(terminals):
        for j in range(i + 1, len(terminals)):
            tj = terminals[j]
            if math.hypot(ti["east"] - tj["east"], ti["north"] - tj["north"]) < CLUSTER_DISTANCE:
                parent[find(i)] = find(j)
    clusters: dict[int, list[dict]] = {}
    for i, t in enumerate(terminals):
        clusters.setdefault(find(i), []).append(t)
    for members in clusters.values():
        level = float(np.median([m["_median"] for m in members]))
        for m in members:
            m["pad"] = round(level, 2)
            del m["_median"]

    for t in terminals:
        o, d, a = _frame(t)
        u_range, v_range = _pad_ranges(t)
        _rect_stamp(heights, grid, o, d, a, u_range, v_range, lambda u, v, p=t["pad"]: p + 0 * u)
    # Ramps after pads so a neighbouring pad can't flatten them away.
    for t in terminals:
        ramp = t["ramp"]
        if not ramp:
            continue
        o, d, a = _frame(t)
        # From the unload point (inside the hall, on the uphill track's side) out under
        # the bullwheel and beyond, dropping away so the chair passes overhead.
        centre = t["gauge"] / 2
        u_start, u_end = t["unload"], -t["back"] - ramp["length"]
        u_range = (u_end, u_start)
        v_range = (centre - ramp["halfWidth"], centre + ramp["halfWidth"])

        def slope(u, v, t=t, ramp=ramp, u_start=u_start, u_end=u_end):
            fraction = np.clip((u_start - u) / (u_start - u_end), 0, 1)
            return t["pad"] - ramp["drop"] * fraction

        others = [x for x in terminals if x is not t]
        _rect_stamp(
            heights,
            grid,
            o,
            d,
            a,
            u_range,
            v_range,
            slope,
            lambda e, n, o=others: _on_pads(o, e, n),
        )


def _on_pads(terminals: list[dict], east: np.ndarray, north: np.ndarray) -> np.ndarray:
    """Mask of points on any of these terminals' pads (which other ramps must not carve)."""
    mask = np.zeros(east.shape, dtype=bool)
    for t in terminals:
        o, d, a = _frame(t)
        if abs(t["east"] - float(east.mean())) > 400 or abs(t["north"] - float(north.mean())) > 400:
            continue
        (u0, u1), (v0, v1) = _pad_ranges(t)
        de, dn = east - o[0], north - o[1]
        u = de * d[0] + dn * d[1]
        v = de * a[0] + dn * a[1]
        mask |= (u >= u0) & (u <= u1) & (v >= v0) & (v <= v1)
    return mask


# --- Entrances and walkways -------------------------------------------------------------


def _walk_rect(t: dict, side: str, length: float) -> Polygon:
    """A walkway `length` m long from the station out to the snow, on `side`."""
    w = t["width"] / 2
    r = t["gauge"] / 2
    at = t["load"] if t["end"] == "bottom" else t["unload"]
    if side == "side":
        return _rect(t, at - WALK_HALF_WIDTH, at + WALK_HALF_WIDTH, w, w + length)
    if side == "back":
        # Behind the bullwheel, beside the uphill track (outside the carriers' loop).
        return _rect(t, -t["back"] - length, -t["back"], r + BACK_WALK[0], r + BACK_WALK[1])
    ramp = t["ramp"]
    return _rect(
        t, -t["back"] - ramp["length"], t["unload"], r - ramp["halfWidth"], r + ramp["halfWidth"]
    )


def _blocked(polygon: Polygon, tree, footprints: list[Polygon]) -> float:
    hits = [footprints[int(i)] for i in tree.query(polygon)]
    if not hits or polygon.area <= 0:  # degenerate walkway (zero-length ramp)
        return 0.0
    return unary_union([h.intersection(polygon) for h in hits]).area / polygon.area


def choose_entrances(terminals: list[dict], buildings: list[dict]) -> None:
    """Set each terminal's `entrance` (bottom) / exit (top) side and walkway length.

    Candidates: a door/gate in the side of the hall at the loading point, or a way in from
    behind the bullwheel. The least built-up wins (ties: side). Chair and drag tops always
    exit down the ski-off ramp. The walkway runs WALK_MIN m, extended (tunnelling through
    buildings) until it reaches open snow, up to WALK_MAX.
    """
    from shapely.strtree import STRtree

    footprints = [Polygon(b["footprint"]).buffer(0) for b in buildings]
    tree = STRtree(footprints)
    for t in terminals:
        if t["end"] == "top" and t["ramp"]:
            t["entrance"] = "ramp"
            t["walk"] = t["ramp"]["length"]
            continue
        scores = {
            side: _blocked(_walk_rect(t, side, 12.0), tree, footprints) for side in ("side", "back")
        }
        side = "side" if scores["side"] <= scores["back"] + 0.05 else "back"
        length = WALK_MIN
        while length < WALK_MAX:
            ahead = _walk_rect(t, side, length + 2).difference(_walk_rect(t, side, length))
            if _blocked(ahead, tree, footprints) < 0.05:
                break
            length += 2
        t["entrance"] = side
        t["walk"] = round(length + 2, 1)


# --- Volumetric building cuts -----------------------------------------------------------

NO_FLOOR = -1e9
# Halls and the rope corridor clear a building's full height: a station or a line roofed
# over by the storeys above it read as an archway or tunnel through the block.
NO_CEILING = 1e9
# Leftover building pieces narrower than this are dropped (slices beside a cut), and a
# cut building keeping less than MIN_KEPT of its footprint goes altogether: what's left of
# a small building beside a station reads as a stray wall, not a building.
MIN_PIECE_WIDTH = 5.0
MIN_KEPT = 0.35


def cut_volumes(
    lifts: list[dict], terminals: list[dict]
) -> list[tuple[Polygon, float, float, str]]:
    """Spaces lifts need: (footprint, from height, to height, what)."""
    cuts = []
    for t in terminals:
        cuts.append((hall_polygon(t), NO_FLOOR, NO_CEILING, "hall"))
        side = t.get("entrance")
        if side:
            cuts.append(
                (_walk_rect(t, side, t["walk"]), NO_FLOOR, t["pad"] + WALK_HEIGHT, "walkway")
            )
    for lift in lifts:
        kind = KIND.get(lift["type"])
        if kind is None:
            continue
        s = lift["supports"]
        width = lift["gauge"] / 2 + 2.2
        for a, b in zip(s, s[1:], strict=False):
            ax, ay, bx, by = a["east"], a["north"], b["east"], b["north"]
            span = math.hypot(bx - ax, by - ay)
            if span < 1e-3:
                continue
            # The rope is level through a station, then runs straight to the next support.
            # Cut in short pieces that follow it, so a climbing rope doesn't slice a tall
            # wedge out of every building it passes over.
            level_a = _station_length(a, terminals)
            level_b = span - _station_length(b, terminals)

            def rope(d, a=a, b=b, span=span, level_a=level_a, level_b=level_b):
                if level_b <= level_a:
                    return a["top"] + (b["top"] - a["top"]) * d / span
                f = min(max((d - level_a) / (level_b - level_a), 0.0), 1.0)
                return a["top"] + (b["top"] - a["top"]) * f

            n = max(1, math.ceil(span / CABLE_STEP))
            for k in range(n):
                d0, d1 = span * k / n, span * (k + 1) / n
                piece = LineString(
                    [
                        (ax + (bx - ax) * d0 / span, ay + (by - ay) * d0 / span),
                        (ax + (bx - ax) * d1 / span, ay + (by - ay) * d1 / span),
                    ]
                ).buffer(width, cap_style="flat")
                hs = [rope(d) for d in (d0, d1, level_a, level_b) if d0 <= d <= d1]
                low = NO_FLOOR if kind == "drag" else min(hs) - HANG_DEPTH[kind] - 0.5
                cuts.append((piece, low, NO_CEILING, "cable"))
    return cuts


def station_halls(terminals: list[dict]) -> list[tuple[Polygon, float]]:
    """Each terminal's hall footprint and roof height, to tell which building *is* it."""
    return [(hall_polygon(t), t["pad"] + t["roofTop"] + 0.6) for t in terminals]


def _station_length(support: dict, terms: list[dict]) -> float:
    """How far the rope runs level from this support (its terminal's hall), else 0."""
    if support.get("kind") != "station":
        return 0.0
    for t in terms:
        if math.hypot(t["east"] - support["east"], t["north"] - support["north"]) < 1.0:
            return t["length"]
    return 0.0


def _split_holes(polygon: Polygon) -> list[Polygon]:
    """Rings can't have holes in the renderer: cut through each hole until none remain."""
    if polygon.is_empty:
        return []
    if not polygon.interiors:
        return [polygon]
    from shapely.ops import split

    hole = Polygon(polygon.interiors[0])
    cx = hole.centroid.x
    minx, miny, maxx, maxy = polygon.bounds
    parts = split(polygon, LineString([(cx, miny - 1), (cx, maxy + 1)]))
    out: list[Polygon] = []
    for g in parts.geoms:
        if isinstance(g, Polygon):
            out += _split_holes(g)
    return out


def _polygons(geom) -> list[Polygon]:
    # Drop the collinear vertices left where neighbouring cut pieces meet.
    geom = geom.simplify(0.02, preserve_topology=True)
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return _split_holes(geom)
    out: list[Polygon] = []
    for g in getattr(geom, "geoms", []):
        if isinstance(g, Polygon):
            out += _split_holes(g)
    return out


def _full_top(b: dict) -> float:
    return b["top"] + ((b.get("roof") or {}).get("rise") or 0.0)


def _clip_roof(roof: dict | None, piece: Polygon) -> dict | None:
    if not roof:
        return None
    faces = []
    for face in roof["faces"]:
        for part in _polygons(Polygon(face).buffer(0).intersection(piece)):
            if part.area > 0.05:
                faces.append(np.round(np.asarray(part.exterior.coords)[:-1], 2).tolist())
    return {**roof, "faces": faces} if faces else None


def cut_buildings(
    buildings: list[dict], cuts: list[tuple], halls: list[tuple[Polygon, float]] = ()
):
    """Apply volumetric `cuts` to buildings. Returns (buildings, stats).

    A building mostly inside a station hall (`halls`) and not much taller than it *is*
    the station: it's replaced by the generated terminal. Otherwise each building is
    split: what's outside a cut stays as it was; inside it, anything below the cut's
    floor stays (flat-topped) and anything above its ceiling stays as a raised piece
    (keeping its original roof), unless it would be a sliver thinner than MIN_SLAB. Halls
    and the rope corridor have no ceiling, so they leave a notch, never an archway; only
    a walkway can pass under a building. Pieces narrower than MIN_PIECE_WIDTH go, and so
    does a cut building left with under MIN_KEPT of its footprint.
    """
    from shapely.strtree import STRtree

    tree = STRtree([c[0] for c in cuts])
    stats = {"removedAsStation": 0, "cut": 0, "raisedPieces": 0}
    out: list[dict] = []
    for b in buildings:
        polygon = Polygon(b["footprint"]).buffer(0)
        top = _full_top(b)
        for hall, roof in halls:
            if polygon.intersection(hall).area > 0.5 * polygon.area and top <= roof + 3:
                stats["removedAsStation"] += 1
                break
        else:
            pieces = [
                {
                    "polygon": polygon,
                    "base": b["base"],
                    "top": b["top"],
                    "roof": b.get("roof"),
                    "raised": False,
                }
            ]
            touched = False
            for i in tree.query(polygon):
                shape, z0, z1, _ = cuts[int(i)]
                margin_shape = shape.buffer(CUT_MARGIN, join_style=2)
                next_pieces = []
                for p in pieces:
                    p_top = p["top"] + ((p["roof"] or {}).get("rise") or 0.0)
                    inside = p["polygon"].intersection(margin_shape)
                    if z0 >= p_top or z1 <= p["base"] or inside.area < 0.05:
                        next_pieces.append(p)
                        continue
                    touched = True
                    for q in _polygons(p["polygon"].difference(margin_shape)):
                        next_pieces.append({**p, "polygon": q, "roof": _clip_roof(p["roof"], q)})
                    for q in _polygons(inside):
                        if z0 > p["base"] + 1.0:  # below the cut: flat-topped stub
                            stub_top = min(p["top"], z0)
                            roof = _clip_roof(p["roof"], q) if z0 >= p_top else None
                            next_pieces.append({**p, "polygon": q, "top": stub_top, "roof": roof})
                        if z1 < p["top"] and p_top - z1 >= MIN_SLAB:  # above it: raised
                            next_pieces.append(
                                {
                                    **p,
                                    "polygon": q,
                                    "base": max(z1, p["base"]),
                                    "roof": _clip_roof(p["roof"], q),
                                    "raised": True,
                                }
                            )
                pieces = next_pieces
            if not touched:
                out.append(b)
                continue
            stats["cut"] += 1
            kept = [
                p
                for p in pieces
                if p["polygon"].area >= 4
                and not p["polygon"].buffer(-MIN_PIECE_WIDTH / 2, join_style=2).is_empty
            ]
            ground = [p for p in kept if not p["raised"]]
            if sum(p["polygon"].area for p in ground) < MIN_KEPT * polygon.area:
                stats["removedAsSliver"] = stats.get("removedAsSliver", 0) + 1
                continue
            for k, p in enumerate(kept):
                stats["raisedPieces"] += p["raised"]
                out.append(
                    {
                        **b,
                        "id": b["id"] * 100 + k,
                        "footprint": np.round(
                            np.asarray(p["polygon"].exterior.coords)[:-1], 2
                        ).tolist(),
                        "base": round(p["base"], 2),
                        "top": round(p["top"], 2),
                        "roof": p["roof"],
                        "raised": p["raised"],
                    }
                )
    return out, stats


def conflicts(buildings: list[dict], cuts: list[tuple]) -> list[str]:
    """Invariant: no building volume overlaps a lift's space. Empty = fine."""
    from shapely.strtree import STRtree

    tree = STRtree([c[0] for c in cuts])
    bad: dict[str, int] = {}
    for b in buildings:
        polygon = Polygon(b["footprint"]).buffer(0)
        lo, hi = b["base"], _full_top(b)
        for i in tree.query(polygon):
            shape, z0, z1, what = cuts[int(i)]
            if min(hi, z1) - max(lo, z0) > 0.05 and polygon.intersection(shape).area > 0.05:
                bad[what] = bad.get(what, 0) + 1
                break
    return [f"{n} buildings intrude on lift {what} space" for what, n in bad.items()]
