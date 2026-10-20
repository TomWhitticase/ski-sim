import numpy as np
import pytest

from ski_sim_pipeline.export import encode_heights
from ski_sim_pipeline.minimap import downsample


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


def test_dashes_are_even_whatever_the_vertex_spacing():
    import math

    from ski_sim_pipeline.minimap import dashes

    # Uneven vertices (1 px, then 30 px, then a bend, then 0.5 px steps).
    line = [(0, 0), (1, 0), (31, 0), (31, 20)] + [(31 + 0.5 * i, 20) for i in range(1, 41)]
    out = dashes(line, 7, 5)
    lengths = [sum(math.dist(a, b) for a, b in zip(d, d[1:], strict=False)) for d in out]
    assert all(abs(n - 7) < 1e-6 for n in lengths[:-1])  # the last one may be cut short
    assert lengths[-1] <= 7 + 1e-6
    # Each dash starts 12 px (7 on + 5 off) along the line after the one before.
    assert out[1][0] == (12, 0)
    assert len(out) == math.ceil(71 / 12)
