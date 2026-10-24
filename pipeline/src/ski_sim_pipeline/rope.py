"""The haul rope's shape: level through each station, sagging between supports.

A loaded rope between two supports hangs as a catenary; at the sag ratios of real lifts
(a few percent of the span) a parabola is within centimetres of it. With horizontal
tension H and weight w per metre (rope plus carriers), the rope sags L² / (8 R) below the
straight chord mid-span, where L is the span's plan length and R = H / w the lift type's
catenary parameter (`LiftProfile.catenary`). Long spans therefore sag proportionally
more: a chairlift (R 1100 m) ~1% over 100 m, ~3.4% over 300 m.

The sim mirrors this exactly (`sim/src/lifts/rope.ts`, same numbers in both unit tests):
the pipeline writes each lift's `catenary`, and the sim hangs its ropes and carriers on
the same curve. Older builds have no `catenary`, so their ropes stay straight, as their
clearances assumed.

A station support carries `exit` (plan east, north): where the rope leaves the hall
(the bullwheel plus the hall's length along its `dir`). The rope runs level from the
support to there, then sags to the next support.
"""

from __future__ import annotations

import math


def sag(catenary: float | None, span: float, t: float) -> float:
    """How far (m) the rope hangs below the straight chord at fraction `t` of a span of
    plan length `span`."""
    if not catenary or span <= 0:
        return 0.0
    return span * span / (2 * catenary) * t * (1 - t)


def mid_sag(catenary: float | None, span: float) -> float:
    return sag(catenary, span, 0.5)


def height(a_top: float, b_top: float, catenary: float | None, span: float, t: float) -> float:
    """Rope height at fraction `t` of a free span from height `a_top` to `b_top`."""
    return a_top + (b_top - a_top) * t - sag(catenary, span, t)


def _plan(a: dict, b: dict) -> float:
    return math.hypot(b["east"] - a["east"], b["north"] - a["north"])


def free_span(a: dict, b: dict) -> tuple[float, float, float]:
    """For the segment between supports a and b (plan, a to b): where along it the free
    span starts and ends (m), and its plan length (exit to exit, or exit to tower)."""
    total = _plan(a, b)
    start, end = 0.0, total
    pa, pb = a, b
    if a.get("exit"):
        pa = {"east": a["exit"][0], "north": a["exit"][1]}
        start = min(_plan(a, pa), total)
    if b.get("exit"):
        pb = {"east": b["exit"][0], "north": b["exit"][1]}
        end = max(total - _plan(b, pb), start)
    return start, end, _plan(pa, pb)


def along(a: dict, b: dict, d: float, catenary: float | None) -> float:
    """Rope height `d` m (plan) from support a toward b: level inside a station, then the
    sagging span."""
    start, end, length = free_span(a, b)
    if end - start < 1e-6:
        return a["top"] if d <= start else b["top"]
    u = min(max((d - start) / (end - start), 0.0), 1.0)
    return height(a["top"], b["top"], catenary, length, u)


def at(a: dict, b: dict, t: float, catenary: float | None) -> float:
    """Rope height at fraction `t` of the plan segment from support a to b."""
    return along(a, b, t * _plan(a, b), catenary)


def lowest(a: dict, b: dict, catenary: float | None) -> float:
    """The rope's lowest point between two supports (m)."""
    start, end, length = free_span(a, b)
    lo = min(a["top"], b["top"])
    if not catenary or end - start < 1e-6:
        return lo
    # d/du of a + (b - a) u - k u (1 - u) = 0  =>  u = (k - (b - a)) / 2k.
    k = length * length / (2 * catenary)
    u = (k - (b["top"] - a["top"])) / (2 * k)
    if 0 < u < 1:
        lo = min(lo, height(a["top"], b["top"], catenary, length, u))
    return lo
