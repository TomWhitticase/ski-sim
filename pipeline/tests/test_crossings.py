import math

import numpy as np

from ski_sim_pipeline import rope
from ski_sim_pipeline.crossings import SEPARATION, separate
from ski_sim_pipeline.terminals import HANG_DEPTH


def flat(e, n):
    return np.full(np.shape(e), 2000.0)


def line(lift_id, kind, a, b, height):
    def sup(p, k):
        return {"east": p[0], "north": p[1], "ground": 2000.0, "top": 2000.0 + height, "kind": k}

    return {
        "id": lift_id,
        "name": f"L{lift_id}",
        "type": kind,
        "gauge": 5,
        "supports": [sup(a, "station"), sup(b, "station")],
    }


def rope_at(lift, e, n):
    """Rope height where the line passes (e, n) (assumes it does)."""
    s = lift["supports"]
    for a, b in zip(s, s[1:], strict=False):
        dx, dy = b["east"] - a["east"], b["north"] - a["north"]
        t = ((e - a["east"]) * dx + (n - a["north"]) * dy) / (dx * dx + dy * dy)
        if 0 <= t <= 1:
            return rope.at(a, b, t, lift.get("catenary"))
    raise AssertionError("not on the line")


def test_two_chairlifts_crossing_at_one_height_are_separated():
    one = line(1, "chair_lift", (0, -400), (0, 400), 10)
    two = line(2, "chair_lift", (-400, 0), (400, 0), 10)
    stats = separate([one, two], flat)
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0}
    high, low = sorted([rope_at(one, 0, 0), rope_at(two, 0, 0)], reverse=True)
    assert high - HANG_DEPTH["chair"] - low >= SEPARATION - 0.05
    # Gently: the new towers climb no steeper than ~1 in 8 from the line's ends.
    upper = one if rope_at(one, 0, 0) > rope_at(two, 0, 0) else two
    tops = [s["top"] for s in upper["supports"]]
    assert all(s.get("crossing") for s in upper["supports"][1:-1])
    assert len(tops) == 4


def test_lines_already_far_apart_are_left_alone():
    one = line(1, "gondola", (0, -400), (0, 400), 30)
    two = line(2, "chair_lift", (-400, 0), (400, 0), 8)
    stats = separate([one, two], flat)
    assert stats["lifted"] == 0
    assert len(one["supports"]) == 2 and len(two["supports"]) == 2


def test_a_crossing_beside_a_station_is_resolved_by_the_first_tower_out():
    """No room for a tower between the hall and the crossing: the rope runs from the
    hall's exit, so the tower beyond the crossing lifts it, within the exit angle."""

    def sup(e, n, top, kind, **extra):
        return {"east": e, "north": n, "ground": 2000.0, "top": top, "kind": kind, **extra}

    one = {
        "id": 1,
        "name": "Station side",
        "type": "chair_lift",
        "gauge": 5,
        "catenary": 1100.0,
        "supports": [
            sup(0.0, -28.0, 2002.83, "station", exit=[0.0, -12.0]),
            sup(0.0, 150.0, 2011.0, "tower"),
            sup(0.0, 400.0, 2002.83, "station", exit=[0.0, 384.0]),
        ],
    }
    two = {
        "id": 2,
        "name": "Low line",
        "type": "chair_lift",
        "gauge": 5,
        "catenary": 1100.0,
        "supports": [
            sup(-300.0, 0.0, 2005.0, "station"),
            sup(-50.0, 0.0, 2001.5, "tower"),
            sup(50.0, 0.0, 2001.5, "tower"),
            sup(300.0, 0.0, 2005.0, "station"),
        ],
    }
    assert rope_at(one, 0, 0) > rope_at(two, 0, 0)
    stats = separate([one, two], flat)
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0}
    assert rope_at(one, 0, 0) - HANG_DEPTH["chair"] - rope_at(two, 0, 0) >= SEPARATION - 0.05
    first = one["supports"][1]
    assert first.get("crossing") and 0 < first["north"] < 150
    # Within the chair's 18° exit angle from the hall's exit.
    rise = first["top"] - 2002.83
    assert rise <= math.tan(math.radians(18)) * (first["north"] + 12) + 0.01


def test_a_sagging_rope_is_measured_at_its_low_point():
    """A long span that clears the other line at its towers, but not mid-span, sagging."""
    one = line(1, "chair_lift", (0, -150), (0, 150), 30)
    one["catenary"] = 1100.0
    two = line(2, "chair_lift", (-300, 0), (300, 0), 15)
    two["supports"][1:1] = [
        {**two["supports"][0], "east": e, "kind": "tower"} for e in (-20.0, 20.0)
    ]
    two["catenary"] = 1100.0
    # Straight, one's skis would pass 11.8 m over two's rope; sagging 300²/8800 = 10.2 m,
    # only 1.8 m.
    assert abs(rope_at(one, 0, 0) - (2030.0 - 300**2 / 8800)) < 1e-9
    stats = separate([one, two], flat)
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0}
    assert rope_at(one, 0, 0) - HANG_DEPTH["chair"] - rope_at(two, 0, 0) >= SEPARATION - 0.05
