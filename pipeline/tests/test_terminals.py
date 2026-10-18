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


def test_buildings_in_the_way_are_cut_or_replaced():
    terms = plan([lift(duration=200)])
    for t in terms:
        t["pad"] = 2000
    station = {
        "id": 7,
        "type": "yes",
        "footprint": [[-4, -3], [4, -3], [4, 14], [-4, 14]],
        "top": 2008,
        "base": 1999,
    }
    hotel = {
        "id": 8,
        "type": "hotel",
        "footprint": [[-40, 200], [40, 200], [40, 230], [-40, 230]],
        "top": 2200,
        "base": 2050,
    }
    beside = {
        "id": 9,
        "type": "yes",
        "footprint": [[30, 0], [50, 0], [50, 20], [30, 20]],
        "top": 2010,
        "base": 2000,
    }
    out, stats = cut_buildings(
        [station, hotel, beside], [lift(duration=200)], terms, lambda p, k: None
    )
    ids = sorted(b["id"] for b in out)
    assert 7 not in ids  # the station building is replaced by the generated terminal
    assert 9 in ids  # untouched
    hotel_pieces = [b for b in out if b["id"] in (80, 81)]
    assert len(hotel_pieces) == 2  # the cable corridor slices the tall hotel in two
    for piece in hotel_pieces:
        xs = [p[0] for p in piece["footprint"]]
        assert min(abs(x) for x in xs) >= 2.5 + 2.2 - 0.01
    assert stats == {"removedAsStation": 1, "cut": 1}


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
