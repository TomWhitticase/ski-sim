import math

import numpy as np
import pytest

from ski_sim_pipeline import carrier_clearance as cc
from ski_sim_pipeline.approach import CLIFF_EXIT_ANGLE, MAX_EXIT_ANGLE, _cliff_exit, smooth_lift
from ski_sim_pipeline.config import Extent
from ski_sim_pipeline.features import LIFT_PROFILES, _fill_span, place_supports
from ski_sim_pipeline.grid import Grid, sample_bilinear
from ski_sim_pipeline.terminals import flatten, plan


def build(profile_n, kind="cable_car", points=None, occupancy=150, cell=2.0, across=None):
    """A lift straight up the north axis over terrain `profile_n(north)` (plus an optional
    `across(east)` side slope), through the pipeline's own steps: pads, supports, the
    approach walk. Returns (lift, terminals, heights, grid, ground)."""
    points = np.array(points, dtype=float)
    span = float(points[:, 1].max())
    grid = Grid(Extent(-150, 150, -100, span + 100), cell)
    east, north = np.broadcast_arrays(*grid.coords())
    heights = np.vectorize(profile_n)(north).astype(np.float64)
    if across is not None:
        heights = heights + np.vectorize(across)(east)

    def ground(e, n):
        return sample_bilinear(heights, grid, np.asarray(e, float), np.asarray(n, float))

    profile = LIFT_PROFILES[kind]
    lift = {
        "id": 7,
        "name": "Test",
        "type": kind,
        "gauge": profile.gauge,
        "catenary": profile.catenary,
        "occupancy": occupancy,
        "supports": place_supports(points, ground, profile),
    }
    terms = plan([lift])
    flatten(terms, heights, grid, ground)
    lift["supports"] = place_supports(points, ground, profile)
    smooth_lift(lift, terms, ground)
    return lift, terms, heights, grid, ground


def caron(n):
    """Cime Caron-like: a 25° face, then a 60° rock step up to the summit plateau, where
    the top station stands at its edge (1230 m)."""
    if n < 0:
        return 2300.0
    if n < 1170:
        return 2300 + n * math.tan(math.radians(25))
    top = 2300 + 1170 * math.tan(math.radians(25))
    return top + min(n - 1170, 35) * math.tan(math.radians(60))


def test_carrier_envelopes_match_what_the_sim_draws():
    # cabinLayout('cabin', 150, 6): floor 7.45 below the grip, 7.0 m long, 3.9 m wide.
    cabin = cc.carrier({"type": "cable_car", "occupancy": 150})
    assert cabin.depth == pytest.approx(7.53)
    assert cabin.half_length == pytest.approx(3.5, abs=0.01)
    assert cabin.half_width == pytest.approx(1.94, abs=0.01)
    # cabinLayout('gondola', 8, 3.2): floor 4.2 below the grip, 1.9 m long.
    gondola = cc.carrier({"type": "gondola", "occupancy": 8})
    assert gondola.depth == pytest.approx(4.28)
    assert gondola.half_length == pytest.approx(0.95)
    # The rider's skis on a chair hang just under the platform height (rail 2.83 m).
    chair = cc.carrier({"type": "chair_lift", "occupancy": 4})
    assert chair.depth == pytest.approx(2.85)
    assert cc.carrier({"type": "t-bar"}) is None
    # The profiles' carriers are the largest of each type.
    for kind in ("cable_car", "gondola", "chair_lift"):
        big = cc.carrier({"type": kind, "occupancy": 200 if kind == "cable_car" else 6})
        assert LIFT_PROFILES[kind].carrier[0] >= big.depth - 0.01


def test_a_steep_arrival_at_a_cliff_top_station_is_notched_clear():
    lift, terms, heights, grid, ground = build(caron, points=[(0, 0), (0, 600), (0, 1230)])
    before = [c for c in cc.conflicts(lift, terms, ground) if c["station"] == "top"]
    # The cabin, coming up the rock step, would hit it in front of the top station.
    assert before and before[0]["shortfall"] > 1.0
    original = heights.copy()
    records = cc.notch([lift], {7: terms}, heights, grid, ground)
    top_cut = [r for r in records if r["end"] == "top"]
    assert len(top_cut) == 1 and top_cut[0]["synthetic"]
    assert cc.conflicts(lift, terms, ground) == []
    # Only cut, only within reach of the top station's exit, never inside the hall.
    cut = original - heights
    assert (cut >= -1e-9).all()
    _, north = np.broadcast_arrays(*grid.coords())
    top = terms[1]
    exit_n = top["north"] - top["length"]
    dug = (cut > 1e-3) & (north > 600)
    assert north[dug].min() > exit_n - cc.NOTCH_REACH - cc.NOTCH_BANK_REACH - 10
    # Never inside a hall: riders load and unload on that ground.
    east, _ = np.broadcast_arrays(*grid.coords())
    assert cut[cc._halls(terms, east, north)].max() == 0.0
    assert top_cut[0]["maxDepth"] == pytest.approx(cut[north > 600].max(), abs=0.01)


def test_a_gentle_lift_needs_no_notch_and_has_no_conflicts():
    lift, terms, heights, grid, ground = build(
        lambda n: 2000 + max(n, 0) * 0.14, kind="chair_lift", points=[(0, 0), (0, 800)], occupancy=4
    )
    assert cc.conflicts(lift, terms, ground) == []
    assert cc.notch([lift], {7: terms}, heights, grid, ground) == []


def test_a_chair_climbing_a_17_degree_slope_gets_a_shallow_cut_out_of_the_station():
    # The rope may leave at 18°, barely steeper than the slope: the skis graze it for the
    # first tens of metres, where no tower may stand. A shallow cut clears them.
    lift, terms, heights, grid, ground = build(
        lambda n: 2000 + max(n, 0) * 0.3, kind="chair_lift", points=[(0, 0), (0, 800)], occupancy=4
    )
    found = cc.conflicts(lift, terms, ground)
    assert found and all(c["station"] == "bottom" for c in found)
    records = cc.notch([lift], {7: terms}, heights, grid, ground)
    assert [r["end"] for r in records] == ["bottom"]
    assert records[0]["maxDepth"] < 3.0
    assert cc.conflicts(lift, terms, ground) == []


def test_towers_on_a_side_slope_lift_the_uphill_track_clear():
    # A chair traversing a 40° side slope: the uphill track's chairs are 3-4 m higher
    # than the centreline, so a tower sized from the centre's ground leaves them in it.
    lift, terms, heights, grid, ground = build(
        lambda n: 2000 + max(n, 0) * 0.25,
        kind="chair_lift",
        points=[(0, 0), (0, 900)],
        occupancy=6,
        across=lambda e: e * math.tan(math.radians(40)),
    )
    found = [c for c in cc.conflicts(lift, terms, ground) if c["station"] is None]
    assert found == []


def test_fill_span_keeps_towers_out_of_the_station_gap_and_the_carriers_clear():
    def g(e, n):
        n = np.asarray(n, dtype=float)
        return 2000 + np.where(n > 300, 40.0, 0.0) + 0 * np.asarray(e, dtype=float)

    profile = LIFT_PROFILES["cable_car"]
    a = {"east": 0.0, "north": 0.0, "ground": 2000.0, "top": 2007.45, "kind": "station"}
    a["exit"] = [0.0, 18.0]
    b = {"east": 0.0, "north": 900.0, "ground": 2040.0, "top": 2065.0, "kind": "tower"}
    towers = _fill_span(a, b, g, profile, station_gap=25.0, carrier_from=40.0)
    assert towers and all(t["north"] > 18.0 + 25.0 for t in towers)
    lift = {"type": "cable_car", "gauge": 8, "catenary": 4000, "occupancy": 100}
    assert cc.span_shortfall(a, {**towers[0]}, lift, g, beyond=40.0) <= cc.TOLERANCE


def test_cable_cars_leave_more_steeply_where_the_cabin_needs_it():
    # A rock rib 60-90 m out of the station, close below the 35° rope to a tower 120 m
    # out: the cabin, 7.5 m under the rope, would hit it. Only a steeper rope clears it.
    def g(e, n):
        n = np.asarray(n, dtype=float)
        rib = (n > 60) & (n < 90)
        return 2000 + np.where(rib, (n - 18) * math.tan(math.radians(35)) - 1, 0.0) + 0 * e

    station = {"east": 0.0, "north": 0.0, "ground": 2000.0, "top": 2007.45, "kind": "station"}
    station["exit"] = [0.0, 18.0]
    h = 102.0
    target = station["top"] + math.tan(math.radians(35)) * h
    tower = {"east": 0.0, "north": 120.0, "ground": 2000.0, "top": target, "kind": "tower"}
    lift = {"type": "cable_car", "gauge": 8, "catenary": 4000, "occupancy": 100}
    top = _cliff_exit(station, tower, target, h, "cabin", 2200.0, lift, g)
    assert top is not None and top > target
    angle = math.degrees(math.atan2(top - station["top"], h))
    assert MAX_EXIT_ANGLE["cabin"] < angle <= CLIFF_EXIT_ANGLE["cabin"] + 0.01
    assert cc.span_shortfall(station, {**tower, "top": top}, lift, g, 40.0) <= cc.TOLERANCE
    # Not where the cabin already clears.
    flat = lambda e, n: 2000 + 0 * np.asarray(n, dtype=float)  # noqa: E731
    assert _cliff_exit(station, tower, target, h, "cabin", 2200.0, lift, flat) is None


def test_towers_either_side_of_a_hump_are_raised_but_not_crossing_ones():
    def g(e, n):
        n = np.asarray(n, dtype=float)
        return 2000 + np.where(np.abs(n - 330) < 15, 12.0, 0.0) + 0 * np.asarray(e, dtype=float)

    def sup(n, h, kind="tower", **extra):
        return {"east": 0.0, "north": float(n), "ground": 2000.0, "top": 2000.0 + h, "kind": kind}

    def terminal(end, n, d):
        return {"end": end, "east": 0.0, "north": float(n), "dir": [0.0, d], "across": [1.0, 0.0]}

    terms = [
        {**terminal("bottom", 0, 1.0), "length": 20.0, "back": 5.5, "width": 13.0, "pad": 2000.0},
        {**terminal("top", 700, -1.0), "length": 20.0, "back": 5.5, "width": 13.0, "pad": 2000.0},
    ]
    supports = [sup(0, 4.3, "station"), sup(300, 14), sup(360, 14), sup(700, 4.3, "station")]
    supports[0]["exit"], supports[-1]["exit"] = [0.0, 20.0], [0.0, 680.0]
    lift = {"id": 3, "type": "gondola", "gauge": 6, "catenary": 1400, "occupancy": 8}
    lift["supports"] = supports

    def on_the_line():
        return [c for c in cc.conflicts(lift, terms, g) if c["station"] is None]

    assert on_the_line()
    assert cc.raise_towers([lift], {3: terms}, g) >= 1
    assert on_the_line() == []
    # A tower set for a crossing stays where the crossing put it.
    for s in supports[1:3]:
        s["top"], s["crossing"] = 2014.0, True
    assert cc.raise_towers([lift], {3: terms}, g) == 0


def test_validate_reports_every_lift_checked():
    lift, terms, heights, grid, ground = build(caron, points=[(0, 0), (0, 600), (0, 1230)])
    report = cc.validate([{**lift, "terminals": terms}], ground)
    assert report["checked"] == 1
    assert any(c["station"] == "top" for c in report["conflicts"])
    cc.notch([lift], {7: terms}, heights, grid, ground)
    assert cc.validate([{**lift, "terminals": terms}], ground)["conflicts"] == []
