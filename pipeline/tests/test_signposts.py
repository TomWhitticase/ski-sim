"""Signpost placement on synthetic graphs."""

import json

from shapely.geometry import LineString, Point

from ski_sim_pipeline import signposts


def flat(e, n):
    return 0.0


def run(index, lines, name=None, difficulty=2, **extra):
    return {"index": index, "name": name, "difficulty": difficulty, "lines": lines, **extra}


def lift(id_, bottom, top, length=20.0, direction=(0.0, 1.0)):
    def term(end, pos):
        return {
            "end": end,
            "east": pos[0],
            "north": pos[1],
            "dir": list(direction),
            "length": length,
            "width": 8.0,
            "back": 4.0,
        }

    return {
        "id": id_,
        "name": id_,
        "type": "chair",
        "terminals": [term("bottom", bottom), term("top", top)],
    }


def test_y_fork_gets_a_junction_with_two_blades():
    # Run A comes down to the origin; B and C start there, diverging.
    records = [
        run(1, [[(0, 100), (0, 0)]], name="A"),
        run(2, [[(0, 0), (-60, -80)]], name="B"),
        run(3, [[(0, 0), (60, -80)]], name="C"),
    ]
    data = signposts.place(records, [], [], flat)
    junctions = [s for s in data["sites"] if s["kind"] == "junction"]
    assert len(junctions) == 1
    site = junctions[0]
    names = sorted(b["name"] for b in site["blades"])
    assert names == ["B", "C"]
    # Facing south (the approach), west is the skier's right: B (SW) is a right arm, C (SE)
    # a left one (rel is + to the right).
    rels = {b["name"]: b["rel"] for b in site["blades"]}
    assert rels["C"] < 0 < rels["B"]


def test_lift_top_always_gets_its_own_sign():
    runs = [run(1, [[(200, 176), (180, 20)]], name="Down")]
    lifts = [lift("Jandri", bottom=(200, 0), top=(200, 200))]
    data = signposts.place(runs, lifts, [], flat)
    tops = [s for s in data["sites"] if s["kind"] == "lift-top"]
    assert len(tops) == 1
    assert tops[0]["lift"] == "Jandri"


def test_a_merge_is_not_signed():
    # E and F both end at the origin; one run G leaves it: no choice, no sign.
    records = [
        run(1, [[(0, 100), (0, 0)]], name="E"),
        run(2, [[(40, 100), (0, 0)]], name="F"),
        run(3, [[(0, 0), (0, -100)]], name="G"),
    ]
    data = signposts.place(records, [], [], flat)
    assert data["sites"] == []


def test_no_two_signs_are_within_min_spacing():
    # A row of Y-forks; however they fall out, kept signs are never closer than MIN_SPACING.
    records = []
    for i, x in enumerate((0, 45, 90, 135, 400)):
        records += [
            run(3 * i + 1, [[(x, 100), (x, 0)]], name=f"A{i}"),
            run(3 * i + 2, [[(x, 0), (x - 60, -80)]], name=f"B{i}"),
            run(3 * i + 3, [[(x, 0), (x + 60, -80)]], name=f"C{i}"),
        ]
    data = signposts.place(records, [], [], flat)
    posts = [(s["east"], s["north"]) for s in data["sites"]]
    for i, a in enumerate(posts):
        for b in posts[i + 1 :]:
            assert (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 >= (signposts.MIN_SPACING - 0.1) ** 2
    # The well-separated fork at x=400 always survives on its own.
    assert any(abs(e - 400) < signposts.MIN_SPACING for e, _ in posts)


def test_post_keeps_clear_of_centrelines_and_buildings():
    records = [
        run(1, [[(0, 100), (0, 0)]], name="A"),
        run(2, [[(0, 0), (-60, -80)]], name="B"),
        run(3, [[(0, 0), (60, -80)]], name="C"),
    ]
    # A building sitting where the post would naturally land, in the gore.
    obstacle = Point(0, -25).buffer(12)
    data = signposts.place(records, [], [], flat, [obstacle])
    site = data["sites"][0]
    post = Point(site["east"], site["north"])
    assert not obstacle.buffer(signposts.OBSTACLE_MARGIN - 0.01).contains(post)
    # And at least CLEAR off every centreline.
    for r in records:
        for line in r["lines"]:
            for a, b in zip(line[:-1], line[1:], strict=False):
                assert LineString([a, b]).distance(post) >= signposts.CLEAR - 0.5


def test_clearing_shapes_and_manifest_entry():
    records = [
        run(1, [[(0, 100), (0, 0)]], name="A"),
        run(2, [[(0, 0), (-60, -80)]], name="B"),
        run(3, [[(0, 0), (60, -80)]], name="C"),
    ]
    data = signposts.place(records, [], [], flat)
    shapes = signposts.clearing_shapes(data)
    assert len(shapes) == len(data["sites"])
    assert all(s.area > 0 for s in shapes)
    entry = signposts.manifest_entry(data)
    assert entry == {"file": "signposts.json", "count": len(data["sites"]), "synthetic": True}
    # No signs -> no manifest entry (older-build-compatible, no version bump).
    assert signposts.manifest_entry({"sites": []}) is None


def test_placement_is_deterministic():
    records = [
        run(1, [[(0, 100), (0, 0)]], name="A"),
        run(2, [[(0, 0), (-60, -80)]], name="B"),
        run(3, [[(0, 0), (60, -80)]], name="C"),
    ]
    a = signposts.place(records, [], [], flat)
    b = signposts.place(records, [], [], flat)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
