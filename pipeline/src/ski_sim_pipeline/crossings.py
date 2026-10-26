"""Lifts that cross: one passes cleanly over the other.

OSM places each lift on its own, so where two lines cross nothing says which goes over or
by how much, and a chair can swing straight through the other line's rope. For each
crossing the line already higher there is the upper one. Its lowest carrier (the skis on
a chair, a cabin's floor) must clear the lower line's rope by `SEPARATION`, both measured
on the sagging rope (`rope.py`). If it doesn't, the upper line is lifted on a pair of
towers either side of the crossing (or its nearest towers are raised), so it rises over
the other line and comes down again; what the upper line's tallest buildable towers can't
make up, the lower line dips by the same means, down to its minimum clearance.

Beside a station there's no room for a tower between the hall and the crossing. There
the rope runs from the hall's exit (at platform height) to the first tower beyond the
crossing, so that tower alone moves it: up or down as far as a buildable tower and the
station's exit angle (`approach.MAX_EXIT_ANGLE`) allow. A crossing inside the level rope
of a hall can only be resolved by moving the other line. Where one tower is held short
(the exit angle, the tallest buildable) and sharing the rest with the lower line still
falls short, the other tower makes it up, no steeper between them than a station exit.
Changed or added towers are marked `crossing`; what can't be resolved is logged.

Lines into a shared or adjoining station often overlap in plan there, though no rope
crosses another (`at_stations`): those are left alone, logged, and not counted.
"""

from __future__ import annotations

import logging
import math

import numpy as np

from . import rope
from .approach import MAX_EXIT_ANGLE, MAX_TOWER_FACTOR, MIN_GAP, MIN_TOWER
from .features import LIFT_PROFILES
from .terminals import HANG_DEPTH, KIND

log = logging.getLogger(__name__)

#: Clear air between the upper line's lowest carrier and the lower line's rope (m).
SEPARATION = 2.5
#: The towers lifting a line over another stand this far either side of the crossing,
#: at least; more when they have to climb a lot, so the rope rises gently (~1 in 8).
OFFSET = 25.0
RISE_RATE = 8.0
#: Supports within this of where a new tower would go are raised instead (m).
REUSE = 15.0
#: A new tower needs at least this much room between the crossing and the next support
#: (or a station's exit plus its MIN_GAP), else the support itself is the anchor (m).
MIN_ROOM = 5.0
#: Lines whose plans cross inside both halls, or within this of their exits, meet at a
#: shared (or adjoining) station: not a crossing (m).
AT_STATION = 5.0


def _segments(lift: dict):
    s = lift["supports"]
    for i in range(len(s) - 1):
        yield i, s[i], s[i + 1]


def _intersect(a0, a1, b0, b1):
    """Where segments a and b cross in plan: (t along a, u along b), or None."""
    ax, ay = a1["east"] - a0["east"], a1["north"] - a0["north"]
    bx, by = b1["east"] - b0["east"], b1["north"] - b0["north"]
    den = ax * by - ay * bx
    if abs(den) < 1e-9:
        return None
    cx, cy = b0["east"] - a0["east"], b0["north"] - a0["north"]
    t = (cx * by - cy * bx) / den
    u = (cx * ay - cy * ax) / den
    if 0 < t < 1 and 0 < u < 1:
        return t, u
    return None


def _profile(lift: dict):
    return LIFT_PROFILES.get(lift["type"]) or LIFT_PROFILES["chair_lift"]


def _catenary(lift: dict) -> float | None:
    return lift.get("catenary")  # written by features.extract_lifts; None: straight


def rope_at(lift: dict, i: int, t: float) -> float:
    """Height of the lift's (sagging) rope at fraction t of plan segment i."""
    s = lift["supports"]
    return rope.at(s[i], s[i + 1], t, _catenary(lift))


def _plan(a: dict, b: dict) -> float:
    return math.hypot(b["east"] - a["east"], b["north"] - a["north"])


def _exit_point(station: dict) -> dict:
    e, n = station["exit"]
    return {"east": e, "north": n, "top": station["top"]}


def _from_exit(lift: dict, i: int, t: float) -> tuple[dict, float] | None:
    """The station end of segment i nearest the crossing at fraction t, and how far
    beyond its exit the crossing is (m; negative inside the hall), or None."""
    s = lift["supports"]
    a, b = s[i], s[i + 1]
    span = _plan(a, b)
    best = None
    for end, reach in ((a, t * span), (b, (1 - t) * span)):
        if end.get("kind") != "station":
            continue
        d = reach - (_plan(end, _exit_point(end)) if end.get("exit") else 0.0)
        if best is None or d < best[1]:
            best = (end, d)
    return best


def at_stations(one: dict, i: int, t: float, two: dict, j: int, u: float, ground) -> bool:
    """Do the lines meet at their stations rather than cross? OSM's lines into a shared
    or adjoining station overlap in plan there, but no rope crosses another: either the
    plans cross inside (or at the exit of) both halls, or inside one line's hall while
    the other, coming out of its own station, couldn't climb over it within its exit
    angle (the hall's rope is at platform height, so nothing passes under it)."""
    near = (_from_exit(one, i, t), _from_exit(two, j, u))
    if all(n is not None and n[1] <= AT_STATION for n in near):
        return True
    for (inside, k, f), (other, m, g), n in (
        ((one, i, t), (two, j, u), near[1]),
        ((two, j, u), (one, i, t), near[0]),
    ):
        hall = _from_exit(inside, k, f)
        if hall is None or hall[1] > 0 or n is None or n[1] <= 0:
            continue
        kind = KIND[other["type"]]
        station, d = n
        if not station.get("exit"):
            continue
        need = rope_at(inside, k, f) + SEPARATION + (0 if kind == "drag" else HANG_DEPTH[kind])
        sup = other["supports"]
        e = sup[m]["east"] + (sup[m + 1]["east"] - sup[m]["east"]) * g
        no = sup[m]["north"] + (sup[m + 1]["north"] - sup[m]["north"]) * g
        floor = float(ground(np.array([e]), np.array([no]))[0])
        top = station["top"]
        rise = max(math.tan(math.radians(MAX_EXIT_ANGLE[kind])) * d, floor + MIN_TOWER[kind] - top)
        if need > top + rise:
            return True
    return False


def _shift(
    lift: dict, i: int, t: float, target: float, ground, limit, make_up: bool = False
) -> float:
    """Move the lift's rope at (segment i, t) toward `target` by setting a tower either
    side of the crossing (new, or an existing support if one is close). Beside a station
    the station's exit is the fixed anchor on that side. `limit(support, wanted)` clamps
    a tower top to what's buildable. With `make_up`, a tower held short of its share
    leaves the other to make up the rest. Returns the rope height reached there."""
    s = lift["supports"]
    kind = KIND[lift["type"]]
    cat = _catenary(lift)
    a, b = s[i], s[i + 1]
    span = _plan(a, b)
    if span < 1e-3:
        return rope_at(lift, i, t)
    ux, uy = (b["east"] - a["east"]) / span, (b["north"] - a["north"]) / span
    cross_e = a["east"] + ux * span * t
    cross_n = a["north"] + uy * span * t
    offset = max(OFFSET, abs(target - rope_at(lift, i, t)) * RISE_RATE)

    def side(end: dict, reach: float, sign: int, beyond: dict | None):
        """(anchor, its distance from the crossing, adjustable?, the station beyond it if
        it's the first tower out of one) on one side, or None inside a hall."""
        if end.get("kind") == "station":
            exit_d = _plan(end, _exit_point(end)) if end.get("exit") else 0.0
            if reach <= exit_d + 0.5:
                return None
            room = reach - exit_d - MIN_GAP[kind]
            if room < MIN_ROOM:
                anchor = _exit_point(end) if end.get("exit") else end
                return anchor, reach - exit_d, False, None
            d = min(offset, room)
            near = end
        else:
            # Making up the rest reuses the towers the first pass set, never crowding
            # them with another.
            if reach - offset < REUSE or make_up:
                station = beyond if beyond and beyond.get("kind") == "station" else None
                return end, reach, True, station
            d, near = offset, None
        e = cross_e + ux * d * sign
        n = cross_n + uy * d * sign
        g = float(ground(np.array([e]), np.array([n]))[0])
        tower = {"east": e, "north": n, "ground": g, "top": g, "kind": "synthetic-tower"}
        return tower, d, True, near

    before, after = t * span, (1 - t) * span
    pa = side(a, before, -1, s[i - 1] if i > 0 else None)
    pb = side(b, after, 1, s[i + 2] if i + 2 < len(s) else None)
    if pa is None or pb is None:
        return rope_at(lift, i, t)
    (p, dp, move_p, st_p), (q, dq, move_q, st_q) = pa, pb
    if not (move_p or move_q):
        return rope_at(lift, i, t)
    length = dp + dq
    u = dp / length
    now = rope_at(lift, i, t)
    tops = (p["top"], q["top"])
    sag_here = rope.sag(cat, length, u)

    def clamp(sup: dict, wanted: float, station: dict | None) -> float:
        """Buildable, and the first tower out of a station within its exit angle (or as
        gentle as the ground allows, where a minimum tower already climbs more)."""
        if station is not None and station.get("exit"):
            ex = _exit_point(station)
            rise = math.tan(math.radians(MAX_EXIT_ANGLE[kind])) * _plan(ex, sup)
            forced = sup["ground"] + MIN_TOWER[kind] - ex["top"]
            lo = min(ex["top"] - rise, sup["top"])
            hi = max(ex["top"] + max(rise, forced), sup["top"])
            wanted = min(max(wanted, lo), hi)
        return limit(sup, wanted)

    def solve(mover: dict, fixed: dict, station: dict | None) -> None:
        """Set `mover` so that, with `fixed` where it is, the rope here meets the target."""
        w = u if mover is q else 1 - u
        want = fixed["top"] + (target + sag_here - fixed["top"]) / max(w, 0.05)
        mover["top"] = clamp(mover, want, station)

    if move_p and move_q:
        want = target + sag_here
        p["top"] = clamp(p, want, st_p)
        q["top"] = clamp(q, want, st_q)
        # A tower held short (a station's exit angle, the tallest buildable) leaves the
        # other to make up the rest: steeper, so only once sharing it fell short.
        if make_up:
            # No steeper between them than the rope may leave a station.
            grade = math.tan(math.radians(MAX_EXIT_ANGLE[kind])) * length
            tries = []
            for mover, fixed, station in ((q, p, st_q), (p, q, st_p)):
                was = mover["top"]
                solve(mover, fixed, station)
                low = min(was, fixed["top"] - grade)
                mover["top"] = min(max(mover["top"], low), max(was, fixed["top"] + grade))
                reach = rope.height(p["top"], q["top"], cat, length, u)
                tries.append((abs(reach - target) + 0.01 * len(tries), mover, mover["top"]))
                mover["top"] = was
            _, mover, top = min(tries, key=lambda x: x[0])
            mover["top"] = top
    else:
        # One side is a station's exit: the other tower alone sets the rope here.
        if move_q:
            solve(q, p, st_q)
        else:
            solve(p, q, st_p)
    reached = rope.height(p["top"], q["top"], cat, length, u)
    if (reached - now) * (target - now) <= 0:
        # Buildable towers there would only make it worse (a dip whose new towers stand
        # higher than the sagging rope did): leave the line as it was.
        p["top"], q["top"] = tops
        return now
    for sup, moved in ((p, move_p), (q, move_q)):
        if moved:
            sup["crossing"] = True
    # Insert new towers in order along the line.
    if move_q and q is not b:
        s.insert(i + 1, q)
    if move_p and p is not a:
        s.insert(i + 1, p)
    return reached


def separate(lifts: list[dict], ground) -> dict:
    """Make every pair of crossing lifts pass cleanly. Returns stats."""
    stats = {"crossings": 0, "lifted": 0, "unresolved": 0, "atStations": 0}
    roped = [lift for lift in lifts if KIND.get(lift["type"]) is not None]
    for x, first in enumerate(roped):
        for second in roped[x + 1 :]:
            # Re-scan after each change: towers were inserted.
            fixed_pair = False
            met = set()  # where they meet at stations instead of crossing (plan position)
            short = 0.0
            for attempt in range(5):
                hit = None
                for i, a0, a1 in _segments(first):
                    for j, b0, b1 in _segments(second):
                        tu = _intersect(a0, a1, b0, b1)
                        if not tu:
                            continue
                        key = (
                            round(a0["east"] + (a1["east"] - a0["east"]) * tu[0], 1),
                            round(a0["north"] + (a1["north"] - a0["north"]) * tu[0], 1),
                        )
                        if key in met:
                            continue
                        if at_stations(first, i, tu[0], second, j, tu[1], ground):
                            met.add(key)
                            stats["atStations"] += 1
                            log.info(
                                "Lifts %s and %s meet at their stations, not a crossing",
                                first.get("name") or first["id"],
                                second.get("name") or second["id"],
                            )
                            continue
                        hit = (i, j, *tu)
                        break
                    if hit:
                        break
                if not hit:
                    short = 0.0
                    break
                i, j, t, u = hit
                if not fixed_pair:
                    stats["crossings"] += 1
                h1, h2 = rope_at(first, i, t), rope_at(second, j, u)
                upper, lower = (first, second) if h1 >= h2 else (second, first)
                ui, ut, li, lt = (i, t, j, u) if h1 >= h2 else (j, u, i, t)
                hu, hl = max(h1, h2), min(h1, h2)
                kind_u = KIND[upper["type"]]
                need = hl + SEPARATION + (0 if kind_u == "drag" else HANG_DEPTH[kind_u])
                short = need - hu
                if short <= 0.05:
                    short = 0.0
                    break
                if attempt == 4:
                    break  # measured after the last change
                pu, pl = _profile(upper), _profile(lower)

                def up_limit(sup, target, p=pu):
                    high = sup["ground"] + p.tower_height * MAX_TOWER_FACTOR
                    return max(sup["top"], min(target, high))

                # The first attempt sets both towers either side to an even share; later
                # ones let one tower make up what the other, held short, couldn't.
                reached = _shift(upper, ui, ut, need, ground, up_limit, attempt > 0)
                rest = need - reached
                if rest > 0.05:
                    floor_low = hl - rest

                    def down_limit(sup, target, p=pl):
                        low = sup["ground"] + p.min_clearance
                        lowest = max(target, low)
                        # Existing towers only come down; new ones go where needed.
                        return (
                            lowest if sup["kind"] == "synthetic-tower" else min(sup["top"], lowest)
                        )

                    _shift(lower, li, lt, floor_low, ground, down_limit, attempt > 0)
                stats["lifted"] += not fixed_pair
                fixed_pair = True
            if short > 0.05:
                stats["unresolved"] += 1
                log.warning(
                    "Lifts %s and %s still cross %.1f m too close",
                    first.get("name") or first["id"],
                    second.get("name") or second["id"],
                    short,
                )
    return stats
