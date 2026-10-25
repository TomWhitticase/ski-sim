import json
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import LineString, Polygon

from ski_sim_pipeline import airfields
from ski_sim_pipeline.airfields import (
    BANK_GAP,
    BANK_RUN,
    RunwayRef,
    collect,
    designators,
    extend_to,
    finish,
    grade,
    is_paved,
    slopes,
    validate,
)
from ski_sim_pipeline.config import Extent, GeoPoint
from ski_sim_pipeline.frame import LocalFrame
from ski_sim_pipeline.grid import Grid, sample_bilinear
from ski_sim_pipeline.sources.ourairports import Airport, RunwayEnd
from ski_sim_pipeline.sources.ourairports import Runway as OurRunway

FRAME = LocalFrame(GeoPoint(45.4, 6.6))
EXTENT = Extent(-1000, 1000, -1000, 1000)
GRID = Grid(Extent(-600, 600, -400, 400), 4)


def terrain(fn) -> np.ndarray:
    east, north = GRID.coords()
    e, n = np.meshgrid(east, north)
    return fn(e, n).astype(np.float32)


def at(heights, e, n):
    return sample_bilinear(heights, GRID, np.atleast_1d(e), np.atleast_1d(n))


def way(id_, points, **tags) -> dict:
    """An OSM way through local (east, north) points."""
    geometry = []
    for e, n in points:
        lon, lat = FRAME.to_lonlat(e, n)
        geometry.append({"lat": lat, "lon": lon})
    return {"type": "way", "id": id_, "tags": tags, "geometry": geometry}


def node(id_, e, n, **tags) -> dict:
    lon, lat = FRAME.to_lonlat(e, n)
    return {"type": "node", "id": id_, "lat": lat, "lon": lon, "tags": tags}


# An altiport like Courchevel: a runway climbing east at 18.6% for 400 m, then level for
# 140 m (the top, where the apron is), on a hillside that also falls 10% to the south.
SLOPE = 0.186
TOP = 400.0


def altiport(e, n):
    along = np.minimum(np.clip(e + 300, 0, None), TOP) * SLOPE
    return 1800 + along + 0.10 * n + 0.3 * np.sin(e / 7.0)


RUNWAY = [(-300.0, 0.0), (240.0, 0.0)]


def test_designators_from_ref_and_heading():
    # Drawn heading 042°: the 04 threshold is where the line starts.
    assert designators("04/22", 42) == ("04", "22", False)
    # Drawn the other way (heading 222°), the line starts at the 22 end.
    assert designators("04/22", 222) == ("22", "04", True)
    assert designators("10-28", 100) == ("10", "28", False)
    assert designators("4L/22R", 40) == ("04L", "22R", False)
    # No ref: from the heading, 36 for north.
    assert designators(None, 2) == ("36", "18", False)
    assert designators("foo", 271) == ("27", "09", False)


def test_paved_surfaces():
    assert is_paved("asphalt") and is_paved("concrete") and is_paved("ASP") and is_paved("Asphalt")
    assert not is_paved("grass") and not is_paved(None) and not is_paved("ground")


def test_runway_keeps_its_profile_and_is_level_across():
    heights = terrain(altiport)
    fields = collect(
        [way(1, RUNWAY, aeroway="runway", ref="09/27", width="40", surface="asphalt")],
        FRAME,
        EXTENT,
    )
    before = slopes(fields["runways"][0]["line"], lambda e, n: at(heights, e, n))
    stats = grade(fields, heights, GRID)
    assert stats["runways"] == 1
    line = fields["runways"][0]["line"]
    after = slopes(line, lambda e, n: at(heights, e, n))
    # The 18.6% climb stays (no flattening), within half a point, and so does the top.
    assert after["steepest"] == pytest.approx(100 * SLOPE, abs=0.5)
    assert after["mean"] == pytest.approx(before["mean"], abs=0.5)
    top = at(heights, np.array([150.0, 230.0]), np.array([0.0, 0.0]))
    assert abs(top[1] - top[0]) < 0.3
    # Level across the whole 40 m (the hillside fell 4 m across it).
    for e in (-200.0, 0.0, 200.0):
        left, right = at(heights, np.array([e, e]), np.array([18.0, -18.0]))
        assert abs(left - right) < 0.15
    assert airfields.cross_slope(line, 20, lambda e, n: at(heights, e, n)) < 1.0
    # Out beyond the bench and its banks the hillside is untouched.
    far = at(heights, np.array([0.0]), np.array([90.0]))
    assert far[0] == pytest.approx(altiport(np.array([0.0]), np.array([90.0]))[0], abs=0.05)


def test_helipad_is_level_and_apron_limited_to_its_grade():
    heights = terrain(lambda e, n: 1500 + 0.2 * e)
    elements = [
        way(
            1,
            [(-30, -30), (30, -30), (30, 30), (-30, 30), (-30, -30)],
            aeroway="apron",
            surface="asphalt",
        ),
        way(2, [(100, -6), (112, -6), (112, 6), (100, 6), (100, -6)], aeroway="helipad"),
    ]
    fields = collect(elements, FRAME, EXTENT)
    grade(fields, heights, GRID)
    pad = at(heights, np.array([101.0, 111.0, 106.0]), np.array([-5.0, 5.0, 0.0]))
    assert np.ptp(pad) < 0.1
    apron = at(heights, np.array([-28.0, 28.0]), np.array([0.0, 0.0]))
    assert (apron[1] - apron[0]) / 56 == pytest.approx(airfields.MAX_APRON_GRADE, abs=0.005)


def test_winter_state_and_connected_surfaces():
    elements = [
        way(1, RUNWAY, aeroway="runway", ref="09/27", width="30", surface="asphalt"),
        # No surface tag, but joins the asphalt runway: asphalt too.
        way(2, [(0, 0), (0, -80)], aeroway="taxiway"),
        way(3, [(-300, 200), (-100, 200)], aeroway="runway", ref="09/27", surface="grass"),
        way(4, [(400, 200), (400, 260)], aeroway="taxiway"),  # unconnected, unknown: snow
    ]
    fields = collect(elements, FRAME, EXTENT)
    winter = {str(r["id"]): r["winter"] for r in fields["runways"] + fields["taxiways"]}
    assert winter == {"1": "cleared", "2": "cleared", "3": "groomed", "4": "groomed"}


def test_rooftop_helipad_goes_on_its_building():
    building = [(200, 200), (240, 200), (240, 230), (200, 230)]
    elements = [
        way(5, [(212, 207), (228, 207), (228, 223), (212, 223), (212, 207)], aeroway="helipad"),
        node(6, 0, 0, aeroway="helipad", location="roof"),  # tagged, but no building there
    ]
    fields = collect(elements, FRAME, EXTENT, building_rings=[building])
    pads = {p["id"]: p for p in fields["helipads"]}
    assert pads[5]["roof"] and pads[6]["roof"]
    heights = terrain(lambda e, n: 1000 + 0 * e)
    before = heights.copy()
    grade(fields, heights, GRID)
    assert np.array_equal(heights, before)  # rooftop pads aren't built into the ground
    record = {"id": 99, "footprint": building, "top": 1012.0, "roof": {"rise": 2}}
    out = finish(fields, lambda e, n: at(heights, e, n), [record])
    by_id = {p["id"]: p for p in out["helipads"]}
    assert by_id[5]["roof"] and by_id[5]["building"] == 99 and by_id[5]["top"] == 1012.0
    assert record["roof"] is None  # made flat for the pad
    # The node had no building under it after all: on the ground.
    assert not by_id[6]["roof"] and by_id[6]["top"] == pytest.approx(1000.0)


def test_snowbanks_have_gaps_and_snow_runways_markers():
    heights = terrain(lambda e, n: 1000 + 0 * e)
    elements = [
        way(1, RUNWAY, aeroway="runway", ref="09/27", width="30", surface="asphalt"),
        way(2, [(0, 0), (0, -100)], aeroway="taxiway", width="10"),
        way(
            3, [(-300, 200), (-60, 200)], aeroway="runway", ref="09/27", width="20", surface="grass"
        ),
        node(4, 50, 60, aeroway="windsock"),
    ]
    fields = collect(elements, FRAME, EXTENT)
    out = finish(fields, lambda e, n: at(heights, e, n), [])
    banks = [LineString(b) for b in out["snowbanks"]]
    assert banks and max(b.length for b in banks) <= BANK_RUN + 1e-6
    # Two runway edges and both sides of the taxiway: the runway's south bank stops at the
    # taxiway, so nothing blocks it.
    taxi = LineString([(0, -15), (0, -100)]).buffer(5)
    assert not any(b.intersects(taxi) for b in banks)
    north_edge = sorted((b for b in banks if b.coords[0][1] > 0), key=lambda b: b.bounds[0])
    gaps = [b.bounds[0] - a.bounds[2] for a, b in zip(north_edge, north_edge[1:], strict=False)]
    assert gaps and all(g == pytest.approx(BANK_GAP, abs=0.1) for g in gaps)
    # The grass runway: edge markers every 30 m on both sides, no banks.
    markers = [m for m in out["markers"] if m[1] > 150]
    assert len(markers) == 2 * (round(240 / airfields.MARKER_SPACING) + 1)
    assert not any(b.coords[0][1] > 150 for b in banks)
    assert out["windsocks"][0]["ground"] == pytest.approx(1000.0)


def test_lengthened_to_the_published_length_at_the_open_end():
    line = LineString([(0, 0), (500, 0)])
    # The first end is on its published threshold: the second is lengthened.
    longer, added = extend_to(line, 537, {"22": (0.5, 0.0)}, ["22", "04"])
    assert added == pytest.approx(37) and longer.coords[0] == (0.0, 0.0)
    assert longer.length == pytest.approx(537)
    # Nothing known about the ends: both ways.
    both, _ = extend_to(line, 520, {}, ["09", "27"])
    assert both.coords[0][0] == pytest.approx(-10)
    # Close enough, or mapped so differently it isn't the same runway: left alone.
    assert extend_to(line, 505, {}, ["09", "27"])[1] == 0
    assert extend_to(line, 900, {}, ["09", "27"])[1] == 0


def test_validation_against_published_figures():
    heights = terrain(altiport)
    airport = Airport(
        "1", "LFXX", "small_airport", "Test Altiport", 45.4, 6.6, 1950.0, "LFXX", None
    )
    lon0, lat0 = FRAME.to_lonlat(*RUNWAY[0])
    ours = OurRunway(
        "1",
        540.0,
        40.0,
        "ASP",
        False,
        (RunwayEnd("09", lat0, lon0, None, None), RunwayEnd("27", None, None, None, None)),
    )
    fields = collect(
        [way(1, RUNWAY, aeroway="runway", ref="09/27", surface="asphalt", incline="18.6%")],
        FRAME,
        EXTENT,
        [airport],
        [ours],
    )
    grade(fields, heights, GRID)
    ref = RunwayRef(
        "LFXX", "09/27", length=540, slope=18.6, elevations=(("low", 1800.0), ("27", 1874.4))
    )
    [check] = validate(fields, lambda e, n: at(heights, e, n), (ref,))
    assert check["icao"] == "LFXX" and check["width"]["mapped"] == 40
    assert check["length"]["error"] == pytest.approx(0, abs=0.5)
    assert check["length"]["mappedError"] == pytest.approx(0, abs=0.5)
    assert abs(check["slope"]["error"]) < 0.5
    assert {t["designator"] for t in check["thresholds"]} == {"09", "27"}
    assert all(abs(t["error"]) < 1.5 for t in check["thresholds"])


BUILT = Path(__file__).resolve().parents[2] / "data/processed/les-3-vallees/manifest.json"


@pytest.mark.skipif(not BUILT.exists(), reason="les-3-vallees not built")
def test_built_altiports_match_their_published_figures():
    """Courchevel (LFLJ) and Méribel (LFKX) in the built resort, against the figures in
    its config (published: 537 m at up to 18.6%; 406 m, 1,691 to 1,719 m)."""
    checks = json.loads(BUILT.read_text())["validation"].get("runways")
    if checks is None:
        pytest.skip("built before airfields")
    # The runways with published figures (Courchevel's grass strip has none).
    by_icao = {c["icao"]: c for c in checks if c["icao"] and c["length"]["published"]}
    courchevel = by_icao["LFLJ"]
    assert abs(courchevel["length"]["mappedError"]) < 0.08 * 537  # OSM's way: 501 m
    assert abs(courchevel["length"]["error"]) < 2
    assert abs(courchevel["slope"]["error"]) < 1.0
    assert courchevel["crossSlope"] < 1.5
    meribel = by_icao["LFKX"]
    assert abs(meribel["length"]["error"]) < 0.03 * 406
    assert abs(meribel["slope"]["error"]) < 1.5
    assert all(abs(t["error"]) < 3 for t in meribel["thresholds"])
    if "LFHU" in by_icao:  # Alpe d'Huez, in its own resort
        assert abs(by_icao["LFHU"]["length"]["error"]) < 0.05 * 450


def test_polygon_runway_centreline():
    poly = Polygon([(0, 0), (400, 0), (400, 20), (0, 20)])
    line, width = airfields._rectangle(poly)
    assert width == pytest.approx(20) and line.length == pytest.approx(400)


def test_designators_follow_the_drawn_line():
    # Courchevel's way is drawn from the 22 threshold (north-east) heading south-west.
    fields = collect(
        [way(1, [(200, 200), (-200, -200)], aeroway="runway", ref="04/22")], FRAME, EXTENT
    )
    [rw] = fields["runways"]
    assert rw["designators"] == ["22", "04"]
    assert rw["line"].coords[0] == pytest.approx((200, 200), abs=0.01)


def circle(id_, e, n, r, **tags) -> dict:
    ring = [(e + r * np.cos(a), n + r * np.sin(a)) for a in np.linspace(0, 2 * np.pi, 13)]
    return way(id_, ring, **tags)


def test_heliport_outline_over_its_pads_is_ground_not_a_pad():
    # Courchevel: the heliport drawn as one big "helipad" over a row of small pads.
    elements = [
        way(
            1,
            [(-20, -20), (120, -20), (120, 20), (-20, 20), (-20, -20)],
            aeroway="helipad",
            name="Heliport",
        ),
        *(circle(10 + i, 25.0 * i, 0, 3.5, aeroway="helipad") for i in range(5)),
        node(20, 300, 0, aeroway="helipad"),  # a lone default pad
        way(21, [(400, -40), (470, -40), (470, 40), (400, 40), (400, -40)], aeroway="helipad"),
    ]
    fields = collect(elements, FRAME, EXTENT)
    pads = {p["id"]: p for p in fields["helipads"]}
    assert 1 not in pads and 1 in {a["id"] for a in fields["aprons"]}
    # The row shares one size and no two markings overlap.
    assert {pads[10 + i]["size"] for i in range(5)} == {6.8}
    assert pads[20]["size"] == airfields.HELIPAD_SIZE
    # Too big for one pad: its ground is an apron, with a standard pad at its centre.
    assert pads[21]["size"] == airfields.HELIPAD_SIZE and pads[21]["ring"] is None
    assert 21 in {a["id"] for a in fields["aprons"]}
    assert any(n["name"] == "Heliport" for n in fields["aerodromes"])


def test_crowded_pads_shrink_apart():
    elements = [node(1, 0, 0, aeroway="helipad"), node(2, 12, 0, aeroway="helipad")]
    a, b = collect(elements, FRAME, EXTENT)["helipads"]
    assert a["size"] == b["size"] and a["size"] / 2 + b["size"] / 2 <= 12 - airfields.PAD_GAP


def test_round_pads_face_along_their_row_and_lone_ones_down_the_slope():
    # A row of round pads running north-east (their outlines say nothing about direction).
    row = [circle(10 + i, 20.0 * i, 20.0 * i, 3.5, aeroway="helipad") for i in range(4)]
    lone = node(30, -300, -300, aeroway="helipad")  # on its own, on a slope down to the east
    long_pad = way(31, [(300, 0), (330, 0), (330, 12), (300, 12), (300, 0)], aeroway="helipad")
    fields = collect([*row, lone, long_pad], FRAME, EXTENT)
    heights = terrain(lambda e, n: 1500 - 0.15 * e)
    out = finish(fields, lambda e, n: at(heights, e, n), [])
    heading = {p["id"]: p["heading"] for p in out["helipads"]}
    assert {heading[10 + i] for i in range(4)} == {45.0}
    assert heading[30] == pytest.approx(90.0, abs=1)
    assert heading[31] == pytest.approx(90.0, abs=1)  # longer east-west: keeps its own
