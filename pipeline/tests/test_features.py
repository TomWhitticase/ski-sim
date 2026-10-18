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
