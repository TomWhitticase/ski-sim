import numpy as np
import pytest

from mountain_pipeline.config import Extent
from mountain_pipeline.grid import Grid, sample_bilinear, stitch_far_to_near


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
