import numpy as np
import pytest
from shapely.geometry import Polygon

from ski_sim_pipeline.config import Extent
from ski_sim_pipeline.grid import Grid
from ski_sim_pipeline.terminals import (
    cut_buildings,
    detachable,
    flatten,
    hall_polygon,
    plan,
)


def lift(kind="chair_lift", **specs):
    s = lambda e, n, g: {"east": e, "north": n, "ground": g, "top": g + 5}  # noqa: E731
    return {
        "id": 1,
        "type": kind,
        "gauge": 5,
        "length": 1000,
        "supports": [s(0, 0, 2000), s(0, 500, 2150), s(0, 1000, 2300)],
        **specs,
    }


def test_detachable_from_published_speed_and_type():
    assert detachable(lift(duration=200)) is True  # 5 m/s
    assert detachable(lift(duration=500)) is False  # 2 m/s fixed grip
    assert detachable(lift("gondola")) is True
    assert detachable(lift("platter")) is False


def test_terminals_face_into_the_line():
    bottom, top = plan([lift(duration=200)])
    assert bottom["end"] == "bottom" and bottom["dir"] == [0, 1]
    assert top["end"] == "top" and top["dir"] == [0, -1]
    assert top["ramp"] is not None and bottom["ramp"] is None
    hall = hall_polygon(bottom)
    assert hall.contains(Polygon([(-1, 1), (1, 1), (1, 10), (-1, 10)]))  # station interior


def test_flatten_makes_a_level_pad_and_a_ramp_down_at_the_top():
    grid = Grid(Extent(-100, 100, -100, 1100), 2)
    east, north = np.broadcast_arrays(*grid.coords())
    heights = (2000 + north * 0.3).astype(np.float64)  # a 17° slope
    terms = plan([lift(duration=200)])

    def ground(e, n):
        from ski_sim_pipeline.grid import sample_bilinear

        return sample_bilinear(heights, grid, e, n)

    flatten(terms, heights, grid, ground)
    bottom, top = terms
    # Level across the loading area.
    samples = ground(np.array([0.0, 2.5, -2.5, 0.0]), np.array([0.0, 5.0, 5.0, 12.0]))
    assert np.ptp(samples) < 0.05
    assert samples[0] == pytest.approx(bottom["pad"], abs=0.05)
    # Top: the ramp beyond the bullwheel drops below the pad.
    beyond = ground(np.array([2.5]), np.array([1000 + 10.0]))[0]
    assert beyond < top["pad"] - 1.0


def test_buildings_are_cut_only_where_and_as_high_as_lifts_need():
    from ski_sim_pipeline.terminals import (
        WALK_HEIGHT,
        choose_entrances,
        conflicts,
        cut_volumes,
        station_halls,
    )

    terms = plan([lift(duration=200)])
    for t in terms:
        t["pad"] = 2000 if t["end"] == "bottom" else 2300
    station = {
        "id": 7,
        "type": "yes",
        "footprint": [[-4, -3], [4, -3], [4, 14], [-4, 14]],
        "top": 2006,
        "base": 1999,
    }
    # A tall block the bottom station sits inside the ground floor of.
    block = {
        "id": 8,
        "type": "apartments",
        "footprint": [[-30, -20], [30, -20], [30, 40], [-30, 40]],
        "top": 2020,
        "base": 1999,
    }
    beside = {
        "id": 9,
        "type": "yes",
        "footprint": [[60, 0], [80, 0], [80, 20], [60, 20]],
        "top": 2010,
        "base": 2000,
    }
    buildings = [station, block, beside]
    choose_entrances(terms, buildings)
    cuts = cut_volumes([lift(duration=200)], terms)
    out, stats = cut_buildings(buildings, cuts, station_halls(terms))
    ids = {b["id"] for b in out}
    assert 7 not in ids  # the small station building is replaced by the terminal
    assert 9 in ids  # untouched
    pieces = [b for b in out if b["id"] // 100 == 8]
    raised = [b for b in pieces if b.get("raised")]
    # The block stays above the walkway tunnel, and above the station: it sits in the
    # building's ground floor.
    assert raised and min(b["base"] for b in raised) >= 2000 + WALK_HEIGHT
    hall = hall_polygon(terms[0], 0.0)  # the station's walls
    over = [b for b in raised if Polygon(b["footprint"]).intersection(hall).area > 0.5]
    assert over and min(b["base"] for b in over) >= 2000 + terms[0]["roofTop"]
    # Nothing at ground level inside the hall.
    assert all(
        Polygon(b["footprint"]).intersection(hall).area < 0.5 for b in pieces if not b.get("raised")
    )
    # No slivers left beside a cut.
    assert all(not Polygon(b["footprint"]).buffer(-1.2).is_empty for b in pieces)
    assert all(len(b["footprint"]) <= 12 for b in pieces)  # clean, square-cornered cuts
    # ...and keeps its full outer walls at ground level elsewhere.
    assert any(not b.get("raised") and b["base"] < 2000 for b in pieces)
    assert all(not Polygon(b["footprint"]).interiors for b in out)  # no holes
    assert conflicts(out, cuts) == []
    assert stats["removedAsStation"] == 1


def test_a_small_building_mostly_cut_away_goes_altogether():
    from ski_sim_pipeline.terminals import cut_volumes, station_halls

    terms = plan([lift(duration=200)])
    for t in terms:
        t["pad"] = 2000 if t["end"] == "bottom" else 2300
    hall = hall_polygon(terms[0], 0.0)  # the station walls
    minx, miny, maxx, maxy = hall.bounds
    # A low 9 x 9 m shed overlapping the hall's side by 7 m (no storey above the station
    # to keep): only a 2 m slice of it would be left.
    chalet = {
        "id": 5,
        "type": "house",
        "footprint": [
            [maxx - 7, miny + 2],
            [maxx + 2, miny + 2],
            [maxx + 2, miny + 11],
            [maxx - 7, miny + 11],
        ],
        "top": 2004,
        "base": 2000,
    }
    out, stats = cut_buildings(
        [chalet], cut_volumes([lift(duration=200)], terms), station_halls(terms)
    )
    assert not [b for b in out if b["id"] // 100 == 5 or b["id"] == 5]
    assert stats.get("removedAsSliver", 0) + stats["removedAsStation"] == 1


def test_a_long_building_beside_a_station_loses_the_slice_but_keeps_its_ends():
    from ski_sim_pipeline.terminals import MIN_PIECE_WIDTH, cut_volumes, station_halls

    terms = plan([lift(duration=200)])
    for t in terms:
        t["pad"] = 2000 if t["end"] == "bottom" else 2300
    minx, miny, maxx, maxy = hall_polygon(terms[0], 0.0).bounds
    # A 9 m deep block running past both ends of the hall, 7 m of its depth over it.
    block = {
        "id": 6,
        "type": "house",
        "footprint": [
            [maxx - 7, miny - 10],
            [maxx + 2, miny - 10],
            [maxx + 2, maxy + 10],
            [maxx - 7, maxy + 10],
        ],
        "top": 2004,
        "base": 2000,
    }
    out, _ = cut_buildings([block], cut_volumes([lift(duration=200)], terms), station_halls(terms))
    # Full-height pieces are what's beside the cuts (lower ones run under the rope, in
    # strips that join up).
    pieces = [Polygon(b["footprint"]) for b in out if b["id"] // 100 == 6 and b["top"] == 2004]
    assert pieces  # the end past the hall stays
    for p in pieces:  # ...and nothing thinner than MIN_PIECE_WIDTH is left beside it
        assert not p.buffer(-MIN_PIECE_WIDTH / 2 + 0.05, join_style=2).is_empty


def test_a_ramp_never_carves_another_terminals_pad():
    grid = Grid(Extent(-100, 100, -100, 1100), 2)
    heights = np.full((grid.height, grid.width), 2300.0)
    a = lift(duration=200)
    # A second lift whose top terminal sits right where the first one's ramp runs out.
    b = {**lift(duration=200), "id": 2}
    b["supports"] = [{**s, "east": s["east"] + 3, "north": s["north"] + 15} for s in b["supports"]]
    terms = plan([a, b])

    def ground(e, n):
        from ski_sim_pipeline.grid import sample_bilinear

        return sample_bilinear(heights, grid, e, n)

    flatten(terms, heights, grid, ground)
    second_top = [t for t in terms if t["end"] == "top"][1]
    unload = np.array([second_top["east"] + second_top["dir"][0] * second_top["unload"] + 2.5])
    unload_n = np.array([second_top["north"] + second_top["dir"][1] * second_top["unload"]])
    assert ground(unload, unload_n)[0] == pytest.approx(second_top["pad"], abs=0.3)
