import numpy as np
import pytest
from shapely.geometry import Polygon

from ski_sim_pipeline.config import Extent, GeoPoint
from ski_sim_pipeline.features import gable_roof
from ski_sim_pipeline.frame import LocalFrame
from ski_sim_pipeline.grid import Grid, sample_bilinear
from ski_sim_pipeline.restaurants import extract, on_mountain, terrace


@pytest.mark.parametrize(
    ("piste", "above", "neighbours", "expected"),
    [
        (40, 150, 10, True),  # up on the mountain beside a run
        (20, 0, 5, True),  # ski-in at the bottom of a run
        (20, 0, 45, False),  # by the piste, but in the village centre
        (100, 10, 5, False),  # in the village
        (400, 600, 0, False),  # remote hut far from any piste
    ],
)
def test_on_mountain(piste, above, neighbours, expected):
    assert on_mountain(piste, above, neighbours) == expected


def slope(east, north):
    """Falls 0.3 m per metre towards the south."""
    return 2000.0 + np.asarray(north, dtype=float) * 0.3


def test_terrace_faces_downhill_and_avoids_the_piste():
    hut = Polygon([(-8, -5), (8, -5), (8, 5), (-8, 5)])
    deck = terrace(hut, slope, [], [], [])
    assert deck["source"] == "synthetic"
    ring = np.asarray(deck["ring"])
    assert ring[:, 1].max() <= -4  # south (downhill) side
    # Deck level with the ground at the wall, posts down to the slope below.
    assert deck["top"] == pytest.approx(slope(0, -5) + 0.3, abs=0.2)

    from shapely.geometry import LineString

    piste = LineString([(-30, -8), (30, -8)])
    deck = terrace(hut, slope, [piste], [], [])
    assert deck is None or np.asarray(deck["ring"])[:, 1].min() >= -5


def test_mapped_outdoor_seating_is_used():
    hut = Polygon([(-8, -5), (8, -5), (8, 5), (-8, 5)])
    seating = Polygon([(-6, 5), (6, 5), (6, 12), (-6, 12)])
    deck = terrace(hut, slope, [], [], [seating])
    assert deck["source"] == "osm"


def test_eaves_overhang_the_walls():
    walls = Polygon([(-8, -5), (8, -5), (8, 5), (-8, 5)])
    plain = gable_roof(walls, "yes", None)
    hut = gable_roof(walls, "restaurant", None, pitch=22, eaves=1.3)
    assert hut["halfWidth"] == plain["halfWidth"]  # ridge from the walls, not the eaves
    covered = Polygon(np.vstack(hut["faces"][0] + hut["faces"][1])).convex_hull
    assert covered.area == pytest.approx(18.6 * 12.6, rel=0.02)
    assert hut["eaves"] == 1.3


def test_extract_keeps_mountain_huts_and_attaches_buildings():
    frame = LocalFrame(GeoPoint(45.0, 6.0))

    def node(i, name, east, north, amenity="restaurant"):
        lon, lat = frame.to_lonlat(east, north)
        return {
            "type": "node",
            "id": i,
            "lat": lat,
            "lon": lon,
            "tags": {"name": name, "amenity": amenity},
        }

    buildings = [
        {
            "id": 7,
            "type": "yes",
            "footprint": [[492, 495], [508, 495], [508, 505], [492, 505]],
            "base": 2148.0,
            "top": 2155.0,
            "heightSource": "estimate",
            "roof": gable_roof(
                Polygon([(492, 495), (508, 495), (508, 505), (492, 505)]), "yes", None
            ),
        }
    ]
    pistes = [{"lines": [[[450, 400], [550, 400]]], "areas": []}]
    bases = [{"name": "Village", "east": 0, "north": 0, "ground": 1800.0}]
    grid = Grid(Extent(-1000, 1000, -1000, 1000), 2.0)
    north = grid.extent.north - np.arange(grid.height)[:, None] * grid.cell_size
    heights = np.broadcast_to(slope(0, north), (grid.height, grid.width)).copy()
    out = extract(
        [
            node(1, "Hut", 500, 500),
            node(2, "Hut", 505, 502, "bar"),  # same place, mapped twice
            node(3, "Village Bar", 10, 0, "pub"),
            node(4, "Shop", 500, 450, "pharmacy"),
        ],
        frame,
        grid.extent,
        heights,
        grid,
        buildings,
        [],
        pistes,
        bases,
    )
    assert [r["name"] for r in out] == ["Hut"]
    assert out[0]["building"] == 7
    assert buildings[0]["use"] == "restaurant"
    assert buildings[0]["roof"]["eaves"] > 0
    assert out[0]["sign"] is not None
    # The hut stands on a levelled site cut into the slope.
    under = sample_bilinear(heights, grid, np.array([494.0, 506.0]), np.array([496.0, 504.0]))
    assert abs(under[1] - under[0]) < 0.2
    assert buildings[0]["base"] == pytest.approx(under.min() - 1, abs=0.2)
