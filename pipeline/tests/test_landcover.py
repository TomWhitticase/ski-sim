import numpy as np
import pytest
import rasterio
from affine import Affine
from shapely.geometry import LineString

from ski_sim_pipeline.config import Extent, GeoPoint
from ski_sim_pipeline.frame import LocalFrame
from ski_sim_pipeline.grid import Grid
from ski_sim_pipeline.landcover import clearings, encode, fractions, soften, tree_line
from ski_sim_pipeline.sources import worldcover


def test_tile_names_use_the_south_west_corner():
    assert worldcover.tile_name(45, 6) == "ESA_WorldCover_10m_2021_v200_N45E006_Map"
    assert worldcover.tile_name(-42, -72) == "ESA_WorldCover_10m_2021_v200_S42W072_Map"


def test_fractions_average_classes_onto_the_local_grid(tmp_path):
    # A 0.01° square of WorldCover around the origin: forest to the west, bare rock to the
    # east, and a lake in the north-east corner.
    origin = GeoPoint(45.0, 6.0)
    n = 120
    classes = np.full((n, n), worldcover.TREE_COVER, dtype=np.uint8)
    classes[:, n // 2 :] = worldcover.BARE
    classes[: n // 4, 3 * n // 4 :] = worldcover.WATER
    path = tmp_path / "wc.tif"
    deg = 0.01 / n
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        dtype="uint8",
        count=1,
        width=n,
        height=n,
        crs="EPSG:4326",
        transform=Affine(deg, 0, 5.995, 0, -deg, 45.005),
        nodata=0,
    ) as dst:
        dst.write(classes, 1)

    grid = Grid(Extent(-300, 300, -400, 400), 8)
    layers = fractions([path], grid, LocalFrame(origin))
    row = grid.height // 2
    west, east = grid.width // 4, 3 * grid.width // 4
    assert layers["tree"][row, west] == pytest.approx(1)
    assert layers["tree"][row, east] == pytest.approx(0)
    assert layers["rock"][row, east] == pytest.approx(1)
    assert layers["water"][6, 70] == pytest.approx(1)  # 350 m north, 260 m east
    # Fractions of one classification: never more than 1 between them.
    assert sum(layers.values()).max() <= 1 + 1e-5


def test_encode_packs_ice_and_water_into_blue_around_mid_grey():
    shape = (1, 4)
    layers = {
        "tree": np.array([[1, 0, 0, 0.5]]),
        "rock": np.array([[0, 1, 0, 0]]),
        "ice": np.array([[0, 0, 1, 0]]),
        "water": np.array([[0, 0, 0, 1]]),
    }
    rgb = np.asarray(encode({k: v.reshape(shape) for k, v in layers.items()}))
    assert rgb.shape == (1, 4, 3)
    assert rgb[0, 0].tolist() == [255, 0, 128]
    assert rgb[0, 1].tolist() == [0, 255, 128]
    assert rgb[0, 2, 2] == 255  # ice
    assert rgb[0, 3, 2] == 0  # water
    assert rgb[0, 3, 0] == 128  # half tree cover


def test_clearings_cut_groomed_pistes_lifts_and_buildings_not_itineraries():
    grid = Grid(Extent(0, 400, 0, 400), 8)
    piste = LineString([(0, 50), (400, 50)]).buffer(15)
    itinerary = LineString([(0, 350), (400, 350)]).buffer(10)
    lift = {
        "type": "chair_lift",
        "supports": [{"east": 200, "north": 100}, {"east": 200, "north": 300}],
        "terminals": [],
    }
    building = {"footprint": [[50, 200], [70, 200], [70, 220], [50, 220]]}
    cleared = clearings(
        grid, [(1, piste, False, None), (2, itinerary, False, None)], {1}, [lift], [building]
    )

    def at(east, north):
        return cleared[round((400 - north) / 8), round(east / 8)]

    assert at(100, 50) and at(100, 66)  # piste plus margin
    assert not at(100, 350)  # freeride itineraries run through the trees
    assert at(200, 200) and at(208, 200)  # lift corridor
    assert not at(240, 200)
    assert at(60, 210) and not at(100, 210)  # building


def test_clearings_cut_restaurant_terraces():
    grid = Grid(Extent(0, 400, 0, 400), 8)
    deck = [[100, 100], [120, 100], [120, 107], [100, 107]]
    cleared = clearings(grid, [], set(), [], [], [deck])
    assert cleared[round((400 - 104) / 8), round(110 / 8)]
    assert not cleared[round((400 - 104) / 8), round(200 / 8)]


def test_tree_line_ignores_a_few_stray_high_cells():
    heights = np.linspace(1000, 3000, 10_000).reshape(100, 100)
    tree = (heights < 2100).astype(np.float32)
    tree[0, 0] = 1  # lowest cell anyway
    tree[-1, -1] = 1  # one "tree" at 3000 m: shadowed rock misclassified
    line = tree_line(tree, heights)
    assert 2050 < line < 2110
    assert tree_line(np.zeros_like(tree), heights) is None


def test_soften_keeps_totals_away_from_edges():
    values = np.zeros((9, 9), dtype=np.float32)
    values[4, 4] = 9
    blurred = soften(values)
    assert blurred[3:6, 3:6] == pytest.approx(np.ones((3, 3)))
    assert blurred.sum() == pytest.approx(9)
