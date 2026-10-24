"""Lifts that cross: one passes cleanly over the other.

OSM places each lift on its own, so where two lines cross nothing says which goes over or
by how much, and a chair can swing straight through the other line's rope. For each
crossing the line already higher there is the upper one. Its lowest carrier (the skis on
a chair, a cabin's floor) must clear the lower line's rope by `SEPARATION`. If it doesn't,
the upper line is lifted on a pair of towers either side of the crossing (or its nearest
towers are raised), so it rises over the other line and comes down again; what the
upper line's tallest buildable towers can't make up, the lower line dips by the same
means, down to its minimum clearance. Changed or added towers are marked `crossing`.
"""

from __future__ import annotations

import logging
import math

import numpy as np

from .approach import MAX_TOWER_FACTOR
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
#: Crossings this close to a station are left alone (towers can't stand in a hall).
STATION_CLEAR = 40.0


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


def _rope(a: dict, b: dict, t: float) -> float:
    return a["top"] + (b["top"] - a["top"]) * t


def _profile(lift: dict):
    return LIFT_PROFILES.get(lift["type"]) or LIFT_PROFILES["chair_lift"]


def _station_near(lift: dict, i: int, t: float, length: float) -> bool:
    s = lift["supports"]
    along = sum(
        math.hypot(s[k + 1]["east"] - s[k]["east"], s[k + 1]["north"] - s[k]["north"])
        for k in range(i)
    ) + t * math.hypot(s[i + 1]["east"] - s[i]["east"], s[i + 1]["north"] - s[i]["north"])
    return along < STATION_CLEAR or length - along < STATION_CLEAR


def _length(lift: dict) -> float:
    s = lift["supports"]
    return sum(
        math.hypot(b["east"] - a["east"], b["north"] - a["north"])
        for a, b in zip(s, s[1:], strict=False)
    )


def _shift(lift: dict, i: int, t: float, target: float, ground, limit) -> float:
    """Move lift's rope at (segment i, t) to `target` by setting towers either side.
    `limit(support)` clamps a tower top to what's buildable. Returns the rope height
    reached there."""
    s = lift["supports"]
    a, b = s[i], s[i + 1]
    span = math.hypot(b["east"] - a["east"], b["north"] - a["north"])
    cross_e = a["east"] + (b["east"] - a["east"]) * t
    cross_n = a["north"] + (b["north"] - a["north"]) * t
    ux, uy = (b["east"] - a["east"]) / span, (b["north"] - a["north"]) / span
    offset = max(OFFSET, abs(target - _rope(a, b, t)) * RISE_RATE)
    before = t * span
    after = (1 - t) * span

    def tower_at(d: float, end: dict, reach: float) -> dict:
        """The support `d` m from the crossing towards `end`: an existing one if close."""
        if reach - d < REUSE and end.get("kind") != "station":
            return end
        sign = 1 if end is b else -1
        e = cross_e + ux * d * sign
        n = cross_n + uy * d * sign
        g = float(ground(np.array([e]), np.array([n]))[0])
        return {"east": e, "north": n, "ground": g, "top": g, "kind": "synthetic-tower"}

    d_a = min(offset, before - 5)
    d_b = min(offset, after - 5)
    if d_a < 5 or d_b < 5:
        return _rope(a, b, t)
    p = tower_at(d_a, a, before)
    q = tower_at(d_b, b, after)
    for sup in (p, q):
        sup["top"] = limit(sup, target)
        sup["crossing"] = True
    # Insert new ones in order along the line.
    if q is not b:
        s.insert(i + 1, q)
    if p is not a:
        s.insert(i + 1, p)
    # Rope at the crossing between p and q.
    span_pq = d_a + d_b
    return p["top"] + (q["top"] - p["top"]) * d_a / span_pq


def separate(lifts: list[dict], ground) -> dict:
    """Make every pair of crossing lifts pass cleanly. Returns stats."""
    stats = {"crossings": 0, "lifted": 0, "unresolved": 0}
    roped = [lift for lift in lifts if KIND.get(lift["type"]) is not None]
    lengths = {id(lift): _length(lift) for lift in roped}
    for x, first in enumerate(roped):
        for second in roped[x + 1 :]:
            # Re-scan after each change: towers were inserted.
            fixed_pair = False
            for _ in range(4):
                hit = None
                for i, a0, a1 in _segments(first):
                    for j, b0, b1 in _segments(second):
                        tu = _intersect(a0, a1, b0, b1)
                        if tu:
                            hit = (i, j, *tu)
                            break
                    if hit:
                        break
                if not hit:
                    break
                i, j, t, u = hit
                if not fixed_pair:
                    stats["crossings"] += 1
                h1 = _rope(first["supports"][i], first["supports"][i + 1], t)
                h2 = _rope(second["supports"][j], second["supports"][j + 1], u)
                upper, lower = (first, second) if h1 >= h2 else (second, first)
                ui, ut, li, lt = (i, t, j, u) if h1 >= h2 else (j, u, i, t)
                hu, hl = max(h1, h2), min(h1, h2)
                kind_u = KIND[upper["type"]]
                need = hl + SEPARATION + (0 if kind_u == "drag" else HANG_DEPTH[kind_u])
                if hu >= need - 0.05:
                    break
                if _station_near(upper, ui, ut, lengths[id(upper)]) or _station_near(
                    lower, li, lt, lengths[id(lower)]
                ):
                    stats["unresolved"] += 1
                    log.warning(
                        "Lifts %s and %s cross %.1f m too close beside a station",
                        upper.get("name") or upper["id"],
                        lower.get("name") or lower["id"],
                        need - hu,
                    )
                    break
                pu, pl = _profile(upper), _profile(lower)

                def up_limit(sup, target, p=pu):
                    high = sup["ground"] + p.tower_height * MAX_TOWER_FACTOR
                    return max(sup["top"], min(target, high))

                reached = _shift(upper, ui, ut, need, ground, up_limit)
                short = need - reached
                if short > 0.05:
                    floor_low = hl - short

                    def down_limit(sup, target, p=pl):
                        low = sup["ground"] + p.min_clearance
                        lowest = max(target, low)
                        # Existing towers only come down; new ones go where needed.
                        return (
                            lowest if sup["kind"] == "synthetic-tower" else min(sup["top"], lowest)
                        )

                    _shift(lower, li, lt, floor_low, ground, down_limit)
                stats["lifted"] += not fixed_pair
                fixed_pair = True
            else:
                stats["unresolved"] += 1
    return stats
