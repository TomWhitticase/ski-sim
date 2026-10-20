import numpy as np
import rasterio
from rasterio.transform import from_origin

from ski_sim_pipeline.sources import ign


def test_the_rge_alti_source_mask_flags_the_foreign_fill(tmp_path):
    rgb = np.zeros((3, 4, 6), dtype=np.uint8)
    rgb[:, :, :3] = np.array([255, 100, 20], dtype=np.uint8)[:, None, None]  # French survey
    rgb[:, :, 3:] = np.array([225, 80, 200], dtype=np.uint8)[:, None, None]  # foreign fill
    rgb[:, 0, 5] = 0  # no source at all
    path = tmp_path / "src.tif"
    transform = from_origin(1_000_000, 6_550_000, 8, 8)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=6,
        height=4,
        count=3,
        dtype="uint8",
        crs=ign.CRS,
        transform=transform,
    ) as dst:
        dst.write(rgb)
    mask, t = ign.foreign_mask(path)
    assert t == transform
    assert (mask[:, :3] == 0).all() and (mask[:, 3:] == 1).all()


def test_only_rge_alti_has_a_source_mask():
    assert ign.LAYERS["ign-rge-alti"].source_layer is not None
    assert ign.LAYERS["ign-lidar-hd"].source_layer is None
