from ski_sim_pipeline import borders
from ski_sim_pipeline.config import Extent, GeoPoint
from ski_sim_pipeline.frame import LocalFrame


def test_chain_joins_ways_whichever_way_round_they_are_drawn():
    a = [(0.0, 0.0), (1.0, 0.0)]
    b = [(2.0, 0.0), (1.0, 0.0)]  # reversed
    c = [(2.0, 0.0), (3.0, 0.0)]
    lines = borders.chain([a, c, b])
    assert len(lines) == 1
    line = lines[0]
    assert {line[0], line[-1]} == {(0.0, 0.0), (3.0, 0.0)}
    assert len(line) == 4
    # Disconnected ways stay separate.
    assert len(borders.chain([a, [(5.0, 5.0), (6.0, 6.0)]])) == 2


def test_border_ways_skip_the_second_copy_of_a_shared_way():
    way = {"type": "way", "id": 7, "geometry": [{"lat": 1, "lon": 2}, {"lat": 3, "lon": 4}]}
    assert borders.border_ways([way, dict(way)]) == [[(2, 1), (4, 3)]]


def test_clip_keeps_the_part_on_the_map_and_drops_scraps():
    frame = LocalFrame(GeoPoint(45.0, 6.0))
    extent = Extent(-1000, 1000, -1000, 1000)
    west, _ = frame.to_lonlat(-3000, 0)
    east, _ = frame.to_lonlat(3000, 0)
    _, lat = frame.to_lonlat(0, 0)
    lines = borders.clip([[(west, lat), (east, lat)]], frame, extent)
    assert len(lines) == 1
    xs = [p[0] for p in lines[0]]
    assert min(xs) == -1000 and max(xs) == 1000
    # A line just clipping a corner (under MIN_LENGTH on the map) is dropped.
    corner = [frame.to_lonlat(950, 1100), frame.to_lonlat(1100, 950)]
    assert borders.clip([corner], frame, extent) == []


def test_side_points_are_left_and_right_of_the_middle():
    # Heading north: left is west, right is east.
    left, right = borders.side_points([(0.0, 0.0), (0.0, 1000.0)])
    assert left[0] < -250 and abs(left[1] - 500) < 1
    assert right[0] > 250 and abs(right[1] - 500) < 1


def test_build_labels_each_side():
    frame = LocalFrame(GeoPoint(45.0, 6.0))
    extent = Extent(-2000, 2000, -2000, 2000)
    nodes = [frame.to_lonlat(0, n) for n in (-3000, 0, 3000)]
    way = {
        "type": "way",
        "id": 1,
        "geometry": [{"lon": lon, "lat": lat} for lon, lat in nodes],
    }

    def lookup(query: str) -> list[dict]:
        assert query.count("is_in(") == 2
        return [
            {"type": "area", "tags": {"name": "Italia", "name:en": "Italy"}},
            {"type": "sep", "tags": {"n": "0"}},
            {"type": "area", "tags": {"name": "France"}},
            {"type": "sep", "tags": {"n": "1"}},
        ]

    out = borders.build([way], frame, extent, lookup)
    assert len(out) == 1
    assert out[0]["left"] == "Italy" and out[0]["right"] == "France"
    assert out[0]["line"][0][1] == -2000 and out[0]["line"][-1][1] == 2000


def test_no_border_no_query():
    def lookup(query: str) -> list[dict]:
        raise AssertionError("no lookup without borders")

    frame = LocalFrame(GeoPoint(45.0, 6.0))
    assert borders.build([], frame, Extent(-1, 1, -1, 1), lookup) == []


def test_countries_reads_a_point_with_no_country_as_none():
    elements = [{"type": "sep", "tags": {"n": "0"}}, {"type": "sep", "tags": {"n": "1"}}]
    assert borders.countries(elements, 2) == [None, None]
