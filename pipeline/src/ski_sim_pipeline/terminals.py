"""Lift terminals (stations), generated from the lift line alone so they work anywhere.

For each end of each lift this decides the terminal's kind and size from the lift type
and specs. It then:
- flattens a pad (and, at the top of chairs and drags, a ski-off ramp) into the
  terrain, blended into the surrounding lidar, with nearby terminals sharing one height;
- cuts buildings so nothing clips: a building that *is* the station is replaced by the
  generated terminal, and any other building loses the slice the terminal or the cable
  passes through.

Conventions (local ENU metres): `dir` is the unit vector from a terminal's bullwheel into
the line (toward the other end). `across` is the right-hand perpendicular of the
bottom-to-top direction, and the uphill track runs on its +1 side. The sim's
`LiftLine.across` uses the same convention.
"""

from __future__ import annotations

import logging
import math

import numpy as np
from shapely.geometry import LineString, MultiPolygon, Polygon
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
PAD_MARGIN = 4.0  # flat ground around the terminal (m)
FALLOFF = 14.0  # blend from the pad back into the lidar (m)
RAMP = {"length": 14.0, "drop": 2.4, "halfWidth": 4.0}
CLUSTER_DISTANCE = 45.0
CUT_MARGIN = 0.1  # terminals this close share one pad height (m)
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
        for end, at, nxt in (("bottom", b, s[1]), ("top", t, s[-2])):
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
                }
            )
    return out


def _frame(t: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return np.array([t["east"], t["north"]]), np.array(t["dir"]), np.array(t["across"])


def hall_polygon(t: dict, margin: float = 0.8) -> Polygon:
    """The station hall's footprint (what buildings are cut away from)."""
    o, d, a = _frame(t)
    w = t["width"] / 2 + margin
    corners = [
        o + d * (-t["back"] - margin) + a * -w,
        o + d * (t["length"] + margin) + a * -w,
        o + d * (t["length"] + margin) + a * w,
        o + d * (-t["back"] - margin) + a * w,
    ]
    return Polygon(corners)


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
    return (-t["back"] - PAD_MARGIN, t["length"] + PAD_MARGIN), (-w, w)


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


def cut_buildings(
    buildings: list[dict], lifts: list[dict], terminals: list[dict], roof
) -> tuple[list[dict], dict]:
    """Remove what lifts pass through. Returns (buildings, stats)."""
    halls = [hall_polygon(t) for t in terminals]
    cuts: list[tuple[Polygon, float | None]] = [(h, None) for h in halls]
    # Cable corridors: below the carriers' lowest point nothing may stand.
    by_id = {lift["id"]: lift for lift in lifts}
    for lift in by_id.values():
        kind = KIND.get(lift["type"])
        if kind is None:
            continue
        s = lift["supports"]
        width = lift["gauge"] / 2 + 2.2
        for a, b in zip(s, s[1:], strict=False):
            corridor = LineString([(a["east"], a["north"]), (b["east"], b["north"])]).buffer(
                width, cap_style="flat"
            )
            floor = min(a["top"], b["top"]) - HANG_DEPTH[kind] - 0.5
            cuts.append((corridor, floor))

    from shapely.strtree import STRtree

    tree = STRtree([c for c, _ in cuts])
    stats = {"removedAsStation": 0, "cut": 0}
    out: list[dict] = []
    for b in buildings:
        polygon = Polygon(b["footprint"])
        if not polygon.is_valid:
            polygon = polygon.buffer(0)
        top = b["top"] + ((b.get("roof") or {}).get("rise") or 0)
        hits = []
        for i in tree.query(polygon):
            shape, floor = cuts[int(i)]
            if floor is not None and top < floor:
                continue  # the cable passes well over it
            if shape.intersects(polygon) and shape.intersection(polygon).area > 0.05:
                hits.append((int(i), shape))
        if not hits:
            out.append(b)
            continue
        # Mostly inside a station hall: it *is* the station; the terminal replaces it.
        hall_area = sum(polygon.intersection(s).area for i, s in hits if i < len(halls))
        if hall_area > 0.5 * polygon.area:
            stats["removedAsStation"] += 1
            continue
        # Cut 10 cm generously: coordinates are rounded to 1 cm on output, which must not
        # creep back into the cleared space.
        remainder = polygon.difference(unary_union([s.buffer(CUT_MARGIN) for _, s in hits]))
        pieces = list(remainder.geoms) if isinstance(remainder, MultiPolygon) else [remainder]
        if any(len(p.interiors) for p in pieces if not p.is_empty):
            # A station inside a big building: slice clean through so there are no holes.
            minx, miny, maxx, maxy = polygon.bounds
            span = math.hypot(maxx - minx, maxy - miny)
            slices = []
            for i, _shape in hits:
                if i < len(halls):
                    t = terminals[i]
                    o, d, a = _frame(t)
                    w = t["width"] / 2 + 0.8
                    slices.append(
                        Polygon(
                            [
                                o + d * -span + a * -w,
                                o + d * span + a * -w,
                                o + d * span + a * w,
                                o + d * -span + a * w,
                            ]
                        )
                    )
            remainder = polygon.difference(
                unary_union([s.buffer(CUT_MARGIN) for _, s in hits] + slices)
            )
            pieces = list(remainder.geoms) if isinstance(remainder, MultiPolygon) else [remainder]
        stats["cut"] += 1
        for k, piece in enumerate(pieces):
            if piece.is_empty or piece.area < 10 or len(piece.interiors):
                continue
            ring = np.round(np.asarray(piece.exterior.coords)[:-1], 2).tolist()
            out.append(
                {
                    **b,
                    "id": b["id"] * 10 + k if len(pieces) > 1 else b["id"],
                    "footprint": ring,
                    "roof": roof(piece, b["type"]),
                }
            )
    return out, stats


def conflicts(buildings: list[dict], lifts: list[dict], terminals: list[dict]) -> list[str]:
    """Invariant check: anything still in a hall or under a cable. Empty = fine."""
    remaining, stats = cut_buildings(buildings, lifts, terminals, lambda p, k: None)
    problems = []
    if stats["removedAsStation"] or stats["cut"]:
        problems.append(
            f"{stats['removedAsStation'] + stats['cut']} buildings still intersect lift halls "
            "or cable corridors"
        )
    del remaining
    return problems
