import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from ski_sim_pipeline import heights
from ski_sim_pipeline.config import GeoPoint
from ski_sim_pipeline.features import gable_roof
from ski_sim_pipeline.frame import LocalFrame
from ski_sim_pipeline.sources import ign


def test_heights_come_from_the_lidar_eaves_and_ridge(tmp_path, monkeypatch):
    """A gabled chalet 20 x 10 m whose lidar roof runs from 6 m at the eaves to 10 m at the
    ridge, and a flat-roofed block 15 m high: their walls and roofs follow the MNH."""
    from pyproj import Transformer

    frame = LocalFrame(GeoPoint(45.3, 6.58))
    to_l93 = Transformer.from_crs(frame.crs, ign.CRS, always_xy=True)
    x0, y0 = to_l93.transform(0.0, 0.0)
    tile_x = np.floor(x0 / ign.MNH_TILE) * ign.MNH_TILE
    tile_y = np.floor(y0 / ign.MNH_TILE) * ign.MNH_TILE
    size = int(ign.MNH_TILE)
    xs = tile_x + np.arange(size) + 0.5
    ys = tile_y + size - np.arange(size) - 0.5
    gx, gy = np.meshgrid(xs, ys)
    # Back to local metres for each pixel, to paint the two roofs where they stand.
    to_local = Transformer.from_crs(ign.CRS, frame.crs, always_xy=True)
    le, ln = to_local.transform(gx, gy)
    mnh = np.zeros((size, size), dtype=np.float32)
    chalet = (le >= 0) & (le <= 20) & (ln >= 0) & (ln <= 10)
    mnh[chalet] = 10 - 4 * np.abs(ln[chalet] - 5) / 5  # ridge along east at north 5
    block = (le >= 50) & (le <= 80) & (ln >= 0) & (ln <= 20)
    mnh[block] = 15
    path = tmp_path / "mnh.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=size,
        height=size,
        count=1,
        dtype="float32",
        crs=ign.CRS,
        transform=from_origin(tile_x, tile_y + size, 1, 1),
        nodata=-9999,
    ) as dst:
        dst.write(mnh, 1)
    monkeypatch.setattr(ign, "fetch_mnh_tile", lambda x, y, cell, raw: path)

    def ground(e, n):
        return np.full(np.shape(e), 2000.0)

    def building(i, ring):
        from shapely.geometry import Polygon

        return {
            "id": i,
            "type": "yes",
            "footprint": ring,
            "base": 1999,
            "top": 2020,
            "heightSource": "estimate",
            "roof": gable_roof(Polygon(ring), "yes", None),
        }

    b1 = building(1, [[0, 0], [20, 0], [20, 10], [0, 10]])
    b2 = building(2, [[50, 0], [80, 0], [80, 20], [50, 20]])
    stats = heights.apply([b1, b2], frame, tmp_path, ground)
    assert stats["lidar"] == 2 and stats["flat"] == 1
    assert b1["heightSource"] == "lidar"
    assert b1["top"] == pytest.approx(2000 + 7.0, abs=0.8)  # eaves (25th percentile)
    assert b1["top"] + b1["roof"]["rise"] == pytest.approx(2000 + 10, abs=0.8)
    assert b2["roof"] is None and b2["top"] == pytest.approx(2015, abs=0.2)
