"""The rope's sag. The same numbers are checked in sim/src/lifts/rope.test.ts, so the
pipeline's clearances and the sim's ropes and carriers agree."""

import math

import numpy as np

from ski_sim_pipeline import rope
from ski_sim_pipeline.features import LIFT_PROFILES, place_supports


def test_sag_is_span_squared_over_eight_times_the_catenary_parameter():
    assert math.isclose(rope.sag(1100, 300, 0.5), 10.227272727272727)
    assert math.isclose(rope.mid_sag(1100, 300), 300**2 / 8800)
    assert rope.sag(1100, 300, 0.0) == rope.sag(1100, 300, 1.0) == 0.0
    assert rope.sag(None, 300, 0.5) == 0.0  # older builds: straight


def test_height_hangs_below_the_chord():
    assert math.isclose(rope.height(2000, 2050, 1100, 200, 0.25), 2009.090909090909)


def test_the_rope_is_level_through_a_station_then_sags():
    station = {"east": 0, "north": 0, "top": 2002.83, "exit": [0, 16]}
    tower = {"east": 0, "north": 216, "top": 2040}
    assert rope.along(station, tower, 10, 1100) == 2002.83
    assert math.isclose(rope.along(station, tower, 116, 1100), 2016.8695454545455)
    assert math.isclose(rope.along(station, tower, 216, 1100), 2040)


def test_lowest_point_can_dip_below_the_lower_support():
    a = {"east": 0, "north": 0, "top": 2000}
    b = {"east": 200, "north": 0, "top": 2002}
    assert math.isclose(rope.lowest(a, b, 1100), 1996.3995454545457)


def test_sag_needs_a_tower_a_straight_rope_would_not():
    """Flat ground, a 280 m chairlift span (under max_span) with 11 m towers: straight,
    the rope clears the 7 m minimum all the way; sagging 280²/8800 = 8.9 m, it doesn't."""
    profile = LIFT_PROFILES["chair_lift"]

    def flat(e, n):
        return np.full(np.shape(e), 2000.0)

    points = np.array([[0.0, 0.0], [10.0, 0.0], [290.0, 0.0], [300.0, 0.0]])
    supports = place_supports(points, flat, profile)
    assert [s["kind"] for s in supports].count("synthetic-tower") >= 1
    towers = supports[1:-1]
    for a, b in zip(towers, towers[1:], strict=False):
        assert rope.lowest(a, b, profile.catenary) - 2000 >= profile.min_clearance - 0.01
