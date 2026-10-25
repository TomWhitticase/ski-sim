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
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from . import rope
from .config import Extent
from .grid import Grid, sample_bilinear

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
#: Storeys over a walkway stay only as an arcade: with the building still standing at
#: ground level along both sides of it, at least ARCADE_COVER of a strip this wide (m).
#: Otherwise the walkway is open to the sky: a block floating over the door on nothing
#: but the station reads as a tunnel.
ARCADE_FLANK = 3.0
ARCADE_COVER = 0.6
#: Building slabs thinner than this left above a cut are dropped, not floated.
MIN_SLAB = 2.0
#: Rope corridor cut piece length (m): the cut follows the rope height this finely.
CABLE_STEP = 4.0
#: How far below the cable a carrier and its load reach (m), for building clearance.
HANG_DEPTH = {"chair": 3.2, "gondola": 4.6, "cabin": 8.5, "drag": 99.0}
#: A building the station hall covers at least this much of is the station's own
#: building (OSM maps most of them as plain `building=yes`, with the lift's end node,
#: the bullwheel, inside). Bigger footprints are residences the station is set into.
STATION_OVERLAP = 0.4
STATION_BUILDING_MAX_AREA = 2500.0
#: A gondola or cable car hall grows to fill its building, up to this (m): behind the
#: bullwheel, in front of it, and either side of the line.
HALL_GROW = {"back": 12.0, "length": 36.0, "half": 8.0}
#: Station buildings are low whatever their footprint area: this much above the pad.
STATION_HEIGHT = 8.0
#: A chair station's shell is cut only round the hood itself: this far either side of
#: the tracks (the hood's half-width is the gauge's plus 1.7 m). A building smaller than
#: this share of the hall can't hold the hood: it's replaced by the terminal instead.
HOOD_CLEARANCE = 2.2
SHELL_MIN_AREA = 0.6


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
    """Flatten pads (and carve top ramps) in place; sets each terminal's `pad` height.
    Keeps a window of the ground as it was round each terminal (`_original`), for the
    retaining walls placed later (`retaining_walls`)."""
    for t in terminals:
        _keep_original(t, heights, grid)
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


# --- Retaining walls ---------------------------------------------------------------------

#: Pad edges cut into the slope by more than WALL_MIN (m) get a stone retaining wall
#: instead of a long smooth bank (the Cascades bottom station). Only cuts: a pad built up
#: on fill keeps its snow bank (walls standing proud of it read as stray blocks, and
#: restoring the ground behind them dug pits at the pad's corners), and only the back and
#: sides (the line leaves over the front). Deeper than WALL_MAX it's left as a bank.
WALL_MIN = 2.0
WALL_MAX = 10.0
WALL_STEP = 2.0
#: The original ground is read this far outside the pad edge.
WALL_PROBE = 3.0
#: Shorter runs than this many samples (WALL_STEP apart) aren't worth a wall.
WALL_MIN_RUN = 4
#: A fill wall stands this far above the pad (a parapet); a cut wall this far above the
#: ground it holds back.
WALL_PARAPET = 1.0
WALL_CAP = 0.3
#: Keep walls this far clear of a walkway, a ramp, a run and the rope's corridor (m).
WALL_CLEAR = 1.0
#: The original-ground window kept round each terminal (m).
ORIGINAL_REACH = 130.0


def _keep_original(t: dict, heights: np.ndarray, grid: Grid) -> None:
    cell = grid.cell_size
    ext = grid.extent
    c0 = max(int((t["east"] - ORIGINAL_REACH - ext.west) / cell), 0)
    c1 = min(int((t["east"] + ORIGINAL_REACH - ext.west) / cell) + 1, grid.width - 1)
    r0 = max(int((ext.north - (t["north"] + ORIGINAL_REACH)) / cell), 0)
    r1 = min(int((ext.north - (t["north"] - ORIGINAL_REACH)) / cell) + 1, grid.height - 1)
    if c0 >= c1 or r0 >= r1:
        return
    west = ext.west + c0 * cell
    north = ext.north - r0 * cell
    sub = Grid(Extent(west, west + (c1 - c0) * cell, north - (r1 - r0) * cell, north), cell)
    t["_original"] = (sub, heights[r0 : r1 + 1, c0 : c1 + 1].copy())


def _original_at(t: dict, east, north):
    sub, patch = t["_original"]
    return sample_bilinear(patch, sub, east, north)


def retaining_walls(
    terminals: list[dict],
    heights: np.ndarray,
    grid: Grid,
    ground,
    buildings: list[dict],
    runs: list = (),
) -> dict:
    """Retaining walls along pad edges cut or filled more than WALL_MIN deep. Behind each
    wall the original slope is restored (the pad's smooth bank is replaced by the wall),
    and the buildings there re-seated. Never where a run, the walkway, the ski-off ramp
    or the rope comes in, nor on another terminal's pad. Sets `walls` on each terminal:
    [u0, v0, u1, v1, bottom, top] in its frame, heights above the pad."""
    from shapely.strtree import STRtree

    run_tree = STRtree(list(runs)) if runs else None
    footprints = [Polygon(b["footprint"]).buffer(0) for b in buildings]
    building_tree = STRtree(footprints) if footprints else None
    stats = {"cut": 0, "fill": 0, "metres": 0.0}
    for t in terminals:
        t["walls"] = []
        if "_original" not in t:
            continue
        o, d, a = _frame(t)
        (u0, u1), (v0, v1) = _pad_ranges(t)
        keep_out = _wall_keep_out(t, terminals)
        if run_tree is not None:
            pad = _rect(t, u0, u1, v0, v1).buffer(WALL_PROBE + 2)
            keep_out += [runs[int(i)] for i in run_tree.query(pad)]
        blocked = unary_union(keep_out) if keep_out else Polygon()
        # The four edges: (fixed coordinate, axis it runs along, outward sign).
        edges = (("u", u0, (v0, v1), -1), ("v", v1, (u0, u1), 1), ("v", v0, (u0, u1), -1))
        for axis, fixed, (lo, hi), sign in edges:
            n = max(int((hi - lo) / WALL_STEP), 1)
            along = lo + (np.arange(n) + 0.5) * (hi - lo) / n
            if axis == "u":
                us, vs = np.full(n, fixed), along
                ue, ve = us + sign * WALL_PROBE, vs
            else:
                us, vs = along, np.full(n, fixed)
                ue, ve = us, vs + sign * WALL_PROBE
            e = o[0] + ue * d[0] + ve * a[0]
            nn = o[1] + ue * d[1] + ve * a[1]
            depth = _original_at(t, e, nn) - t["pad"]
            kind = np.where(depth > WALL_MIN, 1, 0)
            kind[np.abs(depth) > WALL_MAX] = 0
            ew = o[0] + us * d[0] + vs * a[0]
            nw = o[1] + us * d[1] + vs * a[1]
            for k in range(n):
                if kind[k] and blocked.distance(Point(ew[k], nw[k])) < WALL_CLEAR + WALL_STEP / 2:
                    kind[k] = 0
            k = 0
            while k < n:
                if not kind[k]:
                    k += 1
                    continue
                k1 = k
                while k1 + 1 < n and kind[k1 + 1] == kind[k]:
                    k1 += 1
                if k1 - k + 1 >= WALL_MIN_RUN:
                    _wall_run(t, heights, grid, axis, fixed, sign, along, depth, k, k1, kind[k])
                    stats["cut" if kind[k] > 0 else "fill"] += 1
                    stats["metres"] += (k1 - k + 1) * (hi - lo) / n
                k = k1 + 1
        if t["walls"] and building_tree is not None:
            _reseat(t, buildings, footprints, building_tree, ground)
    for t in terminals:
        t.pop("_original", None)
    stats["metres"] = round(stats["metres"])
    return stats


def _wall_keep_out(t: dict, terminals: list[dict]) -> list:
    """Where a wall mustn't stand: other pads, the walkway, the ramp, the rope's way."""
    out = []
    for other in terminals:
        if other is t:
            continue
        if abs(other["east"] - t["east"]) + abs(other["north"] - t["north"]) > 2 * ORIGINAL_REACH:
            continue
        (ou0, ou1), (ov0, ov1) = _pad_ranges(other)
        out.append(_rect(other, ou0, ou1, ov0, ov1))
    if t.get("entrance") and t["entrance"] != "ramp":
        out.append(_walk_rect(t, t["entrance"], t.get("walk", WALK_MIN) + 6))
    if t["ramp"]:
        r = t["gauge"] / 2
        ramp = t["ramp"]
        out.append(
            _rect(
                t,
                -t["back"] - ramp["length"] - 6,
                t["unload"],
                r - ramp["halfWidth"],
                r + ramp["halfWidth"],
            )
        )
    # Carriers leave over the front edge (and, on a loop, the whole width of the line).
    half = t["gauge"] / 2 + 3.0
    out.append(_rect(t, t["length"], t["length"] + 40, -half, half))
    return out


def _wall_run(t, heights, grid, axis, fixed, sign, along, depth, k0, k1, kind) -> None:
    """One wall from sample k0 to k1 along an edge; restores the original slope behind it."""
    o, d, a = _frame(t)
    step = along[1] - along[0] if len(along) > 1 else WALL_STEP
    lo, hi = along[k0] - step / 2, along[k1] + step / 2
    for k in range(k0, k1 + 1):
        s0, s1 = along[k] - step / 2, along[k] + step / 2
        if kind > 0:  # cut: from below the pad to just above the ground it holds back
            bottom, top = -0.5, float(depth[k]) + WALL_CAP
        else:  # fill: from the ground below up to a parapet over the pad
            bottom, top = float(depth[k]) - 0.5, WALL_PARAPET
        seg = [fixed, s0, fixed, s1] if axis == "u" else [s0, fixed, s1, fixed]
        t["walls"].append([round(x, 2) for x in (*seg, bottom, top)] + [int(kind)])
    # Behind the wall the ground is the original slope again, right up to the wall: the
    # pad's bank (FALLOFF) is replaced by the wall.
    cell = grid.cell_size
    reach = FALLOFF + cell
    if axis == "u":
        u_range = (fixed, fixed + sign * reach) if sign > 0 else (fixed - reach, fixed)
        v_range = (lo, hi)
    else:
        u_range = (lo, hi)
        v_range = (fixed, fixed + sign * reach) if sign > 0 else (fixed - reach, fixed)
    ext = grid.extent
    corners = [o + d * u + a * v for u in u_range for v in v_range]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    c0 = max(int((min(xs) - ext.west) / cell), 0)
    c1 = min(int((max(xs) - ext.west) / cell) + 1, grid.width - 1)
    r0 = max(int((ext.north - max(ys)) / cell), 0)
    r1 = min(int((ext.north - min(ys)) / cell) + 1, grid.height - 1)
    if c0 > c1 or r0 > r1:
        return
    east = ext.west + np.arange(c0, c1 + 1)[np.newaxis, :] * cell
    north = ext.north - np.arange(r0, r1 + 1)[:, np.newaxis] * cell
    east, north = np.broadcast_arrays(east, north)
    de, dn = east - o[0], north - o[1]
    u = de * d[0] + dn * d[1]
    v = de * a[0] + dn * a[1]
    inside = (
        (u > min(u_range) + 1e-6) & (u <= max(u_range)) & (v >= min(v_range)) & (v <= max(v_range))
    )
    if axis == "u":
        inside &= sign * (u - fixed) > 0
    else:
        inside &= sign * (v - fixed) > 0
    original = _original_at(t, east, north)
    block = heights[r0 : r1 + 1, c0 : c1 + 1]
    block[inside] = original[inside]


def _reseat(t, buildings, footprints, tree, ground) -> None:
    """Put buildings near a terminal's walls back on the ground (it changed under them)."""
    reach = max(t["back"], t["length"]) + t["width"] + PAD_MARGIN + FALLOFF + HUT_DEPTH
    for i in tree.query(Point(t["east"], t["north"]).buffer(reach)):
        b = buildings[int(i)]
        if b.get("raised"):
            continue
        ring = np.asarray(b["footprint"])
        g = ground(ring[:, 0], ring[:, 1])
        base = round(float(g.min()) - 1.0, 2)
        shift = base - b["base"]
        if abs(shift) > 0.05:
            b["base"] = base
            b["top"] = round(b["top"] + shift, 2)


# --- Station buildings ------------------------------------------------------------------


def adopt_station_buildings(
    terminals: list[dict], buildings: list[dict], heights: np.ndarray, grid: Grid, ground
) -> dict:
    """Recognise the buildings that *are* stations by geometry, and fit each station to
    its building. OSM maps the station building as `building=yes` far more often than
    `aerialway=station`, with the lift's end node (the bullwheel) inside it; cut as any
    other building, its ground floor went and its storeys hovered over the hood.

    A building the hall covers STATION_OVERLAP of (or that sits mostly inside the hall)
    is the station's, unless it's a residence (STATION_BUILDING_MAX_AREA, or an OSM
    height well above the station's roof: then the station is set into it as before).
    - It's station-height (STATION_HEIGHT above the pad, or clear of the hood) when its
      height was estimated: from the footprint area a 1,400 m² gondola station came out
      five storeys tall.
    - A gondola or cable car hall grows to fill the building (`HALL_GROW`): the glazed
      hall then is the building, and whatever footprint is left beyond it is cut as
      usual. The pad grows with it, and buildings round it are re-seated.
    - A chair station keeps the building as its shell (`shell` on the building): the hood
      stands inside, the walls stay (only the hood's own volume, the rope portal and the
      entrance are cut), and the sim doesn't collide with it. A building too small to
      hold the hood (SHELL_MIN_AREA) is replaced by the terminal, as before.
    Returns counts.
    """
    from shapely.strtree import STRtree

    footprints = [Polygon(b["footprint"]).buffer(0) for b in buildings]
    tree = STRtree(footprints)
    stats = {"stationHeight": 0, "grown": 0, "shells": 0}
    for t in terminals:
        hall = hall_polygon(t, 0.0)
        best = None
        for i in tree.query(hall):
            i = int(i)
            b = buildings[i]
            fp = footprints[i]
            if (
                fp.area > STATION_BUILDING_MAX_AREA
                or b.get("raised")
                or b.get("use") == "restaurant"
            ):
                continue
            inter = fp.intersection(hall).area
            if inter < STATION_OVERLAP * hall.area and inter < 0.5 * fp.area:
                continue
            if b["heightSource"] != "estimate" and _full_top(b) > t["pad"] + t["roofTop"] + 6:
                continue
            if best is None or inter > best[1]:
                best = (i, inter)
        if best is None:
            continue
        i, inter = best
        b, fp = buildings[i], footprints[i]
        # Clad like a station, not a residence (the sim's facade style), and the hall
        # matching it.
        b["use"] = "station"
        t["housing"] = "building"
        if t["kind"] in ("gondola", "cabin"):
            if _grow_hall(t, fp, heights, grid, ground, buildings, tree):
                stats["grown"] += 1
        elif t["kind"] == "chair" and fp.area >= SHELL_MIN_AREA * hall.area:
            b["shell"] = True
            stats["shells"] += 1
        clear = station_top(t) + ROOF_GAP + MIN_SLAB + 0.5
        if b["heightSource"] == "estimate":
            b["top"] = round(t["pad"] + max(STATION_HEIGHT, clear), 2)
            stats["stationHeight"] += 1
        elif b.get("shell"):
            b["top"] = max(b["top"], round(t["pad"] + clear, 2))
    return stats


def _grow_hall(t, fp: Polygon, heights, grid: Grid, ground, buildings: list[dict], tree) -> bool:
    """Extend a hall's footprint to its building's (within HALL_GROW), re-stamp its pad
    and re-seat the buildings round it on the new ground. False if nothing changed."""
    o, d, a = _frame(t)
    pts = np.asarray(fp.exterior.coords)
    u = (pts[:, 0] - o[0]) * d[0] + (pts[:, 1] - o[1]) * d[1]
    v = (pts[:, 0] - o[0]) * a[0] + (pts[:, 1] - o[1]) * a[1]
    back = round(min(max(t["back"], -float(u.min())), HALL_GROW["back"]), 2)
    length = round(min(max(t["length"], float(u.max())), HALL_GROW["length"]), 2)
    half = min(
        max(t["width"] / 2, float(max(-v.min(), v.max()))), t["gauge"] / 2 + HALL_GROW["half"]
    )
    width = round(2 * half, 2)
    if (back, length, width) == (t["back"], t["length"], t["width"]):
        return False
    t.update(back=back, length=length, width=width)
    reach = max(back, length) + half + PAD_MARGIN + HUT_DEPTH + FALLOFF + 2
    near = [int(i) for i in tree.query(Point(o).buffer(reach))]
    before = {}
    for i in near:
        ring = np.asarray(buildings[i]["footprint"])
        before[i] = ground(ring[:, 0], ring[:, 1])
    u_range, v_range = _pad_ranges(t)
    _rect_stamp(heights, grid, o, d, a, u_range, v_range, lambda u, v, p=t["pad"]: p + 0 * u)
    for i in near:
        b = buildings[i]
        if b.get("raised"):
            continue
        ring = np.asarray(b["footprint"])
        after = ground(ring[:, 0], ring[:, 1])
        b["top"] = round(b["top"] + float(after.mean() - before[i].mean()), 2)
        b["base"] = round(float(after.min()) - 1.0, 2)
    return True


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


def _walk_flanks(t: dict, side: str, length: float) -> tuple[Polygon, Polygon]:
    """Strips ARCADE_FLANK wide either side of a walkway, along its whole length: where
    a building must still stand at ground level for its storeys over the walkway to
    stay (an arcade)."""
    w = t["width"] / 2
    r = t["gauge"] / 2
    f = ARCADE_FLANK
    if side == "side":
        at = t["load"] if t["end"] == "bottom" else t["unload"]
        u0, u1, v0, v1 = at - WALK_HALF_WIDTH, at + WALK_HALF_WIDTH, w, w + length
        return _rect(t, u0 - f, u0, v0, v1), _rect(t, u1, u1 + f, v0, v1)
    if side == "back":
        u0, u1 = -t["back"] - length, -t["back"]
        v0, v1 = r + BACK_WALK[0], r + BACK_WALK[1]
    else:
        u0, u1 = -t["back"] - t["ramp"]["length"], t["unload"]
        v0, v1 = r - t["ramp"]["halfWidth"], r + t["ramp"]["halfWidth"]
    return _rect(t, u0, u1, v0 - f, v0), _rect(t, u0, u1, v1, v1 + f)


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
# Out on the line the rope corridor clears a building's full height (a cabin vanishing
# into a tunnel through a block looks wrong). A station hall, and the rope inside it, only
# clear what the station needs: storeys above stay, so it sits in the building's ground
# floor like real resort stations.
NO_CEILING = 1e9
HALL_HEADROOM = 0.6
#: What the sim draws above `roofTop`: the hall roof's slab (gondola, cable car); and a
#: fixed-grip chair's drive housing, which tops out this far above the rail instead.
ROOF_SLAB = 0.3
FIXED_HOUSING = 1.5
#: Storeys left above a station sit this far over its roof: close enough that no gap
#: shows, apart enough that the faces don't z-fight.
ROOF_GAP = 0.03
#: How far past a station's walls buildings are cut back to (m). Halls have walls at the
#: edge of their footprint; a chair's hood sits ~0.8 m inside it, and drags have none.
FLUSH = {"gondola": 0.0, "cabin": 0.0, "chair": 0.0, "drag": 0.8}
# Room left round the carriers (m): below the lowest point (skis, cabin floor) and beside
# the widest (an 8-seat chair, a cabin) as they swing.
CARRIER_CLEARANCE = 1.5
CARRIER_HALF_WIDTH = {"chair": 0.25, "gondola": 1.3, "cabin": 2.6, "drag": 0.6}
# Leftover building pieces narrower than this are dropped (slices beside a cut), and a
# cut building keeping less than MIN_KEPT of its footprint goes altogether: what's left of
# a small building beside a station reads as a stray wall, not a building.
MIN_PIECE_WIDTH = 5.0
MIN_KEPT = 0.35
#: A cut building's leftover piece smaller than this (m²) against a station hall reads as
#: a stray wall, not a building: it goes.
STUB_AREA = 40.0
STUB_TOUCH = 0.5


def cut_volumes(lifts: list[dict], terminals: list[dict]) -> list[tuple]:
    """Spaces lifts need: (footprint, from height, to height, what[, floor plane]). A
    cable piece's floor plane, when given, is the sloping height below which buildings
    stay (`_plane_roof`); `from height` is its lowest point."""
    cuts = []
    for t in terminals:
        # Flush with the station's walls (CUT_MARGIN apart, so no faces coincide): a
        # station set into a building reads as part of it, with no gap to squeeze through.
        ceiling = t["pad"] + station_top(t) + ROOF_GAP
        cuts.append((hall_polygon(t, FLUSH[t["kind"]]), NO_FLOOR, ceiling, "hall"))
        # A station's own building (`shell`) is cut only round the hood itself.
        if t["kind"] == "chair":
            r = t["gauge"] / 2 + HOOD_CLEARANCE
            cuts.append((_rect(t, -t["back"], t["length"], -r, r), NO_FLOOR, ceiling, "hood"))
        side = t.get("entrance")
        if side:
            cuts.append(
                (
                    _walk_rect(t, side, t["walk"]),
                    NO_FLOOR,
                    t["pad"] + WALK_HEIGHT,
                    "walkway",
                    None,
                    _walk_flanks(t, side, t["walk"]),
                )
            )
    for lift in lifts:
        kind = KIND.get(lift["type"])
        if kind is None:
            continue
        s = lift["supports"]
        half = CARRIER_HALF_WIDTH[kind] * ((lift.get("occupancy") or 4) if kind == "chair" else 1)
        width = lift["gauge"] / 2 + half + CARRIER_CLEARANCE
        depth = HANG_DEPTH[kind] + CARRIER_CLEARANCE
        cat = lift.get("catenary")
        ends = (_terminal_at(s[0], terminals), _terminal_at(s[-1], terminals))
        for k, (a, b) in enumerate(zip(s, s[1:], strict=False)):
            ax, ay, bx, by = a["east"], a["north"], b["east"], b["north"]
            span = math.hypot(bx - ax, by - ay)
            if span < 1e-3:
                continue
            # The rope is level through a station, then sags to the next support (`rope.py`).
            # Cut in short pieces that follow it, so a climbing rope doesn't slice a tall
            # wedge out of every building it passes over.
            # A lift's first and last supports are its stations.
            a = _with_exit(a, terminals) if k == 0 else a
            b = _with_exit(b, terminals) if k == len(s) - 2 else b
            level_a, level_b, _ = rope.free_span(a, b)

            def rope_h(d, a=a, b=b, cat=cat):
                return rope.along(a, b, d, cat)

            n = max(1, math.ceil(span / CABLE_STEP))
            for k in range(n):
                d0, d1 = span * k / n, span * (k + 1) / n
                piece = LineString(
                    [
                        (ax + (bx - ax) * d0 / span, ay + (by - ay) * d0 / span),
                        (ax + (bx - ax) * d1 / span, ay + (by - ay) * d1 / span),
                    ]
                ).buffer(width, cap_style="flat")
                hs = [rope_h(d) for d in (d0, d1, level_a, level_b) if d0 <= d <= d1]
                low = NO_FLOOR if kind == "drag" else min(hs) - depth
                in_a = d1 <= level_a + 1e-6
                in_station = in_a or d0 >= level_b - 1e-6
                ceiling = max(hs) + 1.5 if in_station else NO_CEILING
                # Inside a station's own building the ceiling clears the hood or hall.
                term = (ends[0] if in_a else ends[1]) if in_station else None
                if term is not None:
                    ceiling = max(ceiling, term["pad"] + station_top(term) + ROOF_GAP)
                # What's left below follows the rope down the slope, not 4 m steps: the
                # floor as a plane (point, direction, height there, gradient along it).
                floor = None
                if kind != "drag" and not in_station:
                    ux, uy = (bx - ax) / span, (by - ay) / span
                    x0, y0 = ax + ux * d0, ay + uy * d0
                    grade = (rope_h(d1) - rope_h(d0)) / (d1 - d0)
                    floor = (x0, y0, ux, uy, rope_h(d0) - depth, grade)
                cuts.append((piece, low, ceiling, "cable", floor))
    return cuts


def station_top(t: dict) -> float:
    """Height above the pad of the top of what the sim draws for a station (its hall
    roof or hood). Storeys left above a station are cut back to just above it."""
    if t["kind"] in ("gondola", "cabin"):
        return t["roofTop"] + ROOF_SLAB
    if t["kind"] == "chair":
        return t["roofTop"] if t["detachable"] else _rail("chair") + FIXED_HOUSING
    return t["roofTop"] + HALL_HEADROOM  # drags: the name arch and post


#: A hall this much covered by storeys left above it has them as its roof (`roofed`).
ROOFED_COVER = 0.8


def mark_roofed(terminals: list[dict], buildings: list[dict]) -> int:
    """Set `roofed` on gondola and cable car terminals whose hall is covered by storeys
    left above it: the sim then draws no roof slab of its own (one roof, not a slab
    poking out from under the building) and runs the walls up to the storeys."""
    from shapely.strtree import STRtree

    raised = [Polygon(b["footprint"]).buffer(0) for b in buildings if b.get("raised")]
    if not raised:
        return 0
    tree = STRtree(raised)
    count = 0
    for t in terminals:
        if t["kind"] not in ("gondola", "cabin"):
            continue
        hall = hall_polygon(t, 0.0)
        over = unary_union([raised[int(i)] for i in tree.query(hall)] or [Polygon()])
        if over.intersection(hall).area >= ROOFED_COVER * hall.area:
            t["roofed"] = True
            count += 1
    return count


def station_halls(terminals: list[dict]) -> list[tuple[Polygon, float]]:
    """Each terminal's hall footprint and roof height, to tell which building *is* it."""
    return [(hall_polygon(t), t["pad"] + t["roofTop"] + 0.6) for t in terminals]


def _terminal_at(support: dict, terms: list[dict]) -> dict | None:
    for t in terms:
        if math.hypot(t["east"] - support["east"], t["north"] - support["north"]) < 1.0:
            return t
    return None


def _with_exit(support: dict, terms: list[dict]) -> dict:
    """A station support with its hall's `exit` (where the level rope ends), if it lacks
    one (supports straight from `features.extract_lifts`)."""
    if support.get("exit"):
        return support
    for t in terms:
        if math.hypot(t["east"] - support["east"], t["north"] - support["north"]) < 1.0:
            exit_point = [
                t["east"] + t["dir"][0] * t["length"],
                t["north"] + t["dir"][1] * t["length"],
            ]
            return {**support, "exit": exit_point}
    return support


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


def _plane_height(floor: tuple, e: float, n: float) -> float:
    x0, y0, ux, uy, z0, grade = floor
    return z0 + grade * ((e - x0) * ux + (n - y0) * uy)


def _plane_roof(q: Polygon, floor: tuple) -> tuple[float, dict | None]:
    """A piece's top and roof so it slopes with a cable cut's floor plane: the renderer's
    roof model (height falling off linearly from a ridge line) with the ridge across the
    line at the piece's highest point. Returns (lowest height, roof or None if level)."""
    x0, y0, ux, uy, _, _ = floor
    pts = np.asarray(q.exterior.coords)[:-1]
    heights = [_plane_height(floor, e, n) for e, n in pts]
    lo, hi = min(heights), max(heights)
    if hi - lo < 0.05:
        return lo, None
    along = [(e - x0) * ux + (n - y0) * uy for e, n in pts]
    s_hi = along[int(np.argmax(heights))]
    span = max(along) - min(along)
    ce, cn = x0 + ux * s_hi, y0 + uy * s_hi
    ridge = [
        [round(ce - uy * 1000, 2), round(cn + ux * 1000, 2)],
        [round(ce + uy * 1000, 2), round(cn - ux * 1000, 2)],
    ]
    face = np.round(pts, 2).tolist()
    return lo, {
        "ridge": ridge,
        "halfWidth": round(span, 3),
        "rise": round(hi - lo, 3),
        "faces": [face],
        "sloped": True,
    }


def _height_at(b: dict, e: float, n: float) -> float:
    """A building's top at a point (mirrors the sim's roofHeight)."""
    roof = b.get("roof")
    if not roof:
        return b["top"]
    (ax, ay), (bx, by) = roof["ridge"]
    length = math.hypot(bx - ax, by - ay)
    d = abs((bx - ax) * (ay - n) - (ax - e) * (by - ay)) / length
    if roof.get("hip"):
        # Beyond the ridge's ends the roof falls away along it too (the hips).
        along = abs(((e - (ax + bx) / 2) * (bx - ax) + (n - (ay + by) / 2) * (by - ay)) / length)
        d = max(d, along - length / 2)
    k = 1 - d / roof["halfWidth"]
    return b["top"] + roof["rise"] * (k if roof.get("eaves") else max(0.0, k))


def cut_buildings(
    buildings: list[dict], cuts: list[tuple], halls: list[tuple[Polygon, float]] = ()
):
    """Apply volumetric `cuts` to buildings. Returns (buildings, stats).

    A building mostly inside a station hall (`halls`) and not much taller than it *is*
    the station: it's replaced by the generated terminal. Otherwise each building is
    split: what's outside a cut stays as it was; inside it, anything below the cut's
    floor stays (flat-topped, or sloping with the rope under a cable cut that has a floor
    plane) and anything above its ceiling stays as a raised piece (keeping its original
    roof), unless it would be a sliver thinner than MIN_SLAB. Out on the line the rope
    corridor has no ceiling, so it leaves a notch, not a tunnel; storeys over a station
    hall stay. Pieces narrower than MIN_PIECE_WIDTH go, and so does a cut building left
    with under MIN_KEPT of its footprint.
    """
    from shapely.strtree import STRtree

    tree = STRtree([c[0] for c in cuts])
    hall_cuts = [c[0] for c in cuts if c[3] == "hall"]
    hall_tree = STRtree(hall_cuts) if hall_cuts else None
    stats = {"removedAsStation": 0, "cut": 0, "raisedPieces": 0, "stubs": 0}
    out: list[dict] = []
    for b in buildings:
        polygon = Polygon(b["footprint"]).buffer(0)
        top = _full_top(b)
        shell = bool(b.get("shell"))
        for hall, roof in () if shell else halls:
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
                shape, z0, z1, what = cuts[int(i)][:4]
                # A station's own building keeps its walls: only the hood is cut from it.
                if what == ("hood", "hall")[shell]:
                    continue
                floor = cuts[int(i)][4] if len(cuts[int(i)]) > 4 else None
                flanks = cuts[int(i)][5] if len(cuts[int(i)]) > 5 else None
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
                        if z0 > p["base"] + 1.0:  # below the cut: a stub
                            stub_top = min(p["top"], z0)
                            roof = _clip_roof(p["roof"], q) if z0 >= p_top else None
                            if floor is not None and roof is None:
                                lo, sloped = _plane_roof(q, floor)
                                if sloped and lo + sloped["rise"] <= p["top"]:
                                    stub_top, roof = lo, sloped
                            next_pieces.append(
                                {**p, "polygon": q, "top": stub_top, "roof": roof, "inner": True}
                            )
                        if z1 < p["top"] and p_top - z1 >= MIN_SLAB:  # above it: raised
                            next_pieces.append(
                                {
                                    **p,
                                    "polygon": q,
                                    "base": max(z1, p["base"]),
                                    "roof": _clip_roof(p["roof"], q),
                                    "raised": True,
                                    "inner": True,
                                    "flanks": flanks or p.get("flanks"),
                                }
                            )
                pieces = next_pieces
            if not touched:
                out.append(b)
                continue
            stats["cut"] += 1
            # Slices left beside a cut go, including thin arms of a bigger remainder (an
            # opening: shrink by half the width, grow back); pieces kept above or below one
            # (in strips that follow the rope) are part of what's left and stay. A shell
            # keeps every wall: they're the station's.
            kept = []
            for p in pieces:
                if p.get("inner") or shell:
                    if p["polygon"].area >= (1.0 if shell else 4):
                        kept.append(p)
                    continue
                half = MIN_PIECE_WIDTH / 2
                opened = p["polygon"].buffer(-half, join_style=2).buffer(half, join_style=2)
                opened = opened.intersection(p["polygon"])
                for q in _polygons(opened):
                    if q.area >= 4:
                        kept.append({**p, "polygon": q, "roof": _clip_roof(p["roof"], q)})
            # Storeys over a walkway or ramp stay only as an arcade, a shell's too.
            kept = _arcades_only(kept)
            kept = _merge_pieces(kept, b.get("roof"))
            if hall_tree is not None and not shell:
                stubs = [p for p in kept if _is_stub(p, hall_tree, hall_cuts)]
                stats["stubs"] += len(stubs)
                kept = [p for p in kept if not any(p is q for q in stubs)]

            left = unary_union([p["polygon"] for p in kept]).area if kept else 0.0
            if not shell and left < MIN_KEPT * polygon.area:
                stats["removedAsSliver"] = stats.get("removedAsSliver", 0) + 1
                continue
            for k, p in enumerate(kept):
                roof = p["roof"]
                if roof and "sloped" in roof:
                    roof = {k2: v for k2, v in roof.items() if k2 != "sloped"}
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
                        "roof": roof,
                        "raised": p["raised"],
                        # The facade's storeys and plinth count from the ground, not
                        # from a raised piece's own base (no stone over a station).
                        **({"groundBase": b["base"]} if p["raised"] else {}),
                    }
                )
    return out, stats


def _is_stub(p: dict, hall_tree, halls: list[Polygon]) -> bool:
    """A small ground-level leftover against a station hall (STUB_AREA, STUB_TOUCH)."""
    if p["raised"] or p.get("inner") or p["polygon"].area >= STUB_AREA:
        return False
    near = hall_tree.query(p["polygon"].buffer(STUB_TOUCH))
    return any(halls[int(i)].distance(p["polygon"]) < STUB_TOUCH for i in near)


def _merge_pieces(pieces: list[dict], roof_src: dict | None) -> list[dict]:
    """Join touching pieces of one building that share a base, top and roof. The rope
    corridor is cut in CABLE_STEP pieces, so a storey left over a station came out as a
    row of strips with hairline seams between them."""
    groups: dict[tuple, list[dict]] = {}
    for p in pieces:
        roof = p["roof"]
        key = (
            round(p["base"], 2),
            round(p["top"], 2),
            bool(p["raised"]),
            None
            if roof is None
            else (
                tuple(map(tuple, roof["ridge"])),
                roof["halfWidth"],
                roof["rise"],
                roof.get("eaves"),
                bool(roof.get("sloped")),
                bool(roof.get("hip")),
            ),
        )
        groups.setdefault(key, []).append(p)
    out = []
    for members in groups.values():
        if len(members) == 1:
            out.append(members[0])
            continue
        merged = unary_union([m["polygon"] for m in members])
        merged = merged.buffer(0.02, join_style=2).buffer(-0.02, join_style=2)
        template = members[0]
        for q in _polygons(merged):
            roof = template["roof"]
            if roof is not None:
                if roof.get("sloped"):
                    roof = {
                        **roof,
                        "faces": [np.round(np.asarray(q.exterior.coords)[:-1], 2).tolist()],
                    }
                else:
                    roof = _clip_roof(roof_src, q)
            out.append({**template, "polygon": q, "roof": roof})
    return out


def _arcades_only(pieces: list[dict]) -> list[dict]:
    """Drop storeys left over a walkway unless the building stands beside it on both
    sides at ground level (ARCADE_COVER of each flank strip alongside the piece)."""
    from shapely.ops import unary_union

    ground = unary_union([p["polygon"] for p in pieces if not p["raised"]])
    out = []
    for p in pieces:
        flanks = p.get("flanks")
        if p["raised"] and flanks:
            near = p["polygon"].buffer(ARCADE_FLANK + 0.5, join_style=2)
            ok = True
            for flank in flanks:
                part = flank.intersection(near)
                if part.area < 0.5 or ground.intersection(part).area < ARCADE_COVER * part.area:
                    ok = False
            if not ok:
                continue
        out.append(p)
    return out


def conflicts(buildings: list[dict], cuts: list[tuple]) -> list[str]:
    """Invariant: no building volume overlaps a lift's space. Empty = fine."""
    from shapely.strtree import STRtree

    tree = STRtree([c[0] for c in cuts])
    bad: dict[str, int] = {}
    for b in buildings:
        polygon = Polygon(b["footprint"]).buffer(0)
        lo, hi = b["base"], _full_top(b)
        shell = bool(b.get("shell"))
        for i in tree.query(polygon):
            shape, z0, z1, what = cuts[int(i)][:4]
            if what == ("hood", "hall")[shell]:
                continue
            floor = cuts[int(i)][4] if len(cuts[int(i)]) > 4 else None
            overlap = polygon.intersection(shape)
            if min(hi, z1) - max(lo, z0) <= 0.05 or overlap.area <= 0.05:
                continue
            if floor is not None and lo < z0:
                # A sloping cut: only an intrusion where the building's top rises above
                # the floor plane (checked at the overlap's corners).
                pts = [c for g in _polygons(overlap) for c in np.asarray(g.exterior.coords)]
                if all(_height_at(b, e, n) <= _plane_height(floor, e, n) + 0.05 for e, n in pts):
                    continue
            bad[what] = bad.get(what, 0) + 1
            break
    return [f"{n} buildings intrude on lift {what} space" for what, n in bad.items()]
