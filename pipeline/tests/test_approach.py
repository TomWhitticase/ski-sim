import math

import numpy as np

from ski_sim_pipeline.approach import exit_angle, smooth_lift


def flat_slope(grade):
    def g(e, n):
        return 2000 + np.asarray(n, dtype=float) * grade

    return g


def make_lift(supports, kind="chair_lift"):
    return {"id": 1, "type": kind, "gauge": 5, "supports": supports}


def sup(n, ground, top, kind="tower"):
    return {"east": 0.0, "north": float(n), "ground": ground, "top": top, "kind": kind}


def terminal(end, n, pad, d):
    return {
        "end": end,
        "east": 0.0,
        "north": float(n),
        "dir": [0.0, d],
        "across": [1.0, 0.0],
        "length": 16.0,
        "pad": pad,
    }


def test_towers_inside_or_crowding_a_station_are_removed():
    g = flat_slope(0.0)
    lift = make_lift(
        [
            sup(0, 2000, 2005, "station"),
            sup(5, 2000, 2011),  # inside the 16 m station
            sup(20, 2000, 2011),  # 4 m beyond its exit: too close
            sup(200, 2000, 2011),
            sup(400, 2000, 2005, "station"),
        ]
    )
    terms = [terminal("bottom", 0, 2000, 1.0), terminal("top", 400, 2000, -1.0)]
    stats = smooth_lift(lift, terms, g)
    norths = [s["north"] for s in lift["supports"]]
    assert 5.0 not in norths and 20.0 not in norths
    assert stats["dropped"] == 2
    assert exit_angle(lift["supports"], terms[0], "chair") <= 18.01


def test_a_tall_tower_right_by_the_station_is_lowered_to_a_gentle_exit():
    g = flat_slope(0.0)
    lift = make_lift(
        [
            sup(0, 2000, 2005, "station"),
            sup(30, 2000, 2026),  # 14 m beyond the exit, 23.6 m above the platform rope
            sup(300, 2000, 2011),
            sup(600, 2000, 2005, "station"),
        ]
    )
    terms = [terminal("bottom", 0, 2000, 1.0), terminal("top", 600, 2000, -1.0)]
    smooth_lift(lift, terms, g)
    first = lift["supports"][1]
    assert first.get("adjusted") is True
    assert exit_angle(lift["supports"], terms[0], "chair") <= 18.01
    # ...but never shorter than a buildable tower.
    assert first["top"] - first["ground"] >= 4.0 - 1e-6


def test_steep_climb_out_of_a_station_stays_within_the_bend_limits():
    g = flat_slope(0.45)  # ~24° slope up from the bottom station
    sups = [sup(0, 2000, 2002.35, "station")]
    for n in range(80, 800, 80):
        sups.append(sup(n, 2000 + n * 0.45, 2000 + n * 0.45 + 11))
    sups.append(sup(800, 2360, 2365, "station"))
    lift = make_lift(sups)
    terms = [terminal("bottom", 0, 2000, 1.0), terminal("top", 800, 2360, -1.0)]
    smooth_lift(lift, terms, g)
    s = lift["supports"]
    slopes = [
        math.degrees(math.atan2(b["top"] - a["top"], b["north"] - a["north"]))
        for a, b in zip(s[1:-1], s[2:-1], strict=False)
    ]
    bends = [abs(b - a) for a, b in zip(slopes, slopes[1:], strict=False)]
    assert max(bends, default=0) <= 14.5
