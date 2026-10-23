"""Snow park layouts generated inside OSM `piste:type=snow_park` areas and lines.

OSM maps where a park is, not what's in it, so the features are designed here,
deterministically from the park's geometry, name and difficulty and the terrain:

- A superpipe in big parks with a long, even 13-20° stretch (`_halfpipe`): flat bottom,
  circular transitions steepening to near-vertical at the coping, level decks; the walls
  grow out of the hill at the top (the drop-in) and sink back into it at the bottom.
- Lines of features down the park, each following its own gentle meander (`_Line`):
  kickers of mixed sizes and step-downs on the jump line; rails, down rails, flat boxes and
  wall rides on the jib line; small mixed features on a third line in wide parks. Each
  feature is nudged off the line, faces the local fall line (within `MAX_TURN` of the
  line's direction) and is spaced by a varying gap. Kickers are a run-in transition
  curving up to the lip (take-off ANGLE above horizontal), a level table, a rounded
  knuckle and a landing steeper than the hill that runs back into it (`kicker_profile`).
  Sizes (small, medium, large) come from the difficulty; family/kids parks are small.
- A boardercross ("cross" in the name), or a snake/bumpy run: the course weaves down
  the park round banked turns (berms) with rollers on the straights.

The variation is seeded from the park's name and outline, so a build is reproducible.
Features are absolute surfaces: the sim takes max(terrain, feature), so a feature that
dips below the snow simply vanishes there. Line features are a profile along their
heading (heights above the origin, level across) with sides falling at `side` (tan);
berms and wall rides are a banked wall on the outside of an arc, above a plane fitted
to the ground. Everything is reported as synthetic (`"synthetic": true`): OSM has none
of it.
"""

from __future__ import annotations

import math
import re
import zlib

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon

#: Jump sizes: lip height above the hill (m), take-off angle (deg above horizontal),
#: table length (m), landing angle (deg), width (m).
SIZES = {
    "small": {"height": 0.9, "angle": 20.0, "table": 3.0, "landing": 26.0, "width": 4.0},
    "medium": {"height": 1.5, "angle": 25.0, "table": 7.0, "landing": 30.0, "width": 6.0},
    "large": {"height": 2.3, "angle": 30.0, "table": 12.0, "landing": 34.0, "width": 8.0},
}
LIP_DROP = 0.3  # the table sits this share of the lip height below the lip
KNUCKLE = 2.0  # rounding over the knuckle (m)
RUN_OUT = 10.0  # landing → hill transition (m): long, so overshooting the landing is gentle
SIDE = 1.2  # side slope of snow features (tan, ~50°)
STEP = 0.5  # profile sample spacing (m)
FINE_STEP = 0.1  # ... on a kicker's run-in
#: Hill grades (deg along the line) a kicker can be built on.
MIN_GRADE, MAX_GRADE = 4.0, 22.0
LEAD_IN = 30.0  # from the top of the park to the first feature (m)
GAP = (18.0, 32.0)  # run-out between features on a line: room to land, spot and set up (m)
EDGE = 2.0  # features keep this far inside the park's outline (m)
TWO_LINES = 34.0  # a park at least this wide gets a jib line beside the jumps (m)
THREE_LINES = 90.0  # ... and this wide, a third line of small mixed features (m)
MAX_TURN = 25.0  # a feature faces the fall line, within this of its line's direction (deg)
JITTER = 2.0  # features sit up to this far either side of their line (m)
#: Clear snow kept beyond a feature's end, for landing and riding away (m).
CLEAR = {"kicker": 10.0, "jib": 6.0}

#: Jibs (the sim draws a steel rail or box on legs; physics rides its top), with a snow
#: ramp up to them. A down rail runs `flat` m parallel to the hill, then drops `drop` m
#: more by its end; a flat box is low and wide.
RAILS = {
    "rail": {"length": 12.0, "height": 1.3, "width": 0.6, "ramp": 5.0, "rampWidth": 2.0},
    "short-rail": {"length": 7.0, "height": 0.9, "width": 0.6, "ramp": 3.5, "rampWidth": 2.0},
    "down-rail": {
        "length": 11.0,
        "height": 1.3,
        "width": 0.6,
        "ramp": 5.0,
        "rampWidth": 2.0,
        "flat": 4.0,
        "drop": 0.8,
    },
    "flat-box": {"length": 9.0, "height": 0.5, "width": 1.0, "ramp": 2.5, "rampWidth": 2.4},
}
#: A step-down: a low, flat take-off with almost no table, onto a steep landing.
STEP_DOWN = {"height": 1.0, "angle": 12.0, "table": 2.0, "landing": 32.0, "width": 6.0}
#: Wall ride: a steep bank (~65° at the top) beside the line, along a gentle arc.
WALL = {"height": 2.4, "width": 2.2, "radius": 40.0, "length": 12.0}
#: Superpipe: `flat` bottom, transitions of a circular arc steepening to `vert` degrees
#: over the top `vertHeight` m, walls `height` m, `deck` m decks. The walls rise out of
#: the floor over the first `dropIn` m and sink back over the last `exit` m; the floor
#: blends into the hill over `lead` m at either end.
HALFPIPE = {
    "flat": 15.0,
    "height": 5.5,
    "vert": 85.0,
    "vertHeight": 0.4,
    "deck": 4.0,
    "dropIn": 24.0,
    "exit": 10.0,
    "lead": 15.0,
}
PIPE_LENGTHS = (170.0, 150.0, 130.0, 110.0, 100.0)
PIPE_GRADE = (13.0, 20.0)  # real pipes are cut at 15-18°
PIPE_MAX_FILL = 2.5  # most the floor may stand above the hill (m)
PIPE_MIN_WIDTH = 60.0  # parks narrower than this keep their room for lines (m)
PIPE_RUN_OUT = 20.0
ROLLER = {"height": 0.9, "length": 7.0}
BERM = {"height": 2.2, "width": 5.0, "radius": 9.0}
COURSE_WIDTH = 7.0
COURSE_LEG = 36.0  # straight between turns (m)
CROSS_NAMES = re.compile(r"cross|\bbx\b|snake|bumpy|woop|wave|vague|banked|slalom", re.I)
SMALL_NAMES = re.compile(r"famil|kid|mini|enfant|junior|baby|ludique|fun\s*zone|pixel", re.I)


def size_for(piste: dict) -> list[str]:
    """Jump sizes for the park's lines, from its difficulty or name."""
    if SMALL_NAMES.search(piste.get("name") or "") or piste["difficulty"] in (1, 2):
        return ["small"]
    if piste["difficulty"] == 3:
        return ["medium"]
    if piste["difficulty"] in (4, 5):
        return ["large", "medium"]
    return ["medium", "small"]


def kicker_profile(grade: float, size: dict) -> np.ndarray:
    """(u, height) samples along a kicker built on a hill falling at `grade` (deg), with
    u = 0 at the lip and heights relative to the hill at the lip. The run-in curves from
    the hill's slope to the take-off angle (slope changing linearly with u, so roughly a
    circular transition); after the lip a short drop to the level table, the knuckle,
    a landing at `landing` degrees down to meet the hill, and a run-out easing into it."""
    th = math.tan(math.radians(grade))
    ta = math.tan(math.radians(size["angle"]))
    tl = math.tan(math.radians(max(size["landing"], grade + 12)))
    h = size["height"]
    run_in = 2 * h / (ta + th)
    table = h * (1 - LIP_DROP)
    lip_back = h * LIP_DROP / SIDE
    knuckle = size["table"]
    # Landing from the knuckle meets the hill where table - tl·(u - knuckle) = -th·u.
    meet = (table + tl * knuckle) / (tl - th)

    def hill(u):
        return -th * u

    # Even samples, plus every corner exactly (the sim interpolates linearly between them).
    corners = [-run_in, 0.0, lip_back, knuckle - KNUCKLE / 2, knuckle + KNUCKLE / 2]
    corners += [meet - RUN_OUT / 2, meet + RUN_OUT / 2]
    even = np.arange(-run_in - 2.0, meet + RUN_OUT / 2 + 2.0 + STEP / 2, STEP)
    curved = np.arange(-run_in, 0, FINE_STEP)  # the run-in's angle at the lip matters
    us = np.unique(np.round(np.concatenate([even, curved, corners]), 4))
    out = np.empty_like(us)
    for i, u in enumerate(us):
        if u < -run_in:
            y = hill(u)
        elif u <= 0:
            s = u + run_in
            y = hill(-run_in) - th * s + (ta + th) * s * s / (2 * run_in)
        elif u < lip_back:
            y = h - SIDE * u
        elif u < knuckle - KNUCKLE / 2:
            y = table
        elif u < knuckle + KNUCKLE / 2:
            # Slope eases from level to -tl over the knuckle.
            s = u - (knuckle - KNUCKLE / 2)
            y = table - tl * s * s / (2 * KNUCKLE)
        elif u < meet - RUN_OUT / 2:
            y = table - tl * (u - knuckle)
        elif u < meet + RUN_OUT / 2:
            # Concave: slope eases from -tl back to the hill's -th, centred where they meet.
            s = u - (meet - RUN_OUT / 2)
            y = table - tl * (u - knuckle) + (tl - th) * s * s / (2 * RUN_OUT)
        else:
            y = hill(u)
        out[i] = y
    return np.column_stack([us, out])


def box_profile(grade: float, spec: dict = RAILS["rail"]) -> tuple[np.ndarray, np.ndarray]:
    """(ramp, rail) profiles: a snow ramp up to the rail's height, then the rail top running
    parallel to the hill (a down rail kinks after `flat` m and drops `drop` m more by its
    end). u = 0 at the start of the rail; heights relative to the hill there."""
    th = math.tan(math.radians(grade))
    r, b, h = spec["ramp"], spec["length"], spec["height"]
    ramp_u = np.arange(-r - 1.0, 0.0 + STEP / 2, STEP)
    ramp = np.where(ramp_u < -r, -th * ramp_u, -th * ramp_u + h * (ramp_u + r) / r)
    flat = spec.get("flat", b)
    box_u = np.array([0.0, flat, b]) if flat < b else np.array([0.0, b])
    box = h - th * box_u - np.where(box_u > flat, spec.get("drop", 0.0), 0.0)
    return np.column_stack([ramp_u, ramp]), np.column_stack([box_u, box])


def roller_profile(grade: float, count: int) -> np.ndarray:
    """`count` rollers (sin² humps) on a hill at `grade` deg; u = 0 at the first's start."""
    th = math.tan(math.radians(grade))
    length = ROLLER["length"] * count
    us = np.arange(-1.0, length + 1.0 + STEP / 2, STEP / 2)
    hump = np.where(
        (us >= 0) & (us <= length),
        np.sin(np.pi * np.clip(us, 0, length) / ROLLER["length"]) ** 2,
        0,
    )
    return np.column_stack([us, -th * us + ROLLER["height"] * hump])


def _chord(geom: Polygon, centre: np.ndarray, axis: np.ndarray) -> LineString | None:
    """The longest stretch of the line through `centre` along `axis` inside `geom`."""
    reach = math.sqrt(geom.minimum_rotated_rectangle.area) * 4 + 100
    line = LineString([centre - axis * reach, centre + axis * reach]).intersection(geom)
    parts = [p for p in getattr(line, "geoms", [line]) if isinstance(p, LineString)]
    parts = [p for p in parts if not p.is_empty]
    return max(parts, key=lambda p: p.length) if parts else None


def _spine(geom, ground) -> LineString | None:
    """The line riders take down the park, oriented downhill: a mapped line itself, or
    for an area its fall line through the middle (or its long axis, if the fall line
    crosses a long, narrow park)."""
    if isinstance(geom, Polygon):
        centre = np.asarray(geom.representative_point().coords[0])
        _, ge, gn = _plane(ground, centre, math.sqrt(geom.area) / 2)
        fall = -np.array([ge, gn]) / max(math.hypot(ge, gn), 1e-9)
        corners = np.asarray(geom.minimum_rotated_rectangle.exterior.coords)[:4]
        a, b = max(((corners[0], corners[1]), (corners[1], corners[2])), key=_side_length)
        long_axis = (b - a) / max(float(np.linalg.norm(b - a)), 1e-9)
        down = _chord(geom, centre, fall)
        along = _chord(geom, centre, long_axis)
        line = (
            down
            if down is not None and (along is None or down.length >= 0.6 * along.length)
            else along
        )
        if line is None:
            return None
    else:
        line = geom
    a, b = line.coords[0], line.coords[-1]
    ha, hb = ground(np.array([a[0], b[0]]), np.array([a[1], b[1]]))
    return LineString(line.coords[::-1]) if hb > ha else line


def _side_length(side) -> float:
    return float(np.linalg.norm(side[1] - side[0]))


def _frame(spine: LineString, d: float) -> tuple[np.ndarray, np.ndarray]:
    """Point and unit direction along the spine at distance d."""
    a = np.asarray(spine.interpolate(max(d - 3, 0)).coords[0])
    b = np.asarray(spine.interpolate(min(d + 3, spine.length)).coords[0])
    t = (b - a) / max(float(np.linalg.norm(b - a)), 1e-9)
    return np.asarray(spine.interpolate(d).coords[0]), t


def _grade(ground, p: np.ndarray, t: np.ndarray, length: float) -> float:
    """Mean grade (deg, > 0 = falling) over `length` m along t from p."""
    s = np.linspace(-length / 2, length / 2, 9)
    e, n = p[0] + t[0] * s, p[1] + t[1] * s
    z = ground(e, n)
    slope = -np.polyfit(s, z, 1)[0]
    return math.degrees(math.atan(slope))


def _heading(t: np.ndarray) -> float:
    return round(math.degrees(math.atan2(t[0], t[1])) + 360, 2) % 360


def _footprint(origin, t, u0: float, u1: float, width: float):
    n = np.array([-t[1], t[0]])
    a, b = origin + t * u0, origin + t * u1
    half = width / 2
    return Polygon([a + n * half, b + n * half, b - n * half, a - n * half])


def _line_feature(kind: str, origin, t, ground_at_origin: float, profile, width: float) -> dict:
    return {
        "kind": kind,
        "east": round(float(origin[0]), 2),
        "north": round(float(origin[1]), 2),
        "y": round(float(ground_at_origin), 2),
        "heading": round(_heading(t), 2),
        "width": width,
        "side": SIDE if kind != "box" else 20.0,
        "profile": np.round(profile, 3).tolist(),
    }


class _Placer:
    """Places features along one line, keeping them inside the park and clear of each
    other and of `blocked` (buildings, lift lines)."""

    def __init__(self, area, blocked):
        self.area = area.buffer(-EDGE) if area is not None else None
        self.blocked = blocked
        self.taken: list[Polygon] = []

    def fits(self, poly: Polygon) -> bool:
        if self.area is not None and not self.area.contains(poly):
            return False
        if self.blocked is not None and self.blocked.intersects(poly):
            return False
        return not any(poly.intersects(t) for t in self.taken)

    def take(self, poly: Polygon) -> None:
        self.taken.append(poly.buffer(1.0))


def _unit(v: np.ndarray) -> np.ndarray:
    return v / max(float(np.linalg.norm(v)), 1e-9)


def _left(t: np.ndarray) -> np.ndarray:
    return np.array([-t[1], t[0]])


def _ground_at(ground, p: np.ndarray) -> float:
    return float(ground(np.array([p[0]]), np.array([p[1]]))[0])


def _fall(ground, p: np.ndarray, radius: float) -> np.ndarray | None:
    """Unit downhill direction of the plane fitted round p; None on the flat."""
    _, ge, gn = _plane(ground, p, radius)
    g = np.array([ge, gn])
    return None if np.linalg.norm(g) < 1e-3 else _unit(-g)


def _turn_toward(t: np.ndarray, target: np.ndarray, limit: float) -> np.ndarray:
    """`target` direction, turned back to within `limit` degrees of t."""
    a = math.atan2(t[0] * target[1] - t[1] * target[0], float(t @ target))
    a = max(-math.radians(limit), min(math.radians(limit), a))
    c, s = math.cos(a), math.sin(a)
    return np.array([c * t[0] - s * t[1], s * t[0] + c * t[1]])


#: What each kind of line is made of (kind: weight).
JUMP_LINE = {"kicker": 0.8, "step-down": 0.2}
JIB_LINE = {"rail": 0.3, "short-rail": 0.2, "down-rail": 0.2, "flat-box": 0.2, "wall": 0.1}
MIXED_LINE = {
    "kicker": 0.4,
    "step-down": 0.1,
    "rail": 0.15,
    "short-rail": 0.1,
    "down-rail": 0.1,
    "flat-box": 0.15,
}
SMALL_LINE = {"kicker": 0.3, "flat-box": 0.25, "short-rail": 0.25, "wall": 0.2}
#: Left out of family / kids parks.
NOT_SMALL = {"step-down", "down-rail", "wall"}


class _Line:
    """One line of features down the park: a gentle meander of `amplitude` m about
    `offset` m left of the spine, built from `menu`, with kickers from `sizes`."""

    def __init__(self, spine, offset, amplitude, menu, sizes, rng, small):
        self.spine, self.offset, self.amplitude = spine, offset, amplitude
        self.kinds = [k for k in menu if not (small and k in NOT_SMALL)]
        w = np.array([menu[k] for k in self.kinds])
        self.weights = w / w.sum()
        self.sizes, self.rng, self.small = sizes, rng, small
        self.wave = rng.uniform(120.0, 220.0)
        self.phase = rng.uniform(0.0, 2 * math.pi)
        self.kickers = 0

    def at(self, d: float) -> tuple[np.ndarray, np.ndarray]:
        """Point and unit direction of the line at distance d down the spine."""
        centre, t = _frame(self.spine, d)
        k = 2 * math.pi / self.wave
        off = self.offset + self.amplitude * math.sin(k * d + self.phase)
        slope = self.amplitude * k * math.cos(k * d + self.phase)
        n = _left(t)
        return centre + n * off, _unit(t + n * slope)

    def size(self) -> dict:
        # The first kicker is the park's headline size; after that a mix, sometimes
        # one size down.
        name = self.sizes[0] if self.kickers == 0 else self.rng.choice(self.sizes)
        if not self.small and self.kickers > 0 and self.rng.random() < 0.25:
            name = {"large": "medium", "medium": "small"}.get(name, name)
        self.kickers += 1
        return SIZES[name]

    def fill(self, placer, ground) -> list[dict]:
        out: list[dict] = []
        d = LEAD_IN + self.rng.uniform(0.0, 10.0)
        while d < self.spine.length - 20:
            kind = self.kinds[int(self.rng.choice(len(self.kinds), p=self.weights))]
            p, t = self.at(d)
            p = p + _left(t) * self.rng.uniform(-JITTER, JITTER)
            placed = self.place(kind, p, t, placer, ground)
            if placed is None:
                d += 5.0
                continue
            features, length = placed
            out += features
            d += length + self.rng.uniform(*GAP)
        return out

    def place(self, kind, p, path, placer, ground) -> tuple[list[dict], float] | None:
        """Build `kind` starting at p, facing the fall line there (within MAX_TURN of the
        line's direction `path`), if it fits: its features and length."""
        fall = _fall(ground, p, 8.0)
        t = path if fall is None else _turn_toward(path, fall, MAX_TURN)
        if kind in ("kicker", "step-down"):
            grade = _grade(ground, p, t, 30.0)
            if not MIN_GRADE <= grade <= MAX_GRADE:
                return None
            size = STEP_DOWN if kind == "step-down" else self.size()
            profile = kicker_profile(grade, size)
            u0, u1 = float(profile[0, 0]), float(profile[-1, 0])
            origin = p - t * u0  # the lip sits at u = 0: the run-in starts at p
            width = size["width"] + 2 * size["height"] / SIDE
            poly = _footprint(origin, t, u0, u1 + CLEAR["kicker"], width)
            if not placer.fits(poly):
                return None
            placer.take(poly)
            y = _ground_at(ground, origin)
            return [_line_feature("kicker", origin, t, y, profile, size["width"])], u1 - u0
        if kind in RAILS:
            spec = RAILS[kind]
            grade = _grade(ground, p, t, 12.0)
            if not 2.0 <= grade <= MAX_GRADE:
                return None
            ramp, box = box_profile(grade, spec)
            u0, u1 = float(ramp[0, 0]), float(box[-1, 0])
            origin = p - t * u0
            poly = _footprint(origin, t, u0, u1 + CLEAR["jib"], spec["rampWidth"] + 1)
            if not placer.fits(poly):
                return None
            placer.take(poly)
            y = _ground_at(ground, origin)
            return [
                _line_feature("ramp", origin, t, y, ramp, spec["rampWidth"]),
                _line_feature("box", origin, t, y, box, spec["width"]),
            ], u1 - u0
        return self.wall(p, t, placer, ground)

    def wall(self, p, t, placer, ground) -> tuple[list[dict], float] | None:
        """A wall ride: a steep bank rising beside the line, on a random side."""
        length, r = WALL["length"], WALL["radius"]
        grade = _grade(ground, p + t * length / 2, t, length)
        if not 2.0 <= grade <= MAX_GRADE:
            return None
        n = _left(t) * (1 if self.rng.random() < 0.5 else -1)  # toward the wall
        mid = p + t * length / 2
        reach = WALL["width"] + WALL["height"] / SIDE + 1
        # From 3 m inside the riding line (room to ride along it) out to the wall's back.
        poly = _footprint(p + n * (reach - 3) / 2, t, -1.0, length + CLEAR["jib"], reach + 3)
        if not placer.fits(poly):
            return None
        placer.take(poly)
        y_mid, ge, gn = _plane(ground, mid, length / 2 + 2)
        centre = mid - n * r  # the arc's centre, on the riding side
        y = y_mid + ge * (centre[0] - mid[0]) + gn * (centre[1] - mid[1])
        sweep = math.degrees(length / r)
        bearing = _heading(n)  # from the arc's centre to the middle of the wall
        return [
            {
                "kind": "wall",
                "east": round(float(centre[0]), 2),
                "north": round(float(centre[1]), 2),
                "y": round(y, 2),
                "grad": [round(ge, 4), round(gn, 4)],
                "radius": r,
                "start": round((bearing - sweep / 2) % 360, 2),
                "sweep": round(sweep, 2),
                "width": WALL["width"],
                "height": WALL["height"],
                "side": SIDE,
            }
        ], length


def halfpipe_section(spec: dict = HALFPIPE) -> tuple[float, float]:
    """A pipe's transition radius, and its half width out to the decks' outer edge (m)."""
    a = math.radians(spec["vert"])
    radius = (spec["height"] - spec["vertHeight"]) / (1 - math.cos(a))
    half = spec["flat"] / 2 + radius * math.sin(a) + spec["vertHeight"] / math.tan(a) + spec["deck"]
    return radius, half


def _halfpipe(spine, width, placer, ground) -> dict | None:
    """The longest superpipe that fits down the park's fall line on a pipe-like grade,
    with its floor no more than PIPE_MAX_FILL above the hill; None if none does."""
    hp = HALFPIPE
    radius, half = halfpipe_section()
    reach = half + hp["height"] / SIDE  # out to where the outer walls meet the hill
    lead = hp["lead"]
    for length in PIPE_LENGTHS:
        total = length + 2 * lead
        for d in np.arange(10.0, spine.length - total + 1, 10.0):
            for frac in (0.0, 0.15, -0.15, 0.3, -0.3):
                centre, t = _frame(spine, d + total / 2)
                c = centre + _left(t) * frac * width
                fall = _fall(ground, c, length / 2)
                if fall is None or float(fall @ t) < math.cos(math.radians(35)):
                    continue
                start = c - fall * length / 2
                poly = _footprint(start, fall, -lead, length + lead + PIPE_RUN_OUT, 2 * reach)
                if not placer.fits(poly):
                    continue
                # Fit the floor's plane to the hill under it, raised clear of every bump.
                us = np.arange(0.0, length + 0.1, 2.0)
                vs = np.linspace(-hp["flat"] / 2, hp["flat"] / 2, 5)
                n = _left(fall)
                e = start[0] + fall[0] * us[:, None] + n[0] * vs[None, :]
                no = start[1] + fall[1] * us[:, None] + n[1] * vs[None, :]
                z = ground(e.ravel(), no.ravel()).reshape(e.shape)
                slope, y0 = np.polyfit(us, z.mean(axis=1), 1)
                if not PIPE_GRADE[0] <= math.degrees(math.atan(-slope)) <= PIPE_GRADE[1]:
                    continue
                y0 += max(0.0, float((z - (y0 + slope * us)[:, None]).max()))
                if float(((y0 + slope * us)[:, None] - z).max()) > PIPE_MAX_FILL:
                    continue
                placer.take(poly)
                return _halfpipe_feature(start, fall, float(y0), float(-slope), length, ground)
    return None


def _halfpipe_feature(start, fall, y0: float, grade: float, length: float, ground) -> dict:
    """The pipe's record: the floor as a profile along it (the fitted plane, blending
    into the hill over `lead` m at either end) plus its cross-section."""
    hp = HALFPIPE
    lead = hp["lead"]
    tail = np.arange(length + 1.0, length + lead + 0.01, 1.0)
    us = np.concatenate([np.arange(-lead, 0.0, 1.0), [0.0, length], tail])
    hill = ground(start[0] + fall[0] * us, start[1] + fall[1] * us) - y0
    plane = -grade * us
    s = np.clip(np.where(us < 0, (us + lead) / lead, (length + lead - us) / lead), 0.0, 1.0)
    blend = s * s * (3 - 2 * s)
    floor = np.where((us >= 0) & (us <= length), plane, hill + (plane - hill) * blend)
    radius, _ = halfpipe_section()
    return {
        "kind": "halfpipe",
        "east": round(float(start[0]), 2),
        "north": round(float(start[1]), 2),
        "y": round(y0, 2),
        "heading": round(_heading(fall), 2),
        "length": length,
        "flat": hp["flat"],
        "radius": round(radius, 3),
        "vert": hp["vert"],
        "height": hp["height"],
        "deck": hp["deck"],
        "dropIn": hp["dropIn"],
        "exit": hp["exit"],
        "side": SIDE,
        "profile": np.round(np.column_stack([us, floor]), 3).tolist(),
    }


def _plane(ground, centre: np.ndarray, radius: float) -> tuple[float, float, float]:
    """Least-squares plane (height at centre, d/deast, d/dnorth) over a disc."""
    g = np.linspace(-radius, radius, 7)
    de, dn = np.meshgrid(g, g)
    z = ground(centre[0] + de.ravel(), centre[1] + dn.ravel())
    a = np.column_stack([np.ones(de.size), de.ravel(), dn.ravel()])
    c, *_ = np.linalg.lstsq(a, z, rcond=None)
    return float(c[0]), float(c[1]), float(c[2])


def _course(spine, width: float, placer, ground) -> list[dict]:
    """A weaving course down the spine: a berm at each turn, rollers between."""
    out: list[dict] = []
    amp = max(0.0, min(width / 2 - BERM["radius"] - EDGE - BERM["width"], 12.0))
    turns = int((spine.length - LEAD_IN) // COURSE_LEG)
    side = 1
    for i in range(turns):
        d = LEAD_IN + (i + 0.5) * COURSE_LEG
        centre, t = _frame(spine, d)
        n = np.array([-t[1], t[0]])
        # Rollers on the straight leading into this turn.
        if i > 0:
            rd = d - COURSE_LEG / 2 - ROLLER["length"]  # two rollers mid-way between turns
            rc, rt = _frame(spine, rd)
            grade = _grade(ground, rc, rt, 14.0)
            if 0.0 <= grade <= MAX_GRADE:
                prof = roller_profile(grade, 2)
                poly = _footprint(rc, rt, float(prof[0, 0]), float(prof[-1, 0]), COURSE_WIDTH)
                if placer.fits(poly):
                    y = float(ground(np.array([rc[0]]), np.array([rc[1]]))[0])
                    out.append(_line_feature("roller", rc, rt, y, prof, COURSE_WIDTH))
                    placer.take(poly)
        # Berm: the rider comes across the slope and swings round under a banked wall on
        # the outside of the turn (the side the course is heading toward).
        apex = centre + n * side * amp
        r = BERM["radius"]
        arc_centre = apex - n * side * r
        y0, ge, gn = _plane(ground, arc_centre, r + BERM["width"])
        heading_out = _heading(n * side)  # compass bearing from arc centre to the apex
        poly = Point(*apex).buffer(BERM["width"] + 3)
        if placer.fits(poly):
            out.append(
                {
                    "kind": "berm",
                    "east": round(float(arc_centre[0]), 2),
                    "north": round(float(arc_centre[1]), 2),
                    "y": round(y0, 2),
                    "grad": [round(ge, 4), round(gn, 4)],
                    "radius": r,
                    "start": round((heading_out - 70) % 360, 2),
                    "sweep": 140.0,
                    "width": BERM["width"],
                    "height": BERM["height"],
                    "side": SIDE,
                }
            )
            placer.take(poly)
        side = -side
    return out


def _width(geom, spine: LineString) -> float:
    """The park's typical width across its spine (a line park: its default width)."""
    if not isinstance(geom, Polygon):
        return 0.0
    return geom.area / max(spine.length, 1.0)


def _seed(piste: dict, geom) -> int:
    """A stable seed per park geometry (Python's hash() changes between runs)."""
    bounds = ",".join(f"{v:.0f}" for v in geom.bounds)
    return zlib.crc32(f"{piste.get('name') or ''}|{bounds}".encode())


def layout(piste: dict, ground, blocked=None) -> list[dict]:
    """Every generated feature of one park (all its areas and lines)."""
    from .pistes import TYPE_WIDTH

    features: list[dict] = []
    style = "course" if CROSS_NAMES.search(piste.get("name") or "") else "jumps"
    sizes = size_for(piste)
    small = sizes == ["small"]
    geoms = [*piste["areas"], *piste["lines"]]
    for geom in geoms:
        spine = _spine(geom, ground)
        if spine is None or spine.length < LEAD_IN + 30:
            continue
        if isinstance(geom, Polygon):
            area, width = geom, _width(geom, spine)
        else:
            width = TYPE_WIDTH["snow_park"]
            area = spine.buffer(width / 2, cap_style="flat")
        placer = _Placer(area, blocked)
        if style == "course":
            features += _course(spine, width, placer, ground)
            continue
        rng = np.random.default_rng(_seed(piste, geom))
        if isinstance(geom, Polygon) and not small and width >= PIPE_MIN_WIDTH:
            pipe = _halfpipe(spine, width, placer, ground)
            if pipe is not None:
                features.append(pipe)
        amplitude = min(max(width * 0.08, 1.5), 8.0)
        if width >= THREE_LINES:
            plan = [(0.25, JUMP_LINE, sizes), (-0.25, JIB_LINE, sizes)]
            plan.append((0.0, SMALL_LINE, ["small"]))
        elif width >= TWO_LINES:
            plan = [(0.15, JUMP_LINE, sizes), (-0.25, JIB_LINE, sizes)]
        else:
            plan = [(0.0, MIXED_LINE, sizes)]
        for frac, menu, line_sizes in plan:
            line = _Line(spine, frac * width, amplitude, menu, line_sizes, rng, small)
            features += line.fill(placer, ground)
    return features


def footprint(f: dict) -> Polygon:
    """Ground footprint of a generated feature, with its side slopes."""
    if f["kind"] in ("berm", "wall"):
        angles = np.radians(f["start"] + np.linspace(0, f["sweep"], 24))
        ring = np.column_stack([np.sin(angles), np.cos(angles)])
        centre = np.array([f["east"], f["north"]])
        outer = centre + ring * (f["radius"] + f["width"] + f["height"] / f["side"])
        inner = centre + ring[::-1] * (f["radius"] - 1)
        return Polygon(np.vstack([outer, inner]))
    h = math.radians(f["heading"])
    t = np.array([math.sin(h), math.cos(h)])
    origin = np.array([f["east"], f["north"]])
    u0, u1 = f["profile"][0][0], f["profile"][-1][0]
    if f["kind"] == "halfpipe":
        _, half = halfpipe_section()
        return _footprint(origin, t, u0, u1, 2 * (half + f["height"] / f["side"]))
    top = max(abs(y) for _, y in f["profile"]) if f["kind"] != "box" else 0.0
    return _footprint(origin, t, u0, u1, f["width"] + 2 * min(top, 3.0) / f["side"])


def blocked(feature_data: dict):
    """Where park features can't go: buildings, and lift lines with their terminals."""
    from shapely.ops import unary_union

    shapes = [Polygon(b["footprint"]).buffer(3) for b in feature_data.get("buildings", [])]
    for lift in feature_data.get("lifts", []):
        line = [(s["east"], s["north"]) for s in lift["supports"]]
        if len(line) >= 2:
            shapes.append(LineString(line).buffer(8))
    shapes = [s for s in shapes if s.is_valid and not s.is_empty]
    if not shapes:
        return None
    union = unary_union(shapes)
    shapely.prepare(union)
    return union


def build(pistes: list[dict], ground, blocked=None) -> list[dict]:
    """Layouts for every snow park: [{index, name, style, features}]."""
    parks = []
    for p in pistes:
        if p.get("type") != "snow_park":
            continue
        features = layout(p, ground, blocked)
        if features:
            parks.append(
                {
                    "index": p["index"],
                    "style": "course" if CROSS_NAMES.search(p.get("name") or "") else "jumps",
                    "synthetic": True,
                    "features": features,
                }
            )
    return parks
