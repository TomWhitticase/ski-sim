import numpy as np
import pytest

from mountain_pipeline.export import encode_heights
from mountain_pipeline.minimap import downsample


def test_encode_round_trip_within_half_quantum():
    heights = np.random.default_rng(0).uniform(880, 3561, size=(64, 64)).astype(np.float32)
    encoded, offset, scale = encode_heights(heights)
    assert encoded.dtype == np.dtype("<u2")
    assert scale == 0.05
    decoded = offset + encoded.astype(np.float64) * scale
    assert np.abs(decoded - heights).max() <= scale / 2 + 1e-3


def test_encode_picks_coarser_scale_for_large_ranges():
    _, _, scale = encode_heights(np.array([[200.0, 4808.0]]))
    assert scale == 0.1


def test_encode_rejects_nan():
    with pytest.raises(ValueError):
        encode_heights(np.array([[1.0, np.nan]]))


def test_downsample_block_mean():
    a = np.arange(16, dtype=float).reshape(4, 4)
    assert downsample(a, 2).tolist() == [[2.5, 4.5], [10.5, 12.5]]
