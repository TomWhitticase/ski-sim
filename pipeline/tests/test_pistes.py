import numpy as np
import pytest
from shapely.geometry import LineString

from ski_sim_pipeline.config import Extent
from ski_sim_pipeline.grid import Grid
from ski_sim_pipeline.pistes import (
    DIFFICULTY_COLOURS,
    _start_heading,
    dash_gaps,
    lookup_image,
    overlay_image,
    rasterise,
    ungroomed_image,
)


def test_start_heading_follows_the_run_not_the_straight_line_to_its_bottom():
    # Run starts heading east, then hooks round to finish far to the south-west.
    line = LineString([(0, 0), (200, 0), (200, -500), (-800, -800)])

    def ground(e, n):
        # Falls away along the line's path: lower to the east first.
        return 3000 - np.asarray(e) * 0.3 + np.asarray(n) * 0.5

    heading = _start_heading([line], (0, 0), ground)
    assert heading == pytest.approx(90, abs=1)


def test_rasterise_overlay_and_lookup():
    # 2 m fine grid; runs centred on north = -12 (fine row 6, 4 m row 3) and north = -28.
    grid = Grid(Extent(0, 40, -40, 0), 2)
    pistes = [
        {"index": 1, "difficulty": 3, "groomed": True},
        {"index": 2, "difficulty": 6, "groomed": False},
    ]
    shapes = [
        (1, LineString([(0, -12), (40, -12)]).buffer(5), False, None),
        (2, LineString([(0, -28), (40, -28)]).buffer(5), False, None),
    ]
    fine = rasterise(shapes, grid)
    assert fine[6, 10] == 1
    assert fine[14, 10] == 2
    assert fine[10, 10] == 0

    overlay = np.asarray(overlay_image(fine, pistes, 2))  # 4 m cells
    assert overlay.shape == (11, 11, 4)
    assert overlay[3, 5, 3] == 255  # fully inside the red run
    assert tuple(overlay[3, 5, :3]) == DIFFICULTY_COLOURS[3]
    assert overlay[5, 5, 3] == 0  # between runs
    # Freeride is coloured too (orange), and the mask marks it as unprepared snow.
    assert overlay[7, 5, 3] == 255
    assert tuple(overlay[7, 5, :3]) == DIFFICULTY_COLOURS[6]
    ungroomed = np.asarray(ungroomed_image(fine, pistes, 2))
    assert ungroomed.shape == (11, 11)
    assert ungroomed[7, 5] == 255 and ungroomed[3, 5] == 0

    lookup = np.asarray(lookup_image(fine, pistes, 2))
    assert lookup[3, 5, 0] == 1 and lookup[3, 5, 2] == 3
    assert lookup[7, 5, 0] == 2 and lookup[7, 5, 2] == 6


def test_named_runs_win_over_unnamed_connectors():
    grid = Grid(Extent(0, 40, -40, 0), 2)
    runs = [{"index": 1, "name": "Christine"}, {"index": 2, "name": None}]
    blob = LineString([(0, -20), (40, -20)]).buffer(6)
    # Unnamed listed last would normally overwrite; the named run must still win.
    fine = rasterise([(1, blob, False, None), (2, blob, False, None)], grid, runs)
    assert fine[10, 10] == 1


def test_named_centrelines_win_over_unnamed_areas():
    grid = Grid(Extent(0, 40, -40, 0), 2)
    runs = [{"index": 1, "name": "Christine"}, {"index": 2, "name": None}]
    blob = LineString([(0, -20), (40, -20)]).buffer(6)
    fine = rasterise([(1, blob, False, None), (2, blob, True, None)], grid, runs)
    assert fine[10, 10] == 1


def _way(tags, coords, closed=False):
    pts = [{"lon": 6.0 + e / 78_000, "lat": 45.0 + n / 111_000} for e, n in coords]
    if closed:
        pts.append(pts[0])
    return {"type": "way", "tags": tags, "geometry": pts}


def _collect(elements):
    from ski_sim_pipeline.config import GeoPoint
    from ski_sim_pipeline.frame import LocalFrame
    from ski_sim_pipeline.pistes import collect

    return collect(elements, LocalFrame(GeoPoint(45.0, 6.0)), Extent(-1000, 1000, -1000, 1000))


def test_other_run_types_are_kept_with_their_own_colour_and_lookup_code():
    from ski_sim_pipeline.pistes import RUN_TYPES, TYPE_COLOURS, colour_of

    pistes, shapes = _collect(
        [
            _way({"piste:type": "nordic;hike", "name": "Loop"}, [(0, 0), (300, 0)]),
            _way({"piste:type": "sled"}, [(0, 100), (300, 100)]),
            _way({"piste:type": "skitour"}, [(0, 200), (300, 200)]),
            _way({"piste:type": "connection"}, [(0, 300), (300, 300)]),
            _way({"piste:type": "ski_jump"}, [(0, 400), (300, 400)]),  # not kept
        ]
    )
    assert [p["type"] for p in pistes] == ["nordic", "sled", "skitour", "connection"]
    assert [p["difficulty"] for p in pistes] == [0, 0, 0, 0]  # untagged: none
    assert pistes[2]["groomed"] is False  # touring: powder
    assert colour_of(pistes[1]) == TYPE_COLOURS["sled"]

    grid = Grid(Extent(-20, 320, -20, 320), 2)
    fine = rasterise(shapes, grid, pistes)
    lookup = np.asarray(lookup_image(fine, pistes, 4))  # 8 m cells
    row = round(320 / 8)  # north = 0
    assert lookup[row, 10, 2] == RUN_TYPES["nordic"] << 4
    overlay = np.asarray(overlay_image(fine, pistes, 1))
    # Touring route: dashed (drawn, then a gap), and unprepared; the sledging run is solid.
    gaps = dash_gaps(shapes, pistes, grid)
    overlay = np.asarray(overlay_image(fine, pistes, 1, gaps))
    ungroomed = np.asarray(ungroomed_image(fine, pistes, 1, gaps))
    tour = round((320 - 200) / 2)
    dash = round((10 + 20) / 2)  # 10 m along the line (it starts at east 0, col 10)
    gap = round((20 + 25) / 2)  # 25 m along: in the first gap
    assert overlay[tour, dash, 3] == 255 and ungroomed[tour, dash] == 255
    assert overlay[tour, gap, 3] == 0 and ungroomed[tour, gap] == 0
    assert tuple(overlay[tour, dash, :3]) == TYPE_COLOURS["skitour"]
    sled = round((320 - 100) / 2)
    assert overlay[sled, gap, 3] == 255 and ungroomed[sled, gap] == 0


def test_bridges_tunnels_and_floodlights():
    from ski_sim_pipeline.pistes import floodlights, lit_mask

    pistes, shapes = _collect(
        [
            _way({"piste:type": "downhill", "name": "A"}, [(0, 0), (200, 0)]),
            _way({"piste:type": "downhill", "name": "A", "bridge": "yes"}, [(200, 0), (240, 0)]),
            _way({"piste:type": "downhill", "name": "A", "layer": "-1"}, [(240, 0), (300, 0)]),
            _way(
                {"piste:type": "downhill", "name": "B", "piste:lit": "yes", "piste:ref": "12"},
                [(0, 200), (400, 200)],
            ),
        ]
    )
    a, b = pistes
    assert len(a["lines"]) == 1 and len(a["bridges"]) == 1 and len(a["tunnels"]) == 1
    assert len(shapes) == 3  # the tunnel isn't on the snow surface
    assert b["ref"] == "12" and len(b["lit"]) == 1

    lamps = floodlights(pistes, lambda e, n: np.full(len(e), 1000.0))
    assert len(lamps) == 10  # every ~40 m along 400 m
    offsets = [n - 200 for _, n, _ in lamps]  # (degrees above are approximate: ±1 m)
    assert all(abs(abs(d) - 20.5) < 1.5 for d in offsets)  # just outside the 35 m wide run
    assert offsets[0] * offsets[1] < 0  # alternating sides
    image, extent = lit_mask(pistes, lamps)
    glow = np.asarray(image)
    row = round((extent.north - 200) / 4)
    assert glow[row, round((200 - extent.west) / 4)] > 200  # on the run between masts
    assert glow[round((extent.north - 150) / 4), round((100 - extent.west) / 4)] == 0  # off it


def test_pistes_mostly_outside_the_resort_are_left_out():
    from ski_sim_pipeline.config import GeoPoint
    from ski_sim_pipeline.frame import LocalFrame
    from ski_sim_pipeline.pistes import collect

    frame = LocalFrame(GeoPoint(45.0, 6.0))

    def way(i, name, points):
        geometry = []
        for east, north in points:
            lon, lat = frame.to_lonlat(east, north)
            geometry.append({"lat": lat, "lon": lon})
        tags = {"piste:type": "downhill", "piste:difficulty": "easy", "name": name}
        return {"type": "way", "id": i, "tags": tags, "geometry": geometry}

    elements = [
        way(1, "Ours", [(0, 0), (100, -200), (200, -400)]),
        way(2, "Next door", [(450, 0), (600, -100), (700, -200)]),
    ]
    extent = Extent(-1000, 1000, -1000, 1000)
    assert len(collect(elements, frame, extent)[0]) == 2
    runs, _ = collect(elements, frame, extent, area=Extent(-500, 500, -500, 500))
    assert [r["name"] for r in runs] == ["Ours"]
