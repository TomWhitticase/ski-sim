import math

import numpy as np

from ski_sim_pipeline import rope
from ski_sim_pipeline.crossings import SEPARATION, separate
from ski_sim_pipeline.terminals import HANG_DEPTH


def flat(e, n):
    return np.full(np.shape(e), 2000.0)


def line(lift_id, kind, a, b, height):
    def sup(p, k):
        return {"east": p[0], "north": p[1], "ground": 2000.0, "top": 2000.0 + height, "kind": k}

    return {
        "id": lift_id,
        "name": f"L{lift_id}",
        "type": kind,
        "gauge": 5,
        "supports": [sup(a, "station"), sup(b, "station")],
    }


def rope_at(lift, e, n):
    """Rope height where the line passes (e, n) (assumes it does)."""
    s = lift["supports"]
    for a, b in zip(s, s[1:], strict=False):
        dx, dy = b["east"] - a["east"], b["north"] - a["north"]
        t = ((e - a["east"]) * dx + (n - a["north"]) * dy) / (dx * dx + dy * dy)
        if 0 <= t <= 1:
            return rope.at(a, b, t, lift.get("catenary"))
    raise AssertionError("not on the line")


def test_two_chairlifts_crossing_at_one_height_are_separated():
    one = line(1, "chair_lift", (0, -400), (0, 400), 10)
    two = line(2, "chair_lift", (-400, 0), (400, 0), 10)
    stats = separate([one, two], flat)
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0, "atStations": 0}
    high, low = sorted([rope_at(one, 0, 0), rope_at(two, 0, 0)], reverse=True)
    assert high - HANG_DEPTH["chair"] - low >= SEPARATION - 0.05
    # Gently: the new towers climb no steeper than ~1 in 8 from the line's ends.
    upper = one if rope_at(one, 0, 0) > rope_at(two, 0, 0) else two
    tops = [s["top"] for s in upper["supports"]]
    assert all(s.get("crossing") for s in upper["supports"][1:-1])
    assert len(tops) == 4


def test_lines_already_far_apart_are_left_alone():
    one = line(1, "gondola", (0, -400), (0, 400), 30)
    two = line(2, "chair_lift", (-400, 0), (400, 0), 8)
    stats = separate([one, two], flat)
    assert stats["lifted"] == 0
    assert len(one["supports"]) == 2 and len(two["supports"]) == 2


def test_a_crossing_beside_a_station_is_resolved_by_the_first_tower_out():
    """No room for a tower between the hall and the crossing: the rope runs from the
    hall's exit, so the tower beyond the crossing lifts it, within the exit angle."""

    def sup(e, n, top, kind, **extra):
        return {"east": e, "north": n, "ground": 2000.0, "top": top, "kind": kind, **extra}

    one = {
        "id": 1,
        "name": "Station side",
        "type": "chair_lift",
        "gauge": 5,
        "catenary": 1100.0,
        "supports": [
            sup(0.0, -28.0, 2002.83, "station", exit=[0.0, -12.0]),
            sup(0.0, 150.0, 2011.0, "tower"),
            sup(0.0, 400.0, 2002.83, "station", exit=[0.0, 384.0]),
        ],
    }
    two = {
        "id": 2,
        "name": "Low line",
        "type": "chair_lift",
        "gauge": 5,
        "catenary": 1100.0,
        "supports": [
            sup(-300.0, 0.0, 2005.0, "station"),
            sup(-50.0, 0.0, 2001.5, "tower"),
            sup(50.0, 0.0, 2001.5, "tower"),
            sup(300.0, 0.0, 2005.0, "station"),
        ],
    }
    assert rope_at(one, 0, 0) > rope_at(two, 0, 0)
    stats = separate([one, two], flat)
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0, "atStations": 0}
    assert rope_at(one, 0, 0) - HANG_DEPTH["chair"] - rope_at(two, 0, 0) >= SEPARATION - 0.05
    first = one["supports"][1]
    assert first.get("crossing") and 0 < first["north"] < 150
    # Within the chair's 18° exit angle from the hall's exit.
    rise = first["top"] - 2002.83
    assert rise <= math.tan(math.radians(18)) * (first["north"] + 12) + 0.01


def test_a_sagging_rope_is_measured_at_its_low_point():
    """A long span that clears the other line at its towers, but not mid-span, sagging."""
    one = line(1, "chair_lift", (0, -150), (0, 150), 30)
    one["catenary"] = 1100.0
    two = line(2, "chair_lift", (-300, 0), (300, 0), 15)
    two["supports"][1:1] = [
        {**two["supports"][0], "east": e, "kind": "tower"} for e in (-20.0, 20.0)
    ]
    two["catenary"] = 1100.0
    # Straight, one's skis would pass 11.8 m over two's rope; sagging 300²/8800 = 10.2 m,
    # only 1.8 m.
    assert abs(rope_at(one, 0, 0) - (2030.0 - 300**2 / 8800)) < 1e-9
    stats = separate([one, two], flat)
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0, "atStations": 0}
    assert rope_at(one, 0, 0) - HANG_DEPTH["chair"] - rope_at(two, 0, 0) >= SEPARATION - 0.05


def S(e, n, ground, top, kind, exit=None):
    """A support from real geometry, heights relative to 2000 m."""
    s = {"east": e, "north": n, "ground": 2000.0 + ground, "top": 2000.0 + top, "kind": kind}
    if exit:
        s["exit"] = list(exit)
    return s


def real(lift_id, kind, catenary, supports):
    return {
        "id": lift_id,
        "name": f"L{lift_id}",
        "type": kind,
        "gauge": 5,
        "catenary": catenary,
        "supports": supports,
    }


def plane(de, dn):
    return lambda e, n: 2000.0 + de * np.asarray(e) + dn * np.asarray(n)


def clearance(upper, lower, kind):
    return rope_at(upper, 0, 0) - HANG_DEPTH[kind] - rope_at(lower, 0, 0)


def test_two_sections_sharing_a_station_do_not_cross():
    """Engelberg's Rugisbalm: two cable car sections into one station, OSM's lines
    overlapping inside both halls (16 m and 4 m from their station supports)."""
    eggen = real(
        1,
        "cable_car",
        4000.0,
        [
            S(15.7, -4.3, -8.5, -1.0, "station", exit=(-1.7, 0.5)),
            S(-42.4, 11.7, 14.7, 28.57, "synthetic-tower"),
            S(-46.3, 12.8, 16.0, 33.19, "synthetic-tower"),
        ],
    )
    mettlen = real(
        2,
        "cable_car",
        4000.0,
        [
            S(132.6, 211.1, -31.8, 16.98, "tower"),
            S(48.7, 78.0, -21.3, 17.97, "tower"),
            S(-2.2, -3.6, -8.5, -1.0, "station", exit=(7.3, 11.7)),
        ],
    )
    before = [[dict(s) for s in lift["supports"]] for lift in (eggen, mettlen)]
    stats = separate([eggen, mettlen], plane(-0.33, -0.27))
    assert stats == {"crossings": 0, "lifted": 0, "unresolved": 0, "atStations": 1}
    assert [eggen["supports"], mettlen["supports"]] == before


def test_a_drag_beside_a_gondola_station_does_not_cross_it():
    """Verbier: a platter starting beside a gondola's station, the lines overlapping
    2 m from both stations."""
    gondola = real(
        1,
        "gondola",
        1400.0,
        [
            S(16.5, 211.2, -24.9, -10.86, "tower"),
            S(1.4, 44.4, -6.2, 7.83, "tower"),
            S(-0.1, -1.7, 1.6, 5.89, "station", exit=(0.6, 18.3)),
        ],
    )
    platter = real(
        2,
        "platter",
        2000.0,
        [
            S(-62.3, 40.8, -0.8, 5.25, "synthetic-tower"),
            S(-42.2, 27.5, -0.7, 5.35, "tower"),
            S(2.0, -1.3, 1.6, 5.59, "station", exit=(-0.6, 0.4)),
        ],
    )
    stats = separate([gondola, platter], plane(0.015, -0.16))
    assert stats["atStations"] == 1 and stats["crossings"] == 0
    assert len(gondola["supports"]) == 3 and len(platter["supports"]) == 3


def test_a_line_over_the_hall_next_door_is_not_a_crossing():
    """Snow Space Salzburg's Kogelalm: the lines cross inside a cable car's hall, 18 m out of the
    gondola's own: to clear the cable car's rope the gondola would have to leave its
    station at ~30° (18° allowed), so these are stations side by side."""
    cable = real(
        1,
        "cable_car",
        4000.0,
        [
            S(-195.1, -398.7, -110.8, -103.4, "station", exit=(-187.2, -382.5)),
            S(-49.7, -101.7, -26.8, -1.78, "tower"),
            S(4.2, 8.6, 7.7, 15.18, "station", exit=(-3.7, -7.6)),
        ],
    )
    gondola = real(
        2,
        "gondola",
        1400.0,
        [
            S(-53.9, 13.7, -11.9, 22.01, "tower"),
            S(-14.5, 3.7, 7.1, 21.05, "synthetic-tower"),
            S(36.7, -9.3, 7.7, 12.03, "station", exit=(17.4, -4.4)),
        ],
    )
    stats = separate([cable, gondola], plane(0.255, 0.024))
    assert stats == {"crossings": 0, "lifted": 0, "unresolved": 0, "atStations": 1}
    assert len(gondola["supports"]) == 3


def test_a_crossing_inside_one_hall_is_still_resolved_by_the_other_line():
    """Inside a hall the rope is level, so the other line moves, where it has room."""
    hall = {
        "id": 1,
        "name": "Hall",
        "type": "chair_lift",
        "gauge": 5,
        "catenary": 1100.0,
        "supports": [
            S(0.0, -10.0, 0.0, 2.83, "station", exit=(0.0, 6.0)),
            S(0.0, 150.0, 0.0, 11.0, "tower"),
        ],
    }
    passing = real(
        2,
        "chair_lift",
        1100.0,
        [
            S(-300.0, 0.0, 0.0, 2.83, "station", exit=(-284.0, 0.0)),
            S(-100.0, 0.0, 0.0, 8.0, "tower"),
            S(100.0, 0.0, 0.0, 8.0, "tower"),
            S(300.0, 0.0, 0.0, 2.83, "station", exit=(284.0, 0.0)),
        ],
    )
    stats = separate([hall, passing], flat)
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0, "atStations": 0}
    assert clearance(passing, hall, "chair") >= SEPARATION - 0.05


def test_a_tower_held_by_its_station_leaves_the_other_to_make_up_the_rest():
    """Davos (Totalp over Furka Zipper): the upper line's tower before the crossing is
    the first out of its station, held to the exit angle; the lower line's tower 12 m
    from the crossing is already at minimum height. The new tower beyond the crossing
    takes the rest, no steeper than the rope may leave a station."""
    totalp = real(
        1,
        "chair_lift",
        1100.0,
        [
            S(43.6, 52.6, -5.3, -2.46, "station", exit=(33.4, 40.3)),
            S(6.9, 8.3, -2.8, 8.23, "tower"),
            S(-90.2, -108.9, 23.8, 34.75, "tower"),
            S(-123.5, -149.2, 31.9, 42.86, "tower"),
        ],
    )
    furka = real(
        2,
        "chair_lift",
        1100.0,
        [
            S(185.9, -4.9, -44.9, -33.93, "tower"),
            S(58.4, -1.6, -10.1, 0.91, "tower"),
            S(-11.7, 0.3, -0.3, 10.66, "tower"),
            S(-120.4, 3.2, 10.7, 21.69, "tower"),
        ],
    )
    stats = separate([totalp, furka], plane(-0.095, -0.067))
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0, "atStations": 0}
    assert clearance(totalp, furka, "chair") >= SEPARATION - 0.05
    s = totalp["supports"]
    a, b = s[1], s[2]
    run = math.hypot(b["east"] - a["east"], b["north"] - a["north"])
    assert abs(b["top"] - a["top"]) <= math.tan(math.radians(18)) * run + 0.01
    assert len(s) == 5  # one tower added, not a second beside it


def test_an_existing_tower_makes_up_for_one_held_by_its_station():
    """Grandvalira (TC10 Tarter over TSF4 Pi de Migdia): the gondola's tower beyond the
    crossing is the first out of its station; the chair's tower 2.5 m from the crossing
    comes down only to its minimum. The gondola's tower before the crossing goes up."""
    tarter = real(
        1,
        "gondola",
        1400.0,
        [
            S(44.8, 186.4, -31.3, -5.68, "tower"),
            S(12.3, 51.4, -4.3, 18.8, "tower"),
            S(-4.1, -17.1, 3.8, 13.87, "synthetic-tower"),
            S(-13.8, -57.3, 2.6, 6.91, "station", exit=(-9.1, -37.9)),
        ],
    )
    migdia = real(
        2,
        "chair_lift",
        1100.0,
        [
            S(-18.6, 13.9, -0.6, 10.36, "synthetic-tower"),
            S(-2.0, 1.5, 1.4, 12.4, "tower"),
            S(66.9, -49.7, 17.6, 28.64, "tower"),
            S(141.1, -104.8, 27.9, 43.23, "tower"),
        ],
    )
    stats = separate([tarter, migdia], plane(0.183, -0.123))
    assert stats == {"crossings": 1, "lifted": 1, "unresolved": 0, "atStations": 0}
    assert clearance(tarter, migdia, "gondola") >= SEPARATION - 0.05
    assert len(tarter["supports"]) == 4
    raised = tarter["supports"][1]
    assert raised.get("crossing") and raised["top"] > 2018.8
