import math

import numpy as np
from shapely.geometry import LineString

from ski_sim_pipeline.config import Extent
from ski_sim_pipeline.grading import MAX_CROSS, climb, grade, non_increasing
from ski_sim_pipeline.grid import Grid, sample_bilinear

GRID = Grid(Extent(-200, 800, -300, 300), 4)


def terrain(fn) -> np.ndarray:
    east, north = GRID.coords()
    e, n = np.meshgrid(east, north)
    return fn(e, n).astype(np.float32)


def run(coords, difficulty=2, name="Test") -> dict:
    return {"name": name, "difficulty": difficulty, "lines": [LineString(coords)], "areas": []}


def at(heights, e, n):
    return sample_bilinear(heights, GRID, np.atleast_1d(e), np.atleast_1d(n))


def test_non_increasing_fit():
    z = np.array([10.0, 9.0, 9.5, 8.0, 8.4, 7.0])
    fit = non_increasing(z)
    assert np.all(np.diff(fit) <= 1e-9)
    assert fit[0] == 10.0 and fit[-1] == 7.0
    assert climb(z) == 0.0 and climb(np.array([5.0, 4.0, 6.0])) == 2.0


def test_a_traverse_is_benched_into_the_side_slope_mostly_built_up():
    # 25° slope falling to the north; a blue run traverses it eastwards, gently down.
    side = math.tan(math.radians(25))
    heights = terrain(lambda e, n: 2000 + side * n - 0.06 * e)
    before = heights.copy()
    grade([run([(0, 0), (600, 0)])], heights, GRID)

    for e in (150, 300, 450):
        # Across the bench: within the blue's cross-slope limit.
        up, down = at(heights, e, 3.0)[0], at(heights, e, -3.0)[0]
        assert abs(up - down) / 6 <= math.tan(math.radians(MAX_CROSS[2])) + 0.02
        # Built up: at the bench edges, far more fill below than cut above.
        cut = at(before, e, 9.0)[0] - at(heights, e, 9.0)[0]
        fill = at(heights, e, -9.0)[0] - at(before, e, -9.0)[0]
        assert fill > 3 * cut > 0
    # Untouched well away from the run.
    assert at(heights, 300, 120)[0] == at(before, 300, 120)[0]
    assert at(heights, 300, -120)[0] == at(before, 300, -120)[0]


def test_a_bump_on_the_run_is_graded_away_but_a_real_climb_stays():
    def ground(e, n):
        bump = 2.0 * np.exp(-(((e - 200) / 25) ** 2))  # a 2 m hump
        ridge = 30.0 * np.exp(-(((e - 500) / 60) ** 2))  # a real 30 m rise
        return 2000 - 0.08 * e + bump + ridge

    heights = terrain(ground)
    grade([run([(0, 0), (700, 0)])], heights, GRID)
    es = np.arange(20, 380, 4.0)
    assert climb(at(heights, es, np.zeros_like(es))) == 0.0
    es = np.arange(380, 680, 4.0)
    assert climb(at(heights, es, np.zeros_like(es))) > 10  # the ridge still climbs


def test_pistes_drawn_uphill_are_graded_downhill():
    heights = terrain(lambda e, n: 2000 - 0.05 * e + 1.5 * np.sin(e / 15))
    grade([run([(650, 0), (20, 0)])], heights, GRID)
    es = np.arange(40, 620, 4.0)
    assert climb(at(heights, es, np.zeros_like(es))) == 0.0
