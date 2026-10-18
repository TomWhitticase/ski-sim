from ski_sim_pipeline.bases import find_bases
from ski_sim_pipeline.config import Extent, GeoPoint
from ski_sim_pipeline.frame import LocalFrame


def test_villages_with_lifts_become_start_points():
    frame = LocalFrame(GeoPoint(45.0, 6.0))
    extent = Extent(-5000, 5000, -5000, 5000)

    def place(name, kind, e, n):
        lon, lat = frame.to_lonlat(e, n)
        return {"type": "node", "lat": lat, "lon": lon, "tags": {"name": name, "place": kind}}

    def lift(name, kind, e, n):
        s = {"east": e, "north": n, "ground": 1800, "top": 1805}
        return {"name": name, "type": kind, "supports": [s, {**s, "north": n + 1000}]}

    lifts = [lift("Big Gondola", "gondola", 100, 0), lift("Drag", "platter", 50, 50)]
    # A chalet right where the first-choice spot would be.
    chalet = {"footprint": [[90, -45], [110, -45], [110, -25], [90, -25]]}
    bases = find_bases(
        [place("Ski Town", "village", 0, 0), place("Far Hamlet", "hamlet", 4000, 4000)],
        lifts,
        [chalet],
        frame,
        extent,
        lambda e, n: e * 0 + 1800,
    )
    assert [b["name"] for b in bases] == ["Ski Town"]  # the hamlet has no lifts nearby
    b = bases[0]
    assert b["lift"] == "Big Gondola"  # the biggest lift wins
    assert b["heading"] == 0  # facing up the lift (north)
    assert b["north"] < 0  # in front of (below) the bottom station
    assert not (90 <= b["east"] <= 110 and -45 <= b["north"] <= -25)  # not in the chalet


def test_boxed_in_stations_still_get_a_start_within_boarding_range():
    frame = LocalFrame(GeoPoint(45.0, 6.0))
    extent = Extent(-5000, 5000, -5000, 5000)
    lon, lat = frame.to_lonlat(0, 0)
    s = {"east": 0, "north": 0, "ground": 1800, "top": 1805}
    lift = {"name": "Jardin Alpin", "type": "gondola", "supports": [s, {**s, "north": 1000}]}
    # A wall of chalets right behind the station; only the sides are clear.
    behind = {"footprint": [[-60, -60], [60, -60], [60, -5], [-60, -5]]}
    bases = find_bases(
        [{"type": "node", "lat": lat, "lon": lon, "tags": {"name": "1850", "place": "village"}}],
        [lift],
        [behind],
        frame,
        extent,
        lambda e, n: e * 0 + 1800,
    )
    b = bases[0]
    assert (b["east"] ** 2 + b["north"] ** 2) ** 0.5 <= 32
    assert not (-62 <= b["east"] <= 62 and -62 <= b["north"] <= -3)
