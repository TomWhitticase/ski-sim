import numpy as np
import pytest
from shapely.geometry import LineString

from mountain_pipeline.config import Extent
from mountain_pipeline.grid import Grid
from mountain_pipeline.pistes import (
    DIFFICULTY_COLOURS,
    _start_heading,
    lookup_image,
    overlay_image,
    rasterise,
)


def test_start_heading_follows_the_run_not_the_straight_line_to_its_bottom():
    # Run starts heading east, then hooks round to finish far to the south-west.
    line = LineString([(0, 0), (200, 0), (200, -500), (-800, -800)])

    def ground(e, n):
        # Falls away along the line's path: lower to the east first.
        return 3000 - np.asarray(e) * 0.3 + np.asarray(n) * 0.5

    heading = _start_heading([line], (0, 0), ground)
    assert heading == pytest.approx(90, abs=1)


def test_rasterise_overlay_and_lookup():
    # 2 m fine grid; runs centred on north = -12 (fine row 6, 4 m row 3) and north = -28.
    grid = Grid(Extent(0, 40, -40, 0), 2)
    pistes = [
        {"index": 1, "difficulty": 3, "groomed": True},
        {"index": 2, "difficulty": 6, "groomed": False},
    ]
    shapes = [
        (1, LineString([(0, -12), (40, -12)]).buffer(5), False, None),
        (2, LineString([(0, -28), (40, -28)]).buffer(5), False, None),
    ]
    fine = rasterise(shapes, grid)
    assert fine[6, 10] == 1
    assert fine[14, 10] == 2
    assert fine[10, 10] == 0

    overlay = np.asarray(overlay_image(fine, pistes, 2))  # 4 m cells
    assert overlay.shape == (11, 11, 4)
    assert overlay[3, 5, 3] == 255  # fully inside the red run
    assert tuple(overlay[3, 5, :3]) == DIFFICULTY_COLOURS[3]
    assert overlay[5, 5, 3] == 0  # between runs
    assert overlay[7, 5, 3] == 0  # freeride: not groomed, so no overlay

    lookup = np.asarray(lookup_image(fine, pistes, 2))
    assert lookup[3, 5, 0] == 1 and lookup[3, 5, 2] == 3
    assert lookup[7, 5, 0] == 2 and lookup[7, 5, 2] == 6


def test_named_runs_win_over_unnamed_connectors():
    grid = Grid(Extent(0, 40, -40, 0), 2)
    runs = [{"index": 1, "name": "Christine"}, {"index": 2, "name": None}]
    blob = LineString([(0, -20), (40, -20)]).buffer(6)
    # Unnamed listed last would normally overwrite; the named run must still win.
    fine = rasterise([(1, blob, False, None), (2, blob, False, None)], grid, runs)
    assert fine[10, 10] == 1


def test_named_centrelines_win_over_unnamed_areas():
    grid = Grid(Extent(0, 40, -40, 0), 2)
    runs = [{"index": 1, "name": "Christine"}, {"index": 2, "name": None}]
    blob = LineString([(0, -20), (40, -20)]).buffer(6)
    fine = rasterise([(1, blob, False, None), (2, blob, True, None)], grid, runs)
    assert fine[10, 10] == 1
