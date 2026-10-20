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

from shapely import prepared
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from .config import Extent
from .frame import LocalFrame

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
