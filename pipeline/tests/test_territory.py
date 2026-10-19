from shapely.geometry import box

from ski_sim_pipeline.config import Extent, GeoPoint
from ski_sim_pipeline.frame import LocalFrame
from ski_sim_pipeline.territory import Territory, from_osm


def test_a_neighbouring_ski_area_is_not_ours():
    bounds = Extent(-1000, 1000, -1000, 1000)
    ours = box(-900, -700, 900, 900)
    next_door = box(700, -1500, 2500, 0)  # overlaps our bounds' south-east corner
    t = Territory(bounds, [ours], [next_door])
    assert t.contains(0, 0)
    assert t.contains(950, 500)  # in our bounds, no one else's
    assert t.contains(850, -500)  # where the outlines overlap, ours wins
    assert not t.contains(980, -980)  # the neighbour's, inside our bounds
    assert not t.contains(1500, 1500)  # outside everything
    assert t.contains(1030, 0)  # just past our outline (lift tops sit on the edge)


def test_ski_areas_are_ours_when_centred_in_our_bounds():
    frame = LocalFrame(GeoPoint(45.0, 6.0))

    def way(corners):
        geometry = []
        for east, north in corners:
            lon, lat = frame.to_lonlat(east, north)
            geometry.append({"lat": lat, "lon": lon})
        return {"type": "way", "tags": {"landuse": "winter_sports"}, "geometry": geometry}

    square = [(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]
    elements = [
        way([(x * 800, y * 800) for x, y in square]),
        way([(2000 + x * 1200, y * 600) for x, y in square]),  # centred off to the east
    ]
    t = from_osm(elements, frame, Extent(-1000, 1000, -1000, 1000))
    assert t.contains(0, 0)
    assert not t.contains(990, 0)  # inside our bounds but in the eastern resort
    assert t.contains(0, 950)
