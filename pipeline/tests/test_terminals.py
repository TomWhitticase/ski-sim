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


def test_storeys_over_a_walkway_stay_only_as_an_arcade():
    """A block the station sits in, with a bay jutting out over the station's side door:
    nothing stands beside the walkway at ground level, so the bay's storeys would float
    over the door. They go (the walkway is open to the sky), while the block's storeys
    over the station hall stay. A walkway through the middle of a block (built-up on both
    sides) keeps its storeys: that's an arcade."""
    from ski_sim_pipeline.terminals import (
        WALK_HEIGHT,
        _walk_rect,
        choose_entrances,
        conflicts,
        cut_volumes,
        station_halls,
    )

    terms = plan([lift(duration=200)])
    for t in terms:
        t["pad"] = 2000 if t["end"] == "bottom" else 2300
    bottom = terms[0]
    w = bottom["width"] / 2
    at = bottom["load"]
    # The block covers the hall and everything behind it; the bay sits over the door.
    block = {
        "id": 8,
        "type": "apartments",
        "footprint": [
            [-30, -20],
            [w + 0.5, -20],
            [w + 0.5, at - 3.5],
            [w + 7, at - 3.5],
            [w + 7, at + 3.5],
            [w + 0.5, at + 3.5],
            [w + 0.5, 40],
            [-30, 40],
        ],
        "top": 2020,
        "base": 1999,
    }
    choose_entrances(terms, [block])
    assert bottom["entrance"] == "side"
    cuts = cut_volumes([lift(duration=200)], terms)
    out, _ = cut_buildings([block], cuts, station_halls(terms))
    # Inside the cut margin (pieces are cut CUT_MARGIN clear of a station's walls).
    walk = _walk_rect(bottom, "side", bottom["walk"]).buffer(-0.15, join_style=2)
    over_walk = [b for b in out if Polygon(b["footprint"]).intersection(walk).area > 0.5]
    assert over_walk == []
    hall = hall_polygon(bottom, 0.0)
    assert any(
        b.get("raised") and Polygon(b["footprint"]).intersection(hall).area > 0.5 for b in out
    )
    assert conflicts(out, cuts) == []

    # Through the middle of a wide block: storeys over the walkway stay.
    wide = {**block, "footprint": [[-30, -20], [40, -20], [40, 40], [-30, 40]]}
    out, _ = cut_buildings([wide], cuts, station_halls(terms))
    arcade = [
        b for b in out if b.get("raised") and Polygon(b["footprint"]).intersection(walk).area > 0.5
    ]
    assert arcade and min(b["base"] for b in arcade) >= 2000 + WALK_HEIGHT


def _grid_and_ground():
    from ski_sim_pipeline.grid import sample_bilinear

    grid = Grid(Extent(west=-200, south=-100, east=200, north=1200), 4.0)
    heights = np.full((grid.height, grid.width), 2000.0)
    return grid, heights, lambda e, n: sample_bilinear(heights, grid, e, n)


def test_a_chair_station_keeps_its_own_building_as_a_shell():
    """OSM maps the station chalet as `building=yes` round the lift's end node. Cut as
    any other building its ground floor went and the storeys hovered over the hood; now
    it stays whole (a shell the sim doesn't collide with), station-height and clear of
    the hood, with only the hood's volume, the rope portal and the door cut from it."""
    from ski_sim_pipeline.terminals import (
        adopt_station_buildings,
        choose_entrances,
        conflicts,
        cut_volumes,
        station_halls,
    )

    grid, heights, ground = _grid_and_ground()
    terms = plan([lift(duration=200)])
    flatten(terms, heights, grid, ground)
    bottom = terms[0]
    # A chalet 14 x 18 m round the bottom station, offset to one side: it covers most
    # of the hall but the hall doesn't cover most of it.
    chalet = {
        "id": 5,
        "type": "yes",
        "footprint": [[-9, -6], [9, -6], [9, 14], [-9, 14]],
        "base": 1999,
        "top": 2015,  # estimated from its area: far too tall for a station
        "heightSource": "estimate",
        "roof": None,
    }
    buildings = [chalet]
    stats = adopt_station_buildings(terms, buildings, heights, grid, ground)
    assert stats["shells"] == 1 and stats["stationHeight"] == 1
    assert chalet["shell"] is True
    assert chalet["top"] == pytest.approx(bottom["pad"] + 8.0, abs=0.6)
    assert chalet["top"] > bottom["pad"] + bottom["roofTop"] + 2
    choose_entrances(terms, buildings)
    cuts = cut_volumes([lift(duration=200)], terms)
    out, cut_stats = cut_buildings(buildings, cuts, station_halls(terms))
    assert cut_stats["removedAsStation"] == 0
    pieces = [b for b in out if b["id"] // 100 == 5]
    assert pieces and all(b.get("shell") for b in pieces)
    walls = [b for b in pieces if not b.get("raised")]
    # The side walls stand at ground level either side of the hood...
    r = bottom["gauge"] / 2
    assert any(max(e for e, _ in b["footprint"]) > r + 2 for b in walls)
    assert any(min(e for e, _ in b["footprint"]) < -r - 2 for b in walls)
    # ...and the storey over the hood is clear of its roof.
    from ski_sim_pipeline.terminals import HOOD_CLEARANCE, _rect

    hood = _rect(bottom, -bottom["back"], bottom["length"], -r - HOOD_CLEARANCE, r + HOOD_CLEARANCE)
    over = [b for b in pieces if Polygon(b["footprint"]).intersection(hood).area > 1]
    assert over and all(b.get("raised") for b in over)
    assert min(b["base"] for b in over) >= bottom["pad"] + bottom["roofTop"]
    assert conflicts(out, cuts) == []


def test_a_gondola_hall_grows_to_fill_its_building():
    from ski_sim_pipeline.terminals import adopt_station_buildings

    grid, heights, ground = _grid_and_ground()
    terms = plan([lift("gondola")])
    flatten(terms, heights, grid, ground)
    bottom = terms[0]
    was = (bottom["back"], bottom["length"], bottom["width"])
    # A 30 x 32 m station building the lift's end node sits inside.
    station = {
        "id": 6,
        "type": "yes",
        "footprint": [[-12, -8], [18, -8], [18, 24], [-12, 24]],
        "base": 1999,
        "top": 2020,
        "heightSource": "estimate",
        "roof": None,
    }
    stats = adopt_station_buildings(terms, [station], heights, grid, ground)
    assert stats["grown"] == 1
    assert bottom["back"] == 8 and bottom["length"] == 24 and bottom["width"] > was[2]
    assert bottom["width"] <= bottom["gauge"] + 16  # capped either side of the line
    # Station height: 8 m, or clear of the hall's roof with a storey to spare.
    from ski_sim_pipeline.terminals import MIN_SLAB, ROOF_GAP, station_top

    clear = station_top(bottom) + ROOF_GAP + MIN_SLAB + 0.5
    assert station["top"] == pytest.approx(bottom["pad"] + max(8.0, clear))
    assert "shell" not in station
    # The pad grew with the hall: level ground past the new front wall.
    assert ground(np.array([0.0]), np.array([27.0]))[0] == pytest.approx(bottom["pad"], abs=0.05)


def test_a_residence_the_station_sits_in_is_not_adopted():
    from ski_sim_pipeline.terminals import adopt_station_buildings

    grid, heights, ground = _grid_and_ground()
    terms = plan([lift(duration=200)])
    flatten(terms, heights, grid, ground)
    block = {
        "id": 8,
        "type": "apartments",
        "footprint": [[-30, -20], [40, -20], [40, 40], [-30, 40]],
        "base": 1999,
        "top": 2020,
        "heightSource": "osm-levels",
        "roof": None,
    }
    stats = adopt_station_buildings(terms, [block], heights, grid, ground)
    assert stats == {"stationHeight": 0, "grown": 0, "shells": 0}
    assert "shell" not in block and block["top"] == 2020


def test_cut_pieces_sharing_a_height_and_roof_are_merged():
    """The rope corridor is cut in 4 m steps, so the storey over a station came out as a
    row of strips with seams between them: now it's one piece."""
    from ski_sim_pipeline.terminals import choose_entrances, cut_volumes, station_halls

    terms = plan([lift("gondola")])
    for t in terms:
        t["pad"] = 2000 if t["end"] == "bottom" else 2300
    block = {
        "id": 8,
        "type": "apartments",
        "footprint": [[-30, -20], [30, -20], [30, 60], [-30, 60]],
        "top": 2020,
        "base": 1999,
        "heightSource": "osm-levels",
    }
    choose_entrances(terms, [block])
    cuts = cut_volumes([lift("gondola")], terms)
    out, _ = cut_buildings([block], cuts, station_halls(terms))
    hall = hall_polygon(terms[0], 0.0)
    over = [
        b for b in out if b.get("raised") and Polygon(b["footprint"]).intersection(hall).area > 1
    ]
    assert len(over) == 1
    assert Polygon(over[0]["footprint"]).area > 0.9 * hall.area


def test_storeys_over_a_station_sit_on_its_roof_and_keep_their_ground_base():
    """No gap between a station's roof and the storeys left above it (only ROOF_GAP, so
    the faces don't z-fight), and those storeys remember where the building stands, so
    the facade's plinth and storeys count from the ground."""
    from ski_sim_pipeline.terminals import (
        ROOF_GAP,
        choose_entrances,
        cut_volumes,
        station_halls,
        station_top,
    )

    for kind, specs in (("gondola", {}), ("chair_lift", {"duration": 200})):
        terms = plan([lift(kind, **specs)])
        for t in terms:
            t["pad"] = 2000 if t["end"] == "bottom" else 2300
        block = {
            "id": 8,
            "type": "apartments",
            "footprint": [[-30, -20], [30, -20], [30, 60], [-30, 60]],
            "top": 2020,
            "base": 1999,
            "heightSource": "osm-levels",
        }
        choose_entrances(terms, [block])
        cuts = cut_volumes([lift(kind, **specs)], terms)
        out, _ = cut_buildings([block], cuts, station_halls(terms))
        hall = hall_polygon(terms[0], 0.0)
        over = [
            b
            for b in out
            if b.get("raised") and Polygon(b["footprint"]).intersection(hall).area > 1
        ]
        assert over, kind
        roof = terms[0]["pad"] + station_top(terms[0])
        assert min(b["base"] for b in over) == pytest.approx(roof + ROOF_GAP, abs=0.01), kind
        assert all(b["groundBase"] == 1999 for b in over)
        assert all("groundBase" not in b for b in out if not b.get("raised"))
