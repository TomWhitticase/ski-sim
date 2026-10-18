import numpy as np
import pytest

from mountain_pipeline.features import LIFT_PROFILES, estimate_height, place_supports


def flat(height: float):
    return lambda east, north: np.full(np.shape(east), height, dtype=float)


def test_short_lift_on_flat_ground_needs_no_extra_towers():
    points = np.array([[0.0, 0.0], [200.0, 0.0]])
    supports = place_supports(points, flat(2000), LIFT_PROFILES["chair_lift"])
    assert [s["kind"] for s in supports] == ["station", "station"]
    assert supports[0]["top"] == 2005  # station cable height


def test_osm_intermediate_nodes_become_towers():
    points = np.array([[0.0, 0.0], [150.0, 0.0], [300.0, 0.0]])
    supports = place_supports(points, flat(2000), LIFT_PROFILES["chair_lift"])
    assert [s["kind"] for s in supports] == ["station", "tower", "station"]
    assert supports[1]["top"] == 2011


def test_long_spans_are_split():
    points = np.array([[0.0, 0.0], [1000.0, 0.0]])
    supports = place_supports(points, flat(2000), LIFT_PROFILES["chair_lift"])
    gaps = np.diff([s["east"] for s in supports])
    assert supports[1]["kind"] == "synthetic-tower"
    assert gaps.max() <= LIFT_PROFILES["chair_lift"].max_span


def test_towers_keep_cable_clear_of_a_ridge():
    # A 30 m bump halfway along a 250 m gondola.
    def ridge(east, north):
        return 2000 + 30 * np.exp(-(((np.asarray(east) - 125) / 20) ** 2))

    profile = LIFT_PROFILES["gondola"]
    supports = place_supports(np.array([[0.0, 0.0], [250.0, 0.0]]), ridge, profile)
    assert any(s["kind"] == "synthetic-tower" for s in supports)
    for a, b in zip(supports, supports[1:], strict=False):
        t = np.linspace(0, 1, 200)
        east = a["east"] + (b["east"] - a["east"]) * t
        cable = a["top"] + (b["top"] - a["top"]) * t
        assert (cable - ridge(east, 0)).min() >= profile.min_clearance - 1.0


@pytest.mark.parametrize(
    ("tags", "area", "expected"),
    [
        ({"building": "yes", "height": "12 m"}, 100, (12.0, "osm-height")),
        ({"building": "apartments", "building:levels": "6"}, 500, (19.5, "osm-levels")),
        ({"building": "chapel"}, 50, (7.0, "estimate")),
        ({"building": "yes"}, 20, (3.5, "estimate")),
        ({"building": "yes"}, 2000, (20.0, "estimate")),
        ({"aerialway": "station"}, 300, (8.0, "estimate")),
    ],
)
def test_estimate_height(tags, area, expected):
    assert estimate_height(tags, area) == expected


def test_peaks_snap_to_summit_and_filter_far_minor_peaks():
    from mountain_pipeline.config import Extent, GeoPoint
    from mountain_pipeline.features import extract_peaks
    from mountain_pipeline.frame import LocalFrame
    from mountain_pipeline.grid import Grid

    frame = LocalFrame(GeoPoint(45.0, 6.0))
    near_grid = Grid(Extent(-500, 500, -500, 500), 10)
    far_grid = Grid(Extent(-20000, 20000, -20000, 20000), 100)
    near = np.full((near_grid.height, near_grid.width), 2000.0)
    near[50, 52] = 2500.0  # true summit 20 m east of the origin
    far = np.full((far_grid.height, far_grid.width), 1000.0)

    def node(i, name, east, north, ele):
        lon, lat = frame.to_lonlat(east, north)
        return {"type": "node", "id": i, "lat": lat, "lon": lon, "tags": {"name": name, "ele": ele}}

    peaks = extract_peaks(
        [
            node(1, "Near", 0, 0, "2501"),
            node(2, "Far big", 10000, 0, "3900"),
            node(3, "Far small", -10000, 0, "2900"),
        ],
        frame,
        near,
        near_grid,
        far,
        far_grid,
    )
    by_name = {p["name"]: p for p in peaks}
    assert set(by_name) == {"Near", "Far big"}
    assert by_name["Near"]["east"] == pytest.approx(20)
    assert by_name["Near"]["ground"] == 2500
    assert by_name["Near"]["ele"] == 2501


@pytest.mark.parametrize(
    ("value", "seconds"),
    [("04:45", 285), ("3", 180), ("12", 720), ("1:02:00", 3720), ("abc", None), (None, None)],
)
def test_parse_duration(value, seconds):
    from mountain_pipeline.features import parse_duration

    assert parse_duration(value) == seconds


def test_lift_specs():
    from mountain_pipeline.features import lift_specs

    specs = lift_specs(
        {
            "aerialway:occupancy": "6",
            "aerialway:capacity": "4000",
            "aerialway:duration": "04:45",
            "aerialway:bubble": "no",
        }
    )
    assert specs == {"occupancy": 6, "capacity": 4000.0, "duration": 285.0, "bubble": False}
    assert lift_specs({})["occupancy"] is None


def test_gable_roof_ridge_runs_along_the_long_side():
    from shapely.geometry import Polygon

    from mountain_pipeline.features import gable_roof

    roof = gable_roof(Polygon([(0, 0), (20, 0), (20, 8), (0, 8)]), "yes", None)
    (ax, ay), (bx, by) = roof["ridge"]
    assert ay == pytest.approx(4) and by == pytest.approx(4)  # ridge along x, mid-depth
    assert roof["halfWidth"] == pytest.approx(4)
    assert len(roof["faces"]) == 2
    assert roof["rise"] == pytest.approx(4 * np.tan(np.radians(24)), abs=0.01)


def test_l_shaped_footprints_split_into_planar_faces():
    from shapely.geometry import Polygon

    from mountain_pipeline.features import gable_roof

    roof = gable_roof(
        Polygon([(0, 0), (30, 0), (30, 10), (10, 10), (10, 25), (0, 25)]), "yes", None
    )
    assert roof is not None
    assert sum(Polygon(f).area for f in roof["faces"]) == pytest.approx(30 * 10 + 10 * 15, rel=1e-3)


def test_large_industrial_buildings_keep_flat_roofs():
    from shapely.geometry import Polygon

    from mountain_pipeline.features import gable_roof

    assert gable_roof(Polygon([(0, 0), (40, 0), (40, 30), (0, 30)]), "industrial", None) is None


def test_duplicate_footprints_are_merged():
    from mountain_pipeline.features import dedupe_buildings

    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    nearly = [[0.2, 0], [10, 0], [10, 10], [0.2, 10]]
    apart = [[50, 0], [60, 0], [60, 10], [50, 10]]
    b = lambda fp, t, top: {"footprint": fp, "type": t, "top": top, "base": 0}  # noqa: E731
    out = dedupe_buildings(
        [b(square, "yes", 10), b(nearly, "lift_station", 14), b(apart, "yes", 5)]
    )
    assert len(out) == 2
    merged = next(x for x in out if x["footprint"] == square)
    assert merged["top"] == 14 and merged["type"] == "lift_station"
