"""Smooth the line where it leaves each terminal.

OSM tower positions and heights know nothing about our generated terminals, so towers
can end up inside a station or so close (or at such a different height) that the rope
leaves the station at a crazy angle. Real lifts avoid this with low towers near the
stations and gentle rope angles. For each end:

1. Drop towers inside the terminal or closer than MIN_GAP beyond its exit.
2. Walk outward from the station exit, keeping each span within MAX_EXIT_ANGLE of the
   level station rope (first span) or within MAX_DEFLECTION of the previous span, by
   lowering or raising towers within what a tower can physically be. Only the approach
   (APPROACH metres out) is walked: out on the line a tower on a ridge can bend the rope
   far more, and pinning it to the station's gentle angles leaves it buried.
3. Re-run the ground-clearance tower insertion, then smooth again (twice).

Changed towers are flagged `adjusted: true`; problems that can't be fixed are returned
so the build can report them.
"""

from __future__ import annotations

import math
from dataclasses import replace

import numpy as np

from .carrier_clearance import NOTCH_REACH
from .features import LIFT_PROFILES, MAX_TOWER_FACTOR, _fill_span

#: Rope height above the pad inside a terminal, by terminal kind (mirrors the sim's
#: carrier floor heights; used for angles and clearances here).
RAIL = {"chair": 2.83, "gondola": 4.3, "cabin": 7.45, "drag": 4.0}
#: Gap between the station exit and the first tower (m).
MIN_GAP = {"chair": 8.0, "gondola": 10.0, "cabin": 25.0, "drag": 4.0}
MAX_EXIT_ANGLE = {"chair": 18.0, "gondola": 18.0, "cabin": 35.0, "drag": 25.0}
#: Cable cars may leave a station more steeply than MAX_EXIT_ANGLE where a gentler rope
#: would put the cabin into the ground between the exit and the first tower (a station on
#: a cliff edge or below a rock step, where real track ropes leave at 40-50°). The first
#: tower is then flagged `steepExit`. Detachable grips can't take it, so not chairs or
#: gondolas.
CLIFF_EXIT_ANGLE = {"cabin": 50.0}
MAX_DEFLECTION = 14.0
#: Shortest buildable tower (top above ground); the tallest is MAX_TOWER_FACTOR times the
#: lift's standard tower height (`features.py`).
MIN_TOWER = {"chair": 4.0, "gondola": 5.0, "cabin": 8.0, "drag": 3.0}
MAX_WALK = 6
#: How far beyond the exit (m) the walk reaches; the first tower is always included.
APPROACH = {"chair": 500.0, "gondola": 800.0, "cabin": 800.0, "drag": 250.0}


def _along(t: dict, s: dict) -> float:
    return (s["east"] - t["east"]) * t["dir"][0] + (s["north"] - t["north"]) * t["dir"][1]


def _smooth_end(
    supports: list[dict], t: dict, kind: str, profile, ground, stats: dict, lift: dict | None = None
) -> None:
    """`supports` runs outward from terminal `t` (station first). Edited in place.

    Walks outward from the station exit adjusting tower tops until a tower needs no
    change (the rope then already runs on smoothly), or MAX_WALK towers in.
    """
    rail = t["pad"] + RAIL[kind]
    supports[0]["top"] = round(rail, 2)
    supports[0]["ground"] = round(t["pad"], 2)
    prev = {
        "east": t["east"] + t["dir"][0] * t["length"],
        "north": t["north"] + t["dir"][1] * t["length"],
        "top": rail,
    }
    prev_slope = 0.0  # the rope is level inside the station
    tan_exit = math.tan(math.radians(MAX_EXIT_ANGLE[kind]))
    for i, s in enumerate(supports[1:-1][:MAX_WALK]):
        if i > 0 and _along(t, s) - t["length"] > APPROACH[kind]:
            break
        h = math.hypot(s["east"] - prev["east"], s["north"] - prev["north"])
        if h < 1e-3:
            continue
        # Never so low its own carriers touch the ground passing it: that wins over the
        # bend limits (a ridge tower pulled down to a stub buried the cabins).
        low_t = max(s["ground"] + MIN_TOWER[kind], _carrier_floor(s, t, lift, ground))
        high_t = max(s["ground"] + profile.tower_height * MAX_TOWER_FACTOR, low_t)
        if i == 0:
            lo, hi = prev["top"] - tan_exit * h, prev["top"] + tan_exit * h
        else:
            a0 = math.atan(prev_slope)
            d = math.radians(MAX_DEFLECTION)
            lo = prev["top"] + math.tan(max(a0 - d, -1.4)) * h
            hi = prev["top"] + math.tan(min(a0 + d, 1.4)) * h
        new_lo, new_hi = max(lo, low_t), min(hi, high_t)
        if new_lo <= new_hi:
            target = min(max(s["top"], new_lo), new_hi)
        else:
            # Can't satisfy both: stay buildable, as close to the angle limit as possible.
            target = low_t if low_t > hi else high_t
            stats["unresolved"] += 1
        s.pop("steepExit", None)
        if i == 0 and kind in CLIFF_EXIT_ANGLE and lift is not None:
            steep = _cliff_exit(supports[0], s, target, h, kind, high_t, lift, ground)
            if steep is not None:
                target = steep
                if steep - prev["top"] > tan_exit * h + 0.01:
                    s["steepExit"] = True
                    stats["steepExits"] = stats.get("steepExits", 0) + 1
        changed = abs(target - s["top"]) > 0.05
        if changed:
            s["top"] = round(target, 2)
            s["adjusted"] = True
            stats["adjusted"] += 1
        prev_slope = (s["top"] - prev["top"]) / h
        prev = s
        if not changed and i > 0:
            break


def _carrier_floor(s: dict, t: dict, lift: dict | None, ground) -> float:
    """Lowest top for tower `s` whose carriers (the lift's own, `carrier_clearance`)
    clear the ground under their footprint as they pass it, on both tracks."""
    from .carrier_clearance import carrier

    c = carrier(lift) if lift else None
    if c is None:
        return -math.inf
    d, a = np.array(t["dir"]), np.array(t["across"])
    r = lift["gauge"] / 2
    pts = [
        (s["east"] + d[0] * f + a[0] * o, s["north"] + d[1] * f + a[1] * o)
        for f in (-c.half_length, 0.0, c.half_length)
        for o in (-r - c.half_width, -r, -r + c.half_width, r - c.half_width, r, r + c.half_width)
    ]
    e, n = np.array(pts).T
    return float(np.max(_vec(ground)(e, n))) + c.depth + c.margin


def _cliff_exit(station, s, target, h, kind, high_t, lift, ground) -> float | None:
    """A higher first tower (rope leaving up to CLIFF_EXIT_ANGLE) where at `target` the
    cabin would touch the ground between the exit and the tower; None if not needed or
    no help."""
    from .carrier_clearance import TOLERANCE, span_shortfall

    g = _vec(ground)
    # Closer in, `carrier_clearance.notch` cuts the ground instead.
    beyond = max(MIN_GAP[kind], NOTCH_REACH)

    def short(top: float) -> float:
        return span_shortfall(station, {**s, "top": top}, lift, g, beyond)

    if short(target) <= TOLERANCE:
        return None
    ceiling = min(high_t, station["top"] + math.tan(math.radians(CLIFF_EXIT_ANGLE[kind])) * h)
    best = None
    top = target
    while top < ceiling:
        top = min(top + 1.0, ceiling)
        best = top
        if short(top) <= TOLERANCE:
            break
    return best if best is not None and short(best) < short(target) else None


def _drop_crowding(supports: list[dict], t: dict, kind: str, stats: dict) -> list[dict]:
    """Remove towers inside terminal `t` or within MIN_GAP of its exit (station first)."""
    keep = [supports[0]]
    limit = t["length"] + MIN_GAP[kind]
    for s in supports[1:-1]:
        u = _along(t, s)
        if u < limit:
            stats["dropped"] += 1
            continue
        keep.append(s)
    keep.append(supports[-1])
    return keep


def exit_angle(supports: list[dict], t: dict, kind: str) -> float:
    """Rope angle (degrees) from the terminal exit to the first support beyond it."""
    rail = t["pad"] + RAIL[kind]
    ee = t["east"] + t["dir"][0] * t["length"]
    en = t["north"] + t["dir"][1] * t["length"]
    nxt = supports[1]
    h = math.hypot(nxt["east"] - ee, nxt["north"] - en)
    if _along(t, nxt) < t["length"]:
        return 90.0  # next support is inside the station: the rope doubles back
    return math.degrees(math.atan2(abs(nxt["top"] - rail), max(h, 0.1)))


def smooth_lift(lift: dict, terminals: list[dict], ground) -> dict:
    """Adjust `lift["supports"]` for its two terminals (bottom, top). Returns stats."""
    from .terminals import KIND

    kind = KIND[lift["type"]]
    profile = LIFT_PROFILES[lift["type"]]
    stats = {"dropped": 0, "adjusted": 0, "inserted": 0, "unresolved": 0, "steepExits": 0}
    bottom, top = terminals
    # Where the rope leaves each hall: it's level from the bullwheel to here (`rope.py`).
    for sup, t in ((lift["supports"][0], bottom), (lift["supports"][-1], top)):
        sup["exit"] = [
            round(t["east"] + t["dir"][0] * t["length"], 2),
            round(t["north"] + t["dir"][1] * t["length"], 2),
        ]
    s = _drop_crowding(lift["supports"], bottom, kind, stats)
    s = list(reversed(_drop_crowding(list(reversed(s)), top, kind, stats)))

    def smooth(s: list[dict]) -> list[dict]:
        stats["unresolved"] = stats["steepExits"] = 0
        _smooth_end(s, bottom, kind, profile, ground, stats, lift)
        rev = list(reversed(s))
        _smooth_end(rev, top, kind, profile, ground, stats, lift)
        return list(reversed(rev))

    for attempt in range(5):
        s = smooth(s)
        # Re-check ground clearance between supports (synthetic towers where needed).
        out = [s[0]]
        # Spans touching a station start at platform height by design: only ask them
        # to clear the ground by what the station itself does.
        near_station = replace(profile, min_clearance=min(profile.min_clearance, RAIL[kind] - 0.5))
        for k, (a, b) in enumerate(zip(s, s[1:], strict=False)):
            p = near_station if k == 0 or k == len(s) - 2 else profile
            # Not within the notch's reach of a station either: a stub tower right at the
            # gap's edge forces a steep exit and kinks the rope beyond.
            gap = max(MIN_GAP[kind], NOTCH_REACH)
            extra = _fill_span(a, b, _vec(ground), p, station_gap=gap, carrier_from=NOTCH_REACH)
            stats["inserted"] += len(extra)
            out += extra
            out.append(b)
        if len(out) == len(s):
            break
        s = _drop_crowding(out, bottom, kind, stats)
        s = list(reversed(_drop_crowding(list(reversed(s)), top, kind, stats)))
        if attempt == 4:
            s = smooth(s)  # the last towers added still need fitting to the approach
    lift["supports"] = [
        {k: (round(v, 2) if isinstance(v, float) else v) for k, v in x.items()} for x in s
    ]
    return stats


def _vec(ground):
    def g(e, n):
        return np.asarray(ground(np.atleast_1d(e), np.atleast_1d(n)), dtype=float)

    return g


def feasible_exit_angle(
    supports: list[dict], t: dict, kind: str, lift: dict | None = None, ground=None
) -> float:
    """The gentlest exit the terrain allows: the first tower can't be shorter than
    MIN_TOWER, nor (given the lift and ground) so low its carriers touch the ground
    passing it, so where the ground climbs steeply outside the station the rope must too."""
    rail = t["pad"] + RAIL[kind]
    ee = t["east"] + t["dir"][0] * t["length"]
    en = t["north"] + t["dir"][1] * t["length"]
    nxt = supports[1]
    h = max(math.hypot(nxt["east"] - ee, nxt["north"] - en), 0.1)
    lowest = nxt["ground"] + MIN_TOWER[kind]
    if lift is not None and ground is not None:
        lowest = max(lowest, _carrier_floor(nxt, t, lift, ground))
    rise = lowest - rail if nxt["kind"] != "station" else 0.0
    return math.degrees(math.atan2(max(rise, 0.0), h))
