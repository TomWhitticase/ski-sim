"""National borders for the map and minimap.

OSM maps each border as the ways of two neighbouring countries' `boundary=administrative`
`admin_level=2` relations. Those ways are chained into continuous lines, clipped to the
map, simplified, and each line is labelled with the country on either side, found by
asking Overpass which country contains a point a little to each side of its middle.

Where countries disagree about a border (Mont Blanc's summit, for one), OSM draws one
version; the sim labels it as OSM's line, not a settled one.
"""

from __future__ import annotations

import logging
import math

from shapely.geometry import LineString, MultiLineString, box

from .config import Extent
from .frame import LocalFrame

log = logging.getLogger(__name__)

SIMPLIFY = 5.0  # m: well under a map pixel at full zoom
SIDE_OFFSET = 300.0  # m either side of a line's middle, to ask which country is there
MIN_LENGTH = 200.0  # m: shorter clipped scraps aren't worth a line or a label
JOIN = 1e-7  # degrees: endpoints this close are the same node


def chain(ways: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Join ways that share endpoints into the longest continuous lines (lon, lat)."""
    lines = [list(w) for w in ways if len(w) >= 2]
    merged = True
    while merged:
        merged = False
        for i, a in enumerate(lines):
            for j in range(i + 1, len(lines)):
                b = lines[j]
                if _same(a[-1], b[0]):
                    joined = a + b[1:]
                elif _same(a[-1], b[-1]):
                    joined = a + b[-2::-1]
                elif _same(a[0], b[-1]):
                    joined = b + a[1:]
                elif _same(a[0], b[0]):
                    joined = b[::-1] + a[1:]
                else:
                    continue
                lines[i] = joined
                del lines[j]
                merged = True
                break
            if merged:
                break
    return lines


def _same(p: tuple[float, float], q: tuple[float, float]) -> bool:
    return abs(p[0] - q[0]) < JOIN and abs(p[1] - q[1]) < JOIN


def border_ways(elements: list[dict]) -> list[list[tuple[float, float]]]:
    """(lon, lat) point lists of the border ways in an Overpass response, deduplicated
    (a way is a member of both countries' relations)."""
    seen: set[int] = set()
    ways = []
    for el in elements:
        if el.get("type") != "way" or el["id"] in seen or "geometry" not in el:
            continue
        seen.add(el["id"])
        ways.append([(p["lon"], p["lat"]) for p in el["geometry"]])
    return ways


def clip(
    lines: list[list[tuple[float, float]]], frame: LocalFrame, extent: Extent
) -> list[list[tuple[float, float]]]:
    """Project (lon, lat) lines into local metres, clip them to the extent and simplify."""
    window = box(extent.west, extent.south, extent.east, extent.north)
    out = []
    for line in lines:
        east, north = frame.to_local([p[0] for p in line], [p[1] for p in line])
        clipped = LineString(list(zip(east, north, strict=True))).intersection(window)
        parts = clipped.geoms if isinstance(clipped, MultiLineString) else [clipped]
        for part in parts:
            if not isinstance(part, LineString) or part.length < MIN_LENGTH:
                continue
            simple = part.simplify(SIMPLIFY)
            out.append([(round(x, 1), round(y, 1)) for x, y in simple.coords])
    return out


def side_points(line: list[tuple[float, float]]) -> tuple[tuple[float, float], ...]:
    """Points SIDE_OFFSET to the left and right of the middle of a line (local metres)."""
    shape = LineString(line)
    mid = shape.interpolate(0.5, normalized=True)
    ahead = shape.interpolate(min(shape.length, shape.length / 2 + 10))
    behind = shape.interpolate(max(0.0, shape.length / 2 - 10))
    de, dn = ahead.x - behind.x, ahead.y - behind.y
    norm = math.hypot(de, dn) or 1.0
    left = (-dn / norm, de / norm)
    return (
        (mid.x + left[0] * SIDE_OFFSET, mid.y + left[1] * SIDE_OFFSET),
        (mid.x - left[0] * SIDE_OFFSET, mid.y - left[1] * SIDE_OFFSET),
    )


def country_query(points: list[tuple[float, float]]) -> str:
    """One Overpass request asking which country contains each (lon, lat) point. Each
    answer is followed by a `sep` element numbering the point."""
    parts = ["[out:json][timeout:120];"]
    for i, (lon, lat) in enumerate(points):
        parts.append(
            f"is_in({lat:.6f},{lon:.6f})->.a;"
            'area.a["boundary"="administrative"]["admin_level"="2"];out tags;'
            f"make sep n={i};out;"
        )
    return "".join(parts)


def countries(elements: list[dict], count: int) -> list[str | None]:
    """Country name per point from a `country_query` response (English if tagged)."""
    names: list[str | None] = [None] * count
    pending: str | None = None
    for el in elements:
        if el.get("type") == "sep":
            names[int(el["tags"]["n"])] = pending
            pending = None
        else:
            tags = el.get("tags", {})
            pending = tags.get("name:en") or tags.get("name")
    return names


def build(
    elements: list[dict],
    frame: LocalFrame,
    extent: Extent,
    lookup,
) -> list[dict]:
    """Border lines on the map, each with the country to its left and right. `lookup` maps
    an Overpass query to its elements (cached by the caller)."""
    lines = clip(chain(border_ways(elements)), frame, extent)
    if not lines:
        return []
    sides = [side_points(line) for line in lines]
    points = [frame.to_lonlat(e, n) for pair in sides for e, n in pair]
    names = countries(lookup(country_query(points)), len(points))
    out = []
    for k, line in enumerate(lines):
        left, right = names[2 * k], names[2 * k + 1]
        out.append({"line": [list(p) for p in line], "left": left, "right": right})
    log.info(
        "%d border lines: %s",
        len(out),
        ", ".join(sorted({f"{b['left']} / {b['right']}" for b in out})),
    )
    return out
