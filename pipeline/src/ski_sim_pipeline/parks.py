"""Snow park layouts generated inside OSM `piste:type=snow_park` areas and lines.

OSM maps where a park is, not what's in it, so the features are designed here,
deterministically from the park's geometry, name and difficulty and the terrain:

- A jump line: kickers down the park's spine. Each is a run-in transition curving up to
  the lip (take-off ANGLE above horizontal), a level table, a rounded knuckle and a
  landing steeper than the hill that runs back into it (`kicker_profile`). Sizes
  (small, medium, large) come from the difficulty; family/kids parks are small.
- Boxes (a snow ramp onto a flat box) in a second, jib line where the park is wide
  enough, or between kickers in a narrow one.
- A boardercross ("cross" in the name), or a snake/bumpy run: the course weaves down
  the park round banked turns (berms) with rollers on the straights.

Features are absolute surfaces: the sim takes max(terrain, feature), so a feature that
dips below the snow simply vanishes there. Line features are a profile along their
heading (heights above the origin, level across) with sides falling at `side` (tan);
berms are a banked wall on the outside of an arc, above a plane fitted to the ground.
Everything is reported as synthetic (`"synthetic": true`): OSM has none of it.
"""

from __future__ import annotations

import math
import re

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
GAP = 25.0  # run-out between features: room to land, spot and set up (m)
EDGE = 2.0  # features keep this far inside the park's outline (m)
TWO_LINES = 34.0  # a park at least this wide gets a jib line beside the jumps (m)

BOX = {"length": 6.0, "height": 0.5, "width": 0.6, "ramp": 2.5, "rampWidth": 1.6}
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


def box_profile(grade: float) -> tuple[np.ndarray, np.ndarray]:
    """(ramp, box) profiles: a snow ramp up to the box's height, then the box top running
    parallel to the hill. u = 0 at the start of the box; heights relative to the hill there."""
    th = math.tan(math.radians(grade))
    r, b, h = BOX["ramp"], BOX["length"], BOX["height"]
    ramp_u = np.arange(-r - 1.0, 0.0 + STEP / 2, STEP)
    ramp = np.where(ramp_u < -r, -th * ramp_u, -th * ramp_u + h * (ramp_u + r) / r)
    box_u = np.array([0.0, b])
    box = h - th * box_u
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


def _jump_line(spine, offset, sizes, placer, ground, with_boxes) -> list[dict]:
    out: list[dict] = []
    d = LEAD_IN
    k = kickers = 0  # features placed; kickers placed (sizes cycle through these)
    while d < spine.length - 20:
        centre, t = _frame(spine, d)
        origin = centre + np.array([-t[1], t[0]]) * offset
        size = SIZES[sizes[kickers % len(sizes)]]
        grade = _grade(ground, origin, t, 30.0)
        box_turn = with_boxes and k % 2 == 1
        if not MIN_GRADE <= grade <= MAX_GRADE:
            d += 5.0
            continue
        if box_turn:
            ramp, box = box_profile(grade)
            u0, u1 = float(ramp[0, 0]), float(box[-1, 0]) + 1
            poly = _footprint(origin, t, u0, u1, BOX["rampWidth"] + 1)
            if placer.fits(poly):
                y = float(ground(np.array([origin[0]]), np.array([origin[1]]))[0])
                out.append(_line_feature("ramp", origin, t, y, ramp, BOX["rampWidth"]))
                out.append(_line_feature("box", origin, t, y, box, BOX["width"]))
                placer.take(poly)
                d += u1 + GAP
                k += 1
                continue
            d += 5.0
            continue
        profile = kicker_profile(grade, size)
        u0, u1 = float(profile[0, 0]), float(profile[-1, 0])
        # The lip sits at u = 0: shift so the run-in starts at d.
        origin = origin - t * u0
        poly = _footprint(origin, t, u0, u1, size["width"] + 2 * size["height"] / SIDE)
        if placer.fits(poly):
            y = float(ground(np.array([origin[0]]), np.array([origin[1]]))[0])
            out.append(_line_feature("kicker", origin, t, y, profile, size["width"]))
            placer.take(poly)
            d += (u1 - u0) + GAP
            k += 1
            kickers += 1
        else:
            d += 5.0
    return out


def _jib_line(spine, offset, placer, ground) -> list[dict]:
    out: list[dict] = []
    d = LEAD_IN
    while d < spine.length - 15:
        centre, t = _frame(spine, d)
        origin = centre + np.array([-t[1], t[0]]) * offset
        grade = _grade(ground, origin, t, 12.0)
        if not 2.0 <= grade <= MAX_GRADE:
            d += 5.0
            continue
        ramp, box = box_profile(grade)
        origin = origin - t * float(ramp[0, 0])
        poly = _footprint(origin, t, float(ramp[0, 0]), float(box[-1, 0]) + 1, BOX["rampWidth"] + 1)
        if placer.fits(poly):
            y = float(ground(np.array([origin[0]]), np.array([origin[1]]))[0])
            out.append(_line_feature("ramp", origin, t, y, ramp, BOX["rampWidth"]))
            out.append(_line_feature("box", origin, t, y, box, BOX["width"]))
            placer.take(poly)
            d += BOX["length"] + BOX["ramp"] + GAP * 0.8
        else:
            d += 5.0
    return out


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


def layout(piste: dict, ground, blocked=None) -> list[dict]:
    """Every generated feature of one park (all its areas and lines)."""
    from .pistes import TYPE_WIDTH

    features: list[dict] = []
    style = "course" if CROSS_NAMES.search(piste.get("name") or "") else "jumps"
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
        sizes = size_for(piste)
        if width >= TWO_LINES:
            features += _jump_line(spine, width * 0.15, sizes, placer, ground, False)
            features += _jib_line(spine, -width * 0.25, placer, ground)
        else:
            features += _jump_line(spine, 0.0, sizes, placer, ground, True)
    return features


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
