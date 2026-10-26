import numpy as np
import pytest
from shapely.geometry import LineString, Point, Polygon

from ski_sim_pipeline import roads
from ski_sim_pipeline.config import Extent, GeoPoint
from ski_sim_pipeline.frame import LocalFrame
from ski_sim_pipeline.grid import Grid, sample_bilinear
from ski_sim_pipeline.pistes import _box_average
from ski_sim_pipeline.roads import (
    centred_mean,
    closed_by_condition,
    collect,
    finish,
    grade,
    structure,
    width_of,
    winter_state,
)

FRAME = LocalFrame(GeoPoint(45.4, 6.6))
EXTENT = Extent(-1000, 1000, -1000, 1000)
GRID = Grid(Extent(-300, 300, -300, 300), 2)


def terrain(fn) -> np.ndarray:
    east, north = GRID.coords()
    e, n = np.meshgrid(east, north)
    return fn(e, n).astype(np.float32)


def at(heights, e, n):
    return sample_bilinear(heights, GRID, np.atleast_1d(e), np.atleast_1d(n))


def way(id_, points, **tags) -> dict:
    geometry = []
    for e, n in points:
        lon, lat = FRAME.to_lonlat(e, n)
        geometry.append({"lat": lat, "lon": lon})
    return {"type": "way", "id": id_, "tags": tags, "geometry": geometry}


def road(line, cls="secondary", width=6.0, structure=None, **tags) -> dict:
    return {
        "id": 1,
        "class": cls,
        "rank": roads.CLASSES[cls][0],
        "name": None,
        "ref": None,
        "width": width,
        "widthSource": "estimate",
        "surface": None,
        "structure": structure,
        "line": LineString(line),
        "tags": tags,
    }


def building(e, n, size=8.0) -> dict:
    h = size / 2
    return {"footprint": [[e - h, n - h], [e + h, n - h], [e + h, n + h], [e - h, n + h]]}


# --- Tags --------------------------------------------------------------------------------


def test_width_from_tags_lanes_or_class():
    assert width_of({"width": "6.1"}, "secondary") == (6.1, "osm")
    assert width_of({"width": "5 m"}, "secondary") == (5.0, "osm")
    # 2 lanes of 3 m plus the edge strips.
    assert width_of({"lanes": "2"}, "tertiary") == (7.0, "lanes")
    assert width_of({}, "track") == (3.0, "estimate")
    assert width_of({}, "primary") == (7.5, "estimate")
    # A width that can't be the carriageway (a 0.4 m kerb mapped as width) is ignored.
    assert width_of({"width": "0.4"}, "service") == (3.5, "estimate")


def test_structure():
    assert structure({"bridge": "yes"}) == "bridge"
    assert structure({"bridge": "viaduct", "layer": "1"}) == "bridge"
    assert structure({"tunnel": "yes"}) == "tunnel"
    assert structure({"tunnel": "building_passage"}) == "tunnel"
    assert structure({"tunnel": "avalanche_protector"}) == "tunnel"
    assert structure({"covered": "yes"}) == "tunnel"
    # Roads use `layer` for junctions and embankments: not a bridge on its own.
    assert structure({"layer": "1"}) is None
    assert structure({"bridge": "no"}) is None


@pytest.mark.parametrize(
    ("value", "closed"),
    [
        ("no @ (Nov 15-May 1)", True),
        ("no @ (Dec-Mar)", True),
        ("no@(Dec-Mar)", True),
        ("no @ snow", True),
        ("no @ winter", True),
        ("no @ (Jun-Sep)", False),
        ("yes @ (Dec-Mar)", False),
        ("destination @ (Dec-Mar)", False),
        ("no @ (Feb)", True),
        ("delivery @ (06:00-10:00); no @ (Nov-Apr)", True),
    ],
)
def test_conditional_closures(value, closed):
    assert closed_by_condition(value) is closed


def test_winter_state():
    # Through roads and streets are ploughed.
    assert winter_state({}, "primary", False) == "cleared"
    assert winter_state({}, "residential", False) == "cleared"
    # Closed in winter, however they're tagged.
    assert winter_state({"winter_road": "no"}, "primary", True) == "snow"
    assert winter_state({"winter_service": "no"}, "tertiary", True) == "snow"
    assert winter_state({"seasonal": "spring;summer;autumn"}, "tertiary", True) == "snow"
    assert winter_state({"seasonal": "yes"}, "unclassified", True) == "snow"
    assert winter_state({"motor_vehicle:conditional": "no @ (Nov-May)"}, "tertiary", True) == (
        "snow"
    )
    assert winter_state({"access:conditional": "no @ snow"}, "secondary", True) == "snow"
    # Tracks and unpaved roads are under the snow, unless they say they're ploughed.
    assert winter_state({}, "track", True) == "snow"
    assert winter_state({"surface": "gravel"}, "unclassified", True) == "snow"
    assert winter_state({"winter_service": "yes"}, "track", False) == "cleared"
    # Service roads are cleared in a village, not up the mountain.
    assert winter_state({}, "service", True) == "cleared"
    assert winter_state({}, "service", False) == "snow"
    assert winter_state({"access": "no"}, "service", True) == "snow"


def test_collect_keeps_roads_on_the_terrain():
    elements = [
        way(1, [(0, 0), (100, 0)], highway="primary", name="Route", ref="D 117"),
        way(2, [(0, 10), (0, 90)], highway="track", bridge="yes"),
        way(3, [(5000, 0), (5100, 0)], highway="primary"),  # off the terrain
        way(4, [(0, 0), (0, 50)], highway="footway"),  # not fetched, but not kept either
        way(5, [(0, 0), (0, 50), (50, 50), (0, 0)], highway="service", area="yes"),
    ]
    out = collect(elements, FRAME, EXTENT)
    assert [r["id"] for r in out] == [1, 2]
    assert out[0]["name"] == "Route" and out[0]["ref"] == "D 117"
    assert out[0]["line"].length == pytest.approx(100, abs=0.5)
    assert out[1]["structure"] == "bridge" and out[1]["class"] == "track"


# --- Grading -----------------------------------------------------------------------------

SIDE_SLOPE = 0.3  # the hillside falls 30% to the south


def hillside() -> np.ndarray:
    return terrain(lambda e, n: 1000 + SIDE_SLOPE * n + 0.02 * e)


def test_road_benched_level_across_keeping_its_profile():
    heights = hillside()
    r = road([(-200, 0), (200, 0)], width=6)
    stats = grade([r], heights, GRID, [])
    assert stats["roads"] == 1
    e = np.array([-100.0, 0.0, 100.0])
    left, right = at(heights, e, np.full(3, 2.5)), at(heights, e, np.full(3, -2.5))
    # Level across, where the hillside fell 1.5 m over those 5 m.
    assert np.abs(left - right).max() < 0.1
    # The 2% along the road is kept.
    centre = at(heights, e, np.zeros(3))
    assert centre[2] - centre[0] == pytest.approx(4.0, abs=0.3)
    # Far from the road the hillside is as it was.
    assert at(heights, 0.0, 60.0)[0] == pytest.approx(1000 + SIDE_SLOPE * 60, abs=0.01)


def test_no_grading_on_a_piste():
    heights = hillside()
    before = heights.copy()
    piste = Polygon([(-40, -60), (40, -60), (40, 60), (-40, 60)])
    grade([road([(-200, 0), (200, 0)], width=6)], heights, GRID, [piste])
    # Under the run (and its margin) the snow is the piste's: untouched.
    inside = (np.abs(GRID.coords()[0]) <= 40) & (np.abs(GRID.coords()[1]) <= 60)
    assert np.abs(heights[inside] - before[inside]).max() == 0
    # Beyond it the road is benched.
    assert abs(at(heights, 150.0, 2.5)[0] - at(heights, 150.0, -2.5)[0]) < 0.1


def test_bridges_and_tunnels_not_graded():
    heights = hillside()
    before = heights.copy()
    stats = grade(
        [
            road([(-200, 0), (200, 0)], structure="bridge"),
            road([(-200, 50), (200, 50)], structure="tunnel"),
        ],
        heights,
        GRID,
        [],
    )
    assert stats["roads"] == 0 and stats["skippedBridgesTunnels"] == 2
    assert np.array_equal(heights, before)


def test_hairpin_banks_leave_the_lower_leg():
    # Two legs 14 m apart across a steep slope (a hairpin's): the upper leg, graded after
    # the lower one, mustn't reshape the lower one's bench with its bank.
    heights = terrain(lambda e, n: 1000 + 0.6 * n)
    lower = road([(-150, 0), (150, 0)], cls="residential", width=5)
    upper = road([(-150, 14), (150, 14)], cls="primary", width=5)
    grade([lower], heights, GRID, [])
    bench = at(heights, np.array([0.0, 0.0]), np.array([1.5, -1.5]))
    grade([lower, upper], heights, GRID, [])
    again = at(heights, np.array([0.0, 0.0]), np.array([1.5, -1.5]))
    assert np.abs(again - bench).max() < 0.3


# --- Winter dressing -----------------------------------------------------------------------


def test_finish_banks_and_poles_keep_off_pistes_and_villages():
    mountain = road([(-400, 0), (400, 0)], cls="secondary", width=6)
    piste = Polygon([(-50, -100), (50, -100), (50, 100), (-50, 100)])
    village = [building(300 + 15 * i, 30 + 15 * j) for i in range(3) for j in range(3)]
    out = finish([mountain], village, [piste])
    assert out["roads"][0]["winter"] == "cleared"
    banks = [LineString(b) for b in out["snowbanks"]]
    assert banks
    for b in banks:
        assert b.distance(piste) >= roads.PISTE_MARGIN - 0.1
        # Beside the road's edge, outside it.
        assert b.distance(LineString([(-400, 0), (400, 0)])) >= 3 + roads.BANK_OFFSET - 0.5
        assert b.length <= roads.BANK_RUN + 0.1
    poles = np.array(out["poles"])
    assert len(poles)
    # Both sides of the road, off the piste and none in the village.
    assert (poles[:, 1] > 0).any() and (poles[:, 1] < 0).any()
    assert not (np.abs(poles[:, 0]) < 50 + roads.PISTE_MARGIN).any()
    assert not ((poles[:, 0] > 290) & (poles[:, 0] < 340)).any()


def test_snow_roads_get_no_banks_or_poles():
    track = road([(-200, 0), (200, 0)], cls="track", width=3)
    out = finish([track], [], [])
    assert out["roads"][0]["winter"] == "snow"
    assert out["snowbanks"] == [] and out["poles"] == []


def test_road_not_drawn_on_an_airfield():
    apron = Polygon([(-20, -20), (20, -20), (20, 20), (-20, 20)])
    out = finish([road([(-100, 0), (100, 0)])], [], [], [apron])
    drawn = out["roads"][0]["drawn"]
    assert len(drawn) == 2
    assert all(LineString(d).distance(Point(0, 0)) >= 19.9 for d in drawn)
    # A road nowhere near one has no `drawn`: its line is what's drawn.
    out = finish([road([(-100, 500), (100, 500)])], [], [], [apron])
    assert "drawn" not in out["roads"][0]


def test_tunnels_clear_no_trees():
    shapes = roads.clearing_shapes(
        [road([(0, 0), (100, 0)]), road([(0, 50), (100, 50)], structure="tunnel")]
    )
    assert len(shapes) == 1
    assert shapes[0].contains(Point(50, 3 + roads.CLEARING - 0.1))


# --- Raster --------------------------------------------------------------------------------


def test_centred_mean_matches_the_overlay_downsampling():
    rng = np.random.default_rng(1)
    fine = (rng.random((61, 47)) > 0.6).astype(np.uint8) * 255
    for factor in (2, 3):
        expected = _box_average(fine.astype(np.float64), factor)
        assert np.allclose(centred_mean(fine, factor, band=4), expected, atol=1e-3)


def test_raster_channels():
    ext = Extent(-100, 100, -100, 100)
    cleared = {**road([(-100, 0), (100, 0)], width=8), "winter": "cleared"}
    snow = {**road([(0, -100), (0, -20)], cls="track", width=4), "winter": "snow"}
    bridge = {**road([(-100, 60), (100, 60)], structure="bridge"), "winter": "cleared"}
    img = np.asarray(roads.raster([cleared, snow, bridge], ext, 3))
    cell = 6
    row = lambda n: round((ext.north - n) / cell)  # noqa: E731
    col = lambda e: round((e - ext.west) / cell)  # noqa: E731
    assert img[row(0), col(50), 0] > 200 and img[row(0), col(50), 1] == 0
    assert img[row(-60), col(0), 1] > 100 and img[row(-60), col(0), 0] == 0
    # Bridges aren't on the ground.
    assert img[row(60), col(0)].max() == 0
