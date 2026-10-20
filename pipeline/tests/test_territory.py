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


def test_a_neighbours_link_into_our_summit_station_is_theirs():
    from ski_sim_pipeline.features import extract_lifts

    frame = LocalFrame(GeoPoint(45.0, 6.0))
    ours = box(-1000, -1000, 1000, 1000)
    next_door = box(-1000, -3000, 1000, -1300)  # south of ours, centred off our bounds
    t = Territory(Extent(-1200, 1200, -2000, 1200), [ours], [next_door])
    assert t.neighbours(0, -2000) and not t.neighbours(0, 0)
    assert not t.neighbours(0, -1100)  # just past our outline: ours wins

    def lift(name, ends):
        geometry = [dict(zip(("lon", "lat"), frame.to_lonlat(e, n), strict=True)) for e, n in ends]
        return {
            "type": "way",
            "id": len(name),
            "tags": {"aerialway": "cable_car", "name": name},
            "geometry": geometry,
        }

    elements = [
        lift("ours", [(0, -500), (0, 800)]),
        lift("their link", [(0, -2000), (0, 800)]),  # from their valley to our summit
    ]
    lifts = extract_lifts(
        elements, frame, Extent(-5000, 5000, -5000, 5000), lambda e, n: 0 * e + 2000, [], t
    )
    assert [x["name"] for x in lifts] == ["ours"]
