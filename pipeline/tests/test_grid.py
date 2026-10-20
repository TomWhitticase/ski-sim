import numpy as np
import pytest

from ski_sim_pipeline.config import Extent
from ski_sim_pipeline.grid import Grid, sample_bilinear, stitch_far_to_near


def plane(grid: Grid) -> np.ndarray:
    east, north = grid.coords()
    return (1000 + 0.5 * east - 0.25 * north + 0 * east * north).astype(np.float64)


def test_dimensions_are_grid_registered():
    grid = Grid(Extent(-100, 100, -50, 50), 10)
    assert (grid.width, grid.height) == (21, 11)
    # Pixel centre of (0, 0) is the north-west grid point.
    x, y = grid.transform * (0.5, 0.5)
    assert (x, y) == (-100, 50)


def test_bilinear_is_exact_on_a_plane():
    grid = Grid(Extent(-100, 100, -50, 50), 10)
    heights = plane(grid)
    east = np.array([-100.0, 3.7, 99.9, 0.0])
    north = np.array([50.0, -12.3, -49.9, 0.0])
    expected = 1000 + 0.5 * east - 0.25 * north
    assert sample_bilinear(heights, grid, east, north) == pytest.approx(expected)


def test_stitch_replaces_far_inside_near_extent():
    far_grid = Grid(Extent(-1000, 1000, -1000, 1000), 100)
    near_grid = Grid(Extent(-300, 300, -300, 300), 10)
    far = np.zeros((far_grid.height, far_grid.width))
    near = plane(near_grid)
    stitch_far_to_near(far, far_grid, near, near_grid)
    east, north = np.broadcast_arrays(*far_grid.coords())
    inside = (np.abs(east) <= 300) & (np.abs(north) <= 300)
    assert far[inside] == pytest.approx(1000 + 0.5 * east[inside] - 0.25 * north[inside])
    assert (far[~inside] == 0).all()


def test_despike_fills_a_ring_of_pits_but_keeps_a_cliff():
    import numpy as np

    from ski_sim_pipeline.grid import despike

    e, n = np.meshgrid(np.arange(40.0), np.arange(40.0))
    heights = (2000 + np.where(e > 20, 60.0, 0.0) + 0.1 * n).astype(np.float32)  # a 60 m cliff
    clean = heights.copy()
    ring = np.abs(np.hypot(e - 10, n - 20) - 4) < 0.8
    heights[ring] -= 150
    assert despike(heights) >= ring.sum()
    assert np.abs(heights - clean).max() < 1.0


def test_grow_widens_a_mask_by_whole_cells():
    from ski_sim_pipeline.grid import grow

    mask = np.zeros((7, 7), dtype=bool)
    mask[3, 3] = True
    grown = grow(mask, 2)
    assert grown[1:6, 1:6].all() and grown.sum() == 25
