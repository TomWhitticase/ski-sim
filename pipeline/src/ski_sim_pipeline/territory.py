"""Which ground belongs to the resort, so a neighbouring ski area isn't half-included.

The near terrain reaches past the resort's `bounds` (snapped outward, and the bounds
themselves are a padded box), so it often takes in the edge of the next resort along.
OSM maps ski areas as `landuse=winter_sports` outlines: ours are the ones centred inside
our bounds, the rest are neighbours. A point is ours if it's in one of our outlines, or
inside our bounds and not in a neighbour's. A lift with a station in a neighbour's
outline is theirs even if its other end reaches our ground (a link into a shared summit
station, like Courmayeur's Skyway arriving at Pointe Helbronner).
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
from shapely import prepared
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from .config import Area, Extent
from .frame import LocalFrame

LIFT_SERVED_RUNS = {"downhill", "snow_park", "sled", "playground", "connection"}
# Our outlines are slightly generous: lift stations and run tops sit on their edges.
OWN_MARGIN = 150.0  # m


class Territory:
    def __init__(self, bounds: Extent, own: list[Polygon], neighbours: list[Polygon]):
        self.bounds = bounds
        self._own = prepared.prep(unary_union(own).buffer(OWN_MARGIN)) if own else None
        self._neighbours = prepared.prep(unary_union(neighbours)) if neighbours else None

    def contains(self, east: float, north: float) -> bool:
        p = Point(east, north)
        if self._own is not None and self._own.contains(p):
            return True
        if not self.bounds.contains(east, north):
            return False
        return self._neighbours is None or not self._neighbours.contains(p)

    def neighbours(self, east: float, north: float) -> bool:
        """In a neighbouring ski area's outline (and not one of ours)."""
        if self._neighbours is None:
            return False
        p = Point(east, north)
        return self._neighbours.contains(p) and not (
            self._own is not None and self._own.contains(p)
        )


def from_osm(elements: list[dict], frame: LocalFrame, bounds: Extent) -> Territory:
    """A territory from `landuse=winter_sports` ways (`out geom`)."""
    own, neighbours = [], []
    for el in elements:
        geometry = el.get("geometry") or []
        if el.get("type") != "way" or len(geometry) < 4:
            continue
        # buffer(0) repairs self-touching outlines.
        poly = Polygon([frame.to_local(p["lon"], p["lat"]) for p in geometry]).buffer(0)
        if poly.is_empty:
            continue
        c = poly.centroid
        (own if bounds.contains(c.x, c.y) else neighbours).append(poly)
    return Territory(bounds, own, neighbours)


def lift_is_ours(ends: Sequence[tuple[float, float]], area: Area) -> bool:
    """A lift (its two stations) belongs to `area`: a station on our ground and, with a
    `Territory`, none on a neighbour's."""
    if not any(area.contains(e, n) for e, n in ends):
        return False
    neighbours = getattr(area, "neighbours", None)
    return neighbours is None or not any(neighbours(e, n) for e, n in ends)


def piste_is_ours(points: Sequence[tuple[float, float]], area: Area) -> bool:
    """A run (one way's points) belongs to `area`: most of its points are on our ground."""
    ours = [area.contains(e, n) for e, n in points]
    return sum(ours) * 2 >= len(ours)


def own_extent(
    lift_elements: list[dict], piste_elements: list[dict], frame: LocalFrame, area: Area
) -> Extent | None:
    """The box holding every lift and lift-served run of ours (OSM ways with geometry): the near
    terrain must cover it, or the lifts at its edge are dropped and the runs cut off."""
    points = []
    for el in lift_elements:
        geometry = el.get("geometry") or []
        if el.get("type") != "way" or len(geometry) < 2 or geometry[0] == geometry[-1]:
            continue
        pts = np.column_stack(frame.to_local(*_lon_lat(geometry)))
        if lift_is_ours([tuple(pts[0]), tuple(pts[-1])], area):
            points.append(pts)
    for el in piste_elements:
        geometry = el.get("geometry") or []
        if el.get("type") != "way" or len(geometry) < 2:
            continue
        # Lift-served runs only: a cross-country or touring route can wander for 30 km.
        types = {t.strip() for t in el.get("tags", {}).get("piste:type", "").split(";")}
        if not types & LIFT_SERVED_RUNS:
            continue
        pts = np.column_stack(frame.to_local(*_lon_lat(geometry)))
        if piste_is_ours([tuple(p) for p in pts], area):
            points.append(pts)
    if not points:
        return None
    every = np.concatenate(points)
    west, south = every.min(axis=0)
    east, north = every.max(axis=0)
    return Extent(west=float(west), south=float(south), east=float(east), north=float(north))


def _lon_lat(geometry: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    return np.array([p["lon"] for p in geometry]), np.array([p["lat"] for p in geometry])
