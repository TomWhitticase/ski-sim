"""Grade pistes into the terrain the way they're built.

Runs that traverse a mountainside aren't skied on the raw slope: they're benched into it
like a road, mostly built up with packed snow on the downhill side rather than cut into
the rock above, and graded so they keep going downhill. The lidar shows the mountain
(often without the bench, at 4 m), so this rebuilds that per piste centreline:

1. Across: fit the terrain's cross-slope along the run and limit it to MAX_CROSS for the
   piste's difficulty. Where that takes earthworks, the bench narrows (down to
   MIN_HALF_WIDTH, as real cat tracks do on steep sides) so no edge is more than
   MAX_BENCH off the slope, and it's raised (BUILD_UP) so most of it is fill.
2. Along: the centreline profile is fitted to never go uphill, preferably descending at
   least a gliding grade (MIN_GRADES), within MAX_FILL / MAX_CUT of the ground. Where a
   run really climbs further than that, it's left climbing.
3. Into the heightmap: the bench replaces the terrain; beyond its edges a packed-snow
   fill bank (TAN_FILL) or a cut bank (TAN_CUT) closes the gap to the natural slope.

Where a run is also mapped as an area, the bench takes the area's width; areas wider
than OPEN_SLOPE are open slopes and are left alone, as are freeride itineraries. This
runs before terminals are flattened, so station pads win.
"""

from __future__ import annotations

import logging
import math

import numpy as np
from rasterio import features as rio_features
from rasterio.windows import Window
from rasterio.windows import transform as window_transform
from shapely import contains_xy
from shapely.geometry import LineString, MultiLineString, Polygon
from shapely.ops import linemerge, unary_union

from .grid import Grid, sample_bilinear

log = logging.getLogger(__name__)

STEP = 4.0  # centreline station spacing (m)
#: Steepest cross-slope left on the run, by difficulty code (green .. black).
MAX_CROSS = {1: 4.0, 2: 5.0, 3: 8.0, 4: 12.0, 5: 14.0}
MIN_HALF_WIDTH = 4.0
MAX_BENCH = 4.0  # the bench edge stays within this of the natural slope (m)
BUILD_UP = 0.6  # raise the bench by this share of its edge offset: mostly fill, little cut
#: How fast a bank closes the height gap to the natural slope (m per m out).
TAN_FILL = 0.65  # packed-snow fill
TAN_CUT = 0.85  # cut
#: Grades (drop per metre) the profile tries for, steepest first; 5% keeps you gliding.
MIN_GRADES = (0.05, 0.03, 0.0)
MAX_FILL = 5.0
MAX_CUT = 3.0
TAPER = 15.0  # fade the grading in/out over this at the line's ends (m)
SMOOTH = 9  # stations
CROSS_SAMPLES = 9
MAX_SIDE = 1.7  # cross-slope (tan, ~60°) beyond which a run isn't benched
BANK_REACH = 25.0  # how far beyond the bench a bank can reach (m)
MIN_LENGTH = 30.0
OPEN_SLOPE = 50.0  # a mapped piste area wider than this is an open slope, not a road (m)
AREA_STEP = 2.0
TURN = 20.0  # a merged line rising or falling back this far is split there (m)


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    if len(x) < 3 or k < 2:
        return x.copy()
    k = min(k, len(x) - (1 - len(x) % 2))
    pad = k // 2
    padded = np.pad(x, pad, mode="edge")
    return np.convolve(padded, np.ones(k) / k, mode="valid")[: len(x)]


def non_increasing(z: np.ndarray) -> np.ndarray:
    """Least-squares non-increasing fit (pool adjacent violators)."""
    values: list[float] = []
    weights: list[int] = []
    for v in -z:
        values.append(float(v))
        weights.append(1)
        while len(values) > 1 and values[-2] > values[-1]:
            w = weights[-2] + weights[-1]
            values[-2] = (values[-2] * weights[-2] + values[-1] * weights[-1]) / w
            weights[-2] = w
            values.pop()
            weights.pop()
    return -np.repeat(values, weights)


def _resample(line: LineString) -> tuple[np.ndarray, np.ndarray]:
    n = max(int(math.ceil(line.length / STEP)), 1) + 1
    dist = np.linspace(0, line.length, n)
    pts = np.array([line.interpolate(d).coords[0] for d in dist])
    return pts, dist


def profile(line: LineString, width: float, difficulty: int, ground, areas) -> dict | None:
    """The graded run along `line` (oriented downhill), sampled every STEP metres."""
    pts, dist = _resample(line)
    if len(pts) < 4:
        return None
    tangent = np.gradient(pts, axis=0)
    tangent[:, 0] = _smooth(tangent[:, 0], 5)
    tangent[:, 1] = _smooth(tangent[:, 1], 5)
    tangent /= np.maximum(np.linalg.norm(tangent, axis=1, keepdims=True), 1e-9)
    normal = np.column_stack([-tangent[:, 1], tangent[:, 0]])

    # Where the run is mapped as an area, its true width there; wide areas are open
    # slopes, not roads, and are left alone.
    full = np.full(len(pts), width / 2)
    open_slope = np.zeros(len(pts), dtype=bool)
    if areas is not None:
        mapped = _area_half_width(pts, normal, areas)
        inside = ~np.isnan(mapped)
        open_slope = inside & (2 * np.nan_to_num(mapped) > OPEN_SLOPE)
        full = np.where(inside, np.clip(np.nan_to_num(mapped), MIN_HALF_WIDTH, None), full)
    full = _smooth(full, SMOOTH)

    unit = np.linspace(-1, 1, CROSS_SAMPLES)
    offsets = full[:, None] * unit
    e = pts[:, 0:1] + normal[:, 0:1] * offsets
    n = pts[:, 1:2] + normal[:, 1:2] * offsets
    h = ground(e.ravel(), n.ravel()).reshape(e.shape)
    centre = h.mean(axis=1)
    cross = _smooth(((h - centre[:, None]) * offsets).sum(axis=1) / (offsets**2).sum(axis=1), 5)

    tan_max = math.tan(math.radians(MAX_CROSS[difficulty]))
    excess = np.maximum(np.abs(cross) - tan_max, 0.0)
    g = np.sign(cross) * np.minimum(np.abs(cross), tan_max)
    with np.errstate(divide="ignore"):
        half = np.where(excess > 1e-6, MAX_BENCH / np.maximum(excess, 1e-6), full)
    half = _smooth(np.clip(half, MIN_HALF_WIDTH, full), SMOOTH)
    z = _smooth(centre + BUILD_UP * np.minimum(excess * half, MAX_BENCH), 3)

    # Along: never uphill, gliding grade where the ground allows.
    chosen = None
    for grade in MIN_GRADES:
        delta = non_increasing(z + grade * dist) - grade * dist - z
        ok = (delta <= MAX_FILL) & (delta >= -MAX_CUT)
        if chosen is None:
            chosen = np.where(ok, delta, np.nan)
        else:
            chosen = np.where(np.isnan(chosen) & ok, delta, chosen)
    last = np.clip(delta, -MAX_CUT, MAX_FILL)
    chosen = np.where(np.isnan(chosen), last, chosen)
    # Never dig the start down: on a summit plateau that leaves the run's top in a pit.
    chosen = np.where(dist < 2 * TAPER, np.maximum(chosen, 0.0), chosen)
    z = z + _smooth(chosen, SMOOTH)

    end = np.minimum(dist, dist[-1] - dist)
    w = np.clip(end / TAPER, 0, 1)
    w = w * w * (3 - 2 * w)
    # Too steep to bench (a cliff, usually a loosely drawn line): leave the terrain.
    w = w * np.clip((MAX_SIDE - np.abs(cross)) / 0.5, 0, 1)
    w = w * ~open_slope
    w = _smooth(w.astype(float), SMOOTH)
    if w.max() < 0.05:
        return None
    return {
        "pts": pts,
        "dist": dist,
        "tangent": tangent,
        "normal": normal,
        "z": z,
        "g": g,
        "half": half,
        "w": w,
        "ground": centre,
    }


def _area_half_width(pts: np.ndarray, normal: np.ndarray, areas) -> np.ndarray:
    """Half the mapped area's width across each station (NaN where not inside one)."""
    reach = np.arange(0, OPEN_SLOPE + AREA_STEP, AREA_STEP)
    out = np.full(len(pts), np.nan)
    sides = []
    for sign in (1, -1):
        e = pts[:, 0:1] + sign * normal[:, 0:1] * reach
        n = pts[:, 1:2] + sign * normal[:, 1:2] * reach
        inside = contains_xy(areas, e.ravel(), n.ravel()).reshape(e.shape)
        # Distance to the first point outside (all inside: the full reach).
        first_out = np.where(inside.all(axis=1), len(reach), np.argmin(inside, axis=1))
        sides.append(np.where(inside[:, 0], reach[np.minimum(first_out, len(reach) - 1)], np.nan))
    centred = ~np.isnan(sides[0])
    out[centred] = (sides[0][centred] + sides[1][centred]) / 2
    return out


def stamp(heights: np.ndarray, grid: Grid, p: dict) -> None:
    """Write the graded run `p` into `heights` (in place)."""
    reach = float(p["half"].max()) + BANK_REACH
    ext = grid.extent
    pts = p["pts"]
    c0 = max(int((pts[:, 0].min() - reach - ext.west) / grid.cell_size), 0)
    c1 = min(int((pts[:, 0].max() + reach - ext.west) / grid.cell_size) + 1, grid.width - 1)
    r0 = max(int((ext.north - pts[:, 1].max() - reach) / grid.cell_size), 0)
    r1 = min(int((ext.north - pts[:, 1].min() + reach) / grid.cell_size) + 1, grid.height - 1)
    if c1 < c0 or r1 < r0:
        return
    window = Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1)
    mask = rio_features.geometry_mask(
        [LineString(pts).buffer(reach)],
        out_shape=(window.height, window.width),
        transform=window_transform(window, grid.transform),
        invert=True,
    )
    rows, cols = np.nonzero(mask)
    if not len(rows):
        return
    e = ext.west + (cols + c0) * grid.cell_size
    n = ext.north - (rows + r0) * grid.cell_size

    # Nearest station, in chunks to bound memory.
    nearest = np.empty(len(e), dtype=int)
    for k in range(0, len(e), 4096):
        de = e[k : k + 4096, None] - pts[None, :, 0]
        dn = n[k : k + 4096, None] - pts[None, :, 1]
        nearest[k : k + 4096] = np.argmin(de * de + dn * dn, axis=1)
    re, rn = e - pts[nearest, 0], n - pts[nearest, 1]
    along = re * p["tangent"][nearest, 0] + rn * p["tangent"][nearest, 1]
    side = re * p["normal"][nearest, 0] + rn * p["normal"][nearest, 1]
    # Stay at the nearest station: on a bend (or past an end) a cell can be far "along"
    # it, toward the other leg of a hairpin. Distance out is the true distance.
    d = np.clip(p["dist"][nearest] + np.clip(along, -STEP / 2, STEP / 2), 0, p["dist"][-1])
    off = np.hypot(side, np.maximum(np.abs(along) - STEP / 2, 0))
    z = np.interp(d, p["dist"], p["z"])
    g = np.interp(d, p["dist"], p["g"])
    half = np.interp(d, p["dist"], p["half"])
    w = np.interp(d, p["dist"], p["w"])

    h = heights[rows + r0, cols + c0].astype(float)
    bench = z + side * g
    # Beyond the bench, the bank bridges the bench edge's height difference from the
    # ground back to zero, so it never reshapes steep terrain the run doesn't touch.
    sign = np.sign(side)
    station = np.rint(np.interp(d, p["dist"], np.arange(len(pts)))).astype(int)
    ex = pts[station, 0] + p["normal"][station, 0] * sign * half
    ey = pts[station, 1] + p["normal"][station, 1] * sign * half
    mismatch = z + sign * half * g - sample_bilinear(heights, grid, ex, ey)
    out = np.maximum(off - half, 0)
    rate = np.where(mismatch > 0, TAN_FILL, TAN_CUT)
    banked = h + np.sign(mismatch) * np.maximum(np.abs(mismatch) - out * rate, 0)
    graded = np.where(out <= 0, bench, banked)
    heights[rows + r0, cols + c0] = (h + w * (graded - h)).astype(heights.dtype)


def _runs(pistes: list[dict], ground) -> list[tuple[LineString, int, float]]:
    """Each piste's centrelines merged where they join, oriented downhill."""
    from .pistes import DEFAULT_WIDTH, FREERIDE

    out = []
    for piste in pistes:
        if piste["difficulty"] == FREERIDE or not piste["lines"]:
            continue
        merged = linemerge(MultiLineString(piste["lines"]))
        lines = list(getattr(merged, "geoms", [merged]))
        for merged_line in lines:
            for line in _legs(merged_line, ground):
                if line.length < MIN_LENGTH:
                    continue
                a, b = line.coords[0], line.coords[-1]
                ha, hb = ground(np.array([a[0], b[0]]), np.array([a[1], b[1]]))
                if hb > ha:
                    line = LineString(line.coords[::-1])
                out.append((line, piste["difficulty"], DEFAULT_WIDTH[piste["difficulty"]]))
    return out


def _legs(line: LineString, ground) -> list[LineString]:
    """Split a line at its significant high and low points (TURN m of hysteresis).

    Merging a piste's segments ignores direction, so two legs running down into one
    junction become one V-shaped line; each leg must be oriented downhill on its own.
    """
    pts, dist = _resample(line)
    if len(pts) < 3:
        return [line]
    z = _smooth(ground(pts[:, 0], pts[:, 1]), 5)
    # Zigzag: track the highest and lowest point since the last turn; a move of TURN
    # back from one of them confirms it as a turning point.
    cuts: list[int] = []
    hi = lo = 0
    trend = 0  # +1 rising, -1 falling, 0 not yet known
    for i in range(1, len(z)):
        if z[i] > z[hi]:
            hi = i
        if z[i] < z[lo]:
            lo = i
        if trend >= 0 and z[hi] - z[i] > TURN:
            if trend > 0:
                cuts.append(hi)
            trend, lo = -1, i
        elif trend <= 0 and z[i] - z[lo] > TURN:
            if trend < 0:
                cuts.append(lo)
            trend, hi = 1, i
    if not cuts:
        return [line]
    bounds = [0.0, *(float(dist[c]) for c in cuts), line.length]
    return [_substring(line, a, b) for a, b in zip(bounds, bounds[1:], strict=False) if b > a]


def _substring(line: LineString, a: float, b: float) -> LineString:
    from shapely.ops import substring

    return substring(line, a, b)


def climb(z: np.ndarray) -> float:
    """Metres of climbing along a profile (rises over 0.5 m between dips)."""
    total, low = 0.0, z[0]
    for v in z:
        if v < low:
            low = v
        elif v - low > 0.5:
            total += v - low
            low = v
    return total


def grade(pistes: list[dict], heights: np.ndarray, grid: Grid) -> dict:
    """Grade every centreline run into `heights` in place. Returns stats."""

    def ground(e, n):
        return sample_bilinear(heights, grid, e, n)

    area_polys = [a for p in pistes for a in p["areas"] if isinstance(a, Polygon)]
    areas = unary_union(area_polys) if area_polys else None
    runs = sorted(_runs(pistes, ground), key=lambda r: r[0].length)  # long runs win
    stats = {"runs": 0, "km": 0.0, "climbBefore": 0.0, "climbAfter": 0.0, "maxFill": 0.0}
    graded = []
    for line, difficulty, width in runs:
        p = profile(line, width, difficulty, ground, areas)
        if p is None:
            continue
        graded.append((p["pts"], ground(p["pts"][:, 0], p["pts"][:, 1])))
        stamp(heights, grid, p)
        stats["runs"] += 1
        stats["km"] += line.length / 1000
    for pts, before in graded:
        after = ground(pts[:, 0], pts[:, 1])
        stats["climbBefore"] += climb(before)
        stats["climbAfter"] += climb(after)
        stats["maxFill"] = max(stats["maxFill"], float((after - before).max()))
    return {k: round(v, 1) if isinstance(v, float) else v for k, v in stats.items()}
