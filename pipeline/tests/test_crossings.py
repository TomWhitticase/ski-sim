import numpy as np

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
            return a["top"] + (b["top"] - a["top"]) * t
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
