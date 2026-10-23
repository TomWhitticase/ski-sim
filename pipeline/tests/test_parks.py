import math

import numpy as np
import pytest
from shapely.geometry import LineString, Point, Polygon

from ski_sim_pipeline.parks import (
    HALFPIPE,
    SIZES,
    blocked,
    build,
    footprint,
    halfpipe_section,
    kicker_profile,
    layout,
    roller_profile,
)


def hill(grade_deg: float):
    """A slope falling to the north at grade_deg."""
    t = math.tan(math.radians(grade_deg))

    def ground(e, n):
        return 2000 - t * np.asarray(n, dtype=float) + 0 * np.asarray(e, dtype=float)

    return ground


def park(name="Park", difficulty=0, area=None, lines=()):
    return {
        "index": 7,
        "name": name,
        "type": "snow_park",
        "difficulty": difficulty,
        "areas": [area] if area is not None else [],
        "lines": list(lines),
    }


@pytest.mark.parametrize("size", ["small", "medium", "large"])
@pytest.mark.parametrize("grade", [6.0, 12.0, 20.0])
def test_kicker_profile_take_off_table_and_landing(size, grade):
    spec = SIZES[size]
    p = kicker_profile(grade, spec)
    u, y = p[:, 0], p[:, 1]
    slope = np.degrees(np.arctan(np.gradient(y, u)))
    th = math.tan(math.radians(grade))
    # Starts and ends on the hill, joining it without a step.
    assert y[0] == pytest.approx(-th * u[0], abs=1e-6)
    assert y[-1] == pytest.approx(-th * u[-1], abs=1e-6)
    # The lip: at its height above the hill, leaving at the take-off angle.
    lip = int(np.argmin(np.abs(u)))
    assert y[lip] == pytest.approx(spec["height"], abs=0.05)
    last = math.degrees(math.atan((y[lip] - y[lip - 1]) / (u[lip] - u[lip - 1])))
    assert last == pytest.approx(spec["angle"], abs=1.5)
    # Level table, then a landing steeper than the hill (at least the design angle).
    table = (u > 1.5) & (u < spec["table"] - 1.5)
    assert np.all(np.abs(slope[table]) < 0.5)
    assert slope.min() <= -max(spec["landing"], grade + 12) + 0.5
    # The run-in never dips below the hill, and nothing is steeper than the lip's back.
    run_in = u < 0
    assert np.all(y[run_in] >= -th * u[run_in] - 1e-6)
    assert np.all(np.abs(slope) < 60)


def test_rollers_rise_and_fall_back_to_the_hill():
    p = roller_profile(10.0, 2)
    y = p[:, 1] + math.tan(math.radians(10)) * p[:, 0]  # height above the hill
    assert y.max() == pytest.approx(0.9, abs=0.02)
    assert y[0] == pytest.approx(0) and y[-1] == pytest.approx(0)


def test_a_park_area_gets_a_jump_line_and_a_jib_line_inside_its_outline():
    area = Polygon([(-25, 0), (25, 0), (25, 300), (-25, 300)])  # 50 m wide, falls north
    features = layout(park(area=area), hill(12))
    kinds = [f["kind"] for f in features]
    assert kinds.count("kicker") >= 3
    assert kinds.count("box") >= 2 and kinds.count("box") == kinds.count("ramp")
    for f in features:
        assert area.contains(Point(f["east"], f["north"]))
        if f["kind"] == "kicker":
            assert f["heading"] == pytest.approx(0, abs=1)  # straight down the fall line
    # Deterministic.
    assert layout(park(area=area), hill(12)) == features


def test_family_parks_get_small_kickers_and_black_parks_large_ones():
    area = Polygon([(-12, 0), (12, 0), (12, 300), (-12, 300)])

    def widths(p):
        return {f["width"] for f in layout(p, hill(12)) if f["kind"] == "kicker"}

    assert widths(park("Family Park", area=area)) == {SIZES["small"]["width"]}
    assert SIZES["large"]["width"] in widths(park(difficulty=4, area=area))


def test_a_boardercross_weaves_round_berms_with_rollers_between():
    area = Polygon([(-30, 0), (30, 0), (30, 400), (-30, 400)])
    features = layout(park("Boardercross", area=area), hill(10))
    berms = [f for f in features if f["kind"] == "berm"]
    assert len(berms) >= 6
    assert any(f["kind"] == "roller" for f in features)
    # Alternate sides: the walls' arc centres swap sides of the spine.
    sides = [np.sign(b["east"]) for b in berms]
    assert all(a != b for a, b in zip(sides, sides[1:], strict=False))


def test_features_keep_clear_of_buildings_and_lift_lines():
    area = Polygon([(-12, 0), (12, 0), (12, 300), (-12, 300)])
    lift = {"supports": [{"east": -50, "north": 150}, {"east": 50, "north": 150}]}
    hut = {"footprint": [[-5, 60], [5, 60], [5, 70], [-5, 70]]}
    no_go = blocked({"lifts": [lift], "buildings": [hut]})
    features = layout(park(area=area), hill(12), no_go)
    assert features
    for f in features:
        assert not (138 < f["north"] < 162)
        assert not (55 < f["north"] < 75)


def test_parks_on_flat_ground_or_too_small_get_nothing():
    flat = Polygon([(-25, 0), (25, 0), (25, 300), (-25, 300)])
    assert layout(park(area=flat), hill(0)) == []
    tiny = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    assert layout(park(area=tiny), hill(12)) == []
    line_park = park(lines=[LineString([(0, 0), (0, 300)])])
    out = build([line_park, {"type": "downhill"}], hill(12))
    assert len(out) == 1 and out[0]["index"] == 7 and out[0]["synthetic"]


def _overlaps(features):
    """Pairs of features whose footprints overlap (a rail and its own ramp may)."""
    shapes = [footprint(f) for f in features]
    pairs = []
    for i, a in enumerate(features):
        for j in range(i + 1, len(features)):
            b = features[j]
            pair = {a["kind"], b["kind"]} == {"ramp", "box"}
            if pair and (a["east"], a["north"]) == (b["east"], b["north"]):
                continue
            if shapes[i].intersection(shapes[j]).area > 0.5:
                pairs.append((a["kind"], b["kind"]))
    return pairs


def test_halfpipe_cross_section_is_a_superpipe():
    radius, half = halfpipe_section()
    a = math.radians(HALFPIPE["vert"])
    # Transitions round to near-vertical over the top of 5-6 m walls, a 14-18 m floor.
    assert 5.0 <= HALFPIPE["height"] <= 6.0 and 14 <= HALFPIPE["flat"] <= 18
    assert radius * (1 - math.cos(a)) + HALFPIPE["vertHeight"] == pytest.approx(HALFPIPE["height"])
    assert 80 <= HALFPIPE["vert"] < 90
    assert half == pytest.approx(
        HALFPIPE["flat"] / 2 + radius * math.sin(a) + 0.4 / math.tan(a) + HALFPIPE["deck"]
    )


def test_a_big_park_on_a_pipe_grade_gets_a_halfpipe_down_the_fall_line():
    area = Polygon([(-40, 0), (40, 0), (40, 400), (-40, 400)])
    features = layout(park(area=area), hill(17))
    pipes = [f for f in features if f["kind"] == "halfpipe"]
    assert len(pipes) == 1
    pipe = pipes[0]
    assert pipe["heading"] == pytest.approx(0, abs=1)  # down the fall line
    assert 100 <= pipe["length"] <= 170
    # The floor lies on the 17° hill under the walls, blending into it at the ends.
    u = np.array([q[0] for q in pipe["profile"]])
    y = pipe["y"] + np.array([q[1] for q in pipe["profile"]])
    walls = (u >= 0) & (u <= pipe["length"])
    slope = -np.polyfit(u[walls], y[walls], 1)[0]
    assert math.degrees(math.atan(slope)) == pytest.approx(17, abs=0.3)
    hill_y = hill(17)(pipe["east"], pipe["north"] + u)
    assert np.all(y[walls] >= hill_y[walls] - 0.01)
    assert y[0] == pytest.approx(hill_y[0], abs=0.01) and y[-1] == pytest.approx(
        hill_y[-1], abs=0.01
    )
    # Inside the park, and nothing else built on it.
    assert area.buffer(-1).contains(footprint(pipe))
    assert _overlaps(features) == []
    assert any(f["kind"] == "kicker" for f in features)  # the park still has its lines


@pytest.mark.parametrize(
    "name,grade,width",
    [("Family Park", 17, 80), ("Park", 8, 80), ("Park", 30, 80), ("Park", 17, 50)],
)
def test_no_halfpipe_in_small_parks_or_on_the_wrong_grade(name, grade, width):
    area = Polygon([(-width / 2, 0), (width / 2, 0), (width / 2, 400), (-width / 2, 400)])
    assert not any(f["kind"] == "halfpipe" for f in layout(park(name, area=area), hill(grade)))


def test_a_halfpipe_keeps_clear_of_lift_lines():
    area = Polygon([(-40, 0), (40, 0), (40, 500), (-40, 500)])
    lift = {"supports": [{"east": -80, "north": 120}, {"east": 80, "north": 120}]}
    no_go = blocked({"lifts": [lift]})
    pipe = next(f for f in layout(park(area=area), hill(17), no_go) if f["kind"] == "halfpipe")
    assert not footprint(pipe).intersects(no_go)


def curved_hill(e, n):
    """Falls north at ~12°, with the fall line swinging east-west across the park."""
    e = np.asarray(e, dtype=float)
    n = np.asarray(n, dtype=float)
    return 2000 - 0.21 * n - 0.06 * 30 * np.sin(n / 60) * np.sin(e / 30)


def test_lines_meander_and_mix_feature_kinds_without_overlapping():
    area = Polygon([(-50, 0), (50, 0), (50, 600), (-50, 600)])
    features = layout(park(difficulty=4, area=area), curved_hill)
    kinds = {f["kind"] for f in features}
    assert {"kicker", "ramp", "box", "wall"} <= kinds
    # Several kinds of jib: rails of two lengths, a down rail (kinked) and a flat box.
    boxes = [f for f in features if f["kind"] == "box"]
    shapes = {(f["width"], round(f["profile"][-1][0]), len(f["profile"])) for f in boxes}
    assert len(shapes) >= 3
    assert any(len(f["profile"]) == 3 for f in boxes)  # a down rail
    assert any(f["width"] > 0.8 for f in boxes)  # a flat box
    # Mixed kicker sizes.
    assert len({f["width"] for f in features if f["kind"] == "kicker"}) >= 2
    # Not in a ruler-straight line: the kickers spread across the park and turn with it.
    kickers = [f for f in features if f["kind"] == "kicker"]
    assert np.std([f["east"] for f in kickers]) > 3
    assert len({round(f["heading"]) for f in kickers}) >= 3
    # Every feature inside the park, clear of the others, and facing downhill.
    for f in features:
        assert area.buffer(-1.0).contains(footprint(f))
        if "heading" in f:
            h = math.radians(f["heading"])
            ahead = curved_hill(f["east"] + 8 * math.sin(h), f["north"] + 8 * math.cos(h))
            assert ahead < curved_hill(f["east"], f["north"])
    assert _overlaps(features) == []
    # Seeded from the park, so the same park always gets the same layout.
    assert layout(park(difficulty=4, area=area), curved_hill) == features
