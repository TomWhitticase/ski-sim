"""Signpost placement: where on-mountain signs go and what they say.

Called from `build.py` after the pistes and lifts as
`signposts.place(piste_records, lifts, places, ground, obstacles)`, it writes `signposts.json`
(and an optional `manifest.signposts` entry) beside the resort's other files. The sim draws
the signs from it (`sim/src/signposts/`); absent (older builds), the sim shows none.

Model
-----
Every piste centreline is densified (5 m) and oriented downhill. "Events" are where skiers
arrive (a line ends, a lift unloads) and where they can leave (a line starts, a lift loads,
or another run carries on past a point where a run branches off it). Events within
CLUSTER m are one node. A node where skiers can leave by two or more distinct ways (runs or
lifts) is a decision point and gets a sign; a lift top always gets one. Each way out becomes
one blade: run number/name/colour, an arrow relative to the direction skiers arrive from, and
where it leads (the lift or village at its bottom).

The post is kept out of the skiing line (CLEAR m off every centreline) and off buildings and
lift terminals (`obstacles`). Its spot also clears a small circle of trees (`clearing_shapes`).

Standalone, to regenerate a built resort's signs without a full rebuild (reads its processed
files, builds obstacles from features.json):

    uv run python -m ski_sim_pipeline.signposts data/processed/<id> [--max-sites N]
"""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

VERSION = 1
STEP = 5.0  # densify spacing (m)
CLUSTER = 35.0  # events closer than this are one node (m)
TOUCH = 14.0  # a run's start this close to another run's line branches off it (m)
LIFT_REACH = 70.0  # a run starting/ending this close to a lift end serves it (m)
MIN_SPACING = 60.0  # no two signs closer than this (m)
CLEAR = 9.0  # post at least this far from any run centreline (m)
OBSTACLE_MARGIN = 1.5  # and this far outside any building or terminal (m)
CLEAR_TREES = 4.0  # trees cut from this radius round each post (m)
AIM = 45.0  # direction of a way out: bearing to the point this far along it (m)
SIGNED_TYPES = {"downhill", "connection", "snow_park", "sled"}


class Ground:
    """A bilinear sampler of the near heightmap, for the standalone CLI."""

    def __init__(self, resort: Path, manifest: dict):
        n = manifest["terrain"]["near"]
        raw = np.fromfile(resort / n["file"], dtype="<u2").reshape(n["height"], n["width"])
        self.h = n["heightOffset"] + raw.astype(np.float32) * n["heightScale"]
        self.cell = n["cellSize"]
        self.west = n["extent"]["west"]
        self.north = n["extent"]["north"]

    def __call__(self, e: float, nn: float) -> float:
        c = (e - self.west) / self.cell
        r = (self.north - nn) / self.cell
        c0, r0 = int(math.floor(c)), int(math.floor(r))
        c0 = min(max(c0, 0), self.h.shape[1] - 2)
        r0 = min(max(r0, 0), self.h.shape[0] - 2)
        fc, fr = min(max(c - c0, 0), 1), min(max(r - r0, 0), 1)
        h = self.h
        top = h[r0, c0] * (1 - fc) + h[r0, c0 + 1] * fc
        bot = h[r0 + 1, c0] * (1 - fc) + h[r0 + 1, c0 + 1] * fc
        return float(top * (1 - fr) + bot * fr)


def densify(line: Sequence) -> np.ndarray:
    pts = np.asarray(line, dtype=float)
    out = [pts[0]]
    for a, b in zip(pts[:-1], pts[1:], strict=False):
        d = float(np.hypot(*(b - a)))
        k = max(1, int(d // STEP))
        for i in range(1, k + 1):
            out.append(a + (b - a) * i / k)
    return np.asarray(out)


def bearing(a, b) -> float:
    return (math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360


def angdiff(a: float, b: float) -> float:
    """b - a wrapped to (-180, 180]: negative = left, positive = right."""
    return (b - a + 540) % 360 - 180


def mean_bearing(bs: list[float]) -> float:
    x = sum(math.sin(math.radians(b)) for b in bs)
    y = sum(math.cos(math.radians(b)) for b in bs)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def along(pts: np.ndarray, i: int, dist: float) -> np.ndarray:
    """Point `dist` metres further down the polyline from sample i (clamped at its end)."""
    j = min(len(pts) - 1, i + max(1, int(dist / STEP)))
    return pts[j]


def _obstacle_index(obstacles: Iterable) -> STRtree | None:
    geoms = [g for g in obstacles if g is not None and not g.is_empty]
    return STRtree(geoms) if geoms else None


def place(
    records: list[dict],
    lifts: list[dict],
    places: list[dict],
    ground: Callable[[float, float], float],
    obstacles: Iterable = (),
    max_sites: int | None = None,
) -> dict:
    """Place signs from a resort's piste records, lifts and places.

    `records` are `pistes.summarise` run records (with `lines`, `index`, `name`, `ref`,
    `difficulty`, `type`, `oneway`); `lifts` are `features` lifts (with `terminals`); `places`
    are `map_places` dicts (`name`, `east`, `north`); `ground(e, n)` is the snow height;
    `obstacles` are shapely footprints (buildings, terminal pads) the post must avoid.
    """
    tree = _obstacle_index(obstacles)

    # --- oriented, densified lines -------------------------------------------------
    lines = []  # (record, pts)
    for p in records:
        if p.get("type", "downhill") not in SIGNED_TYPES:
            continue
        for ln in p["lines"]:
            pts = densify(ln)
            if len(pts) < 3:
                continue
            h0, h1 = ground(*pts[0]), ground(*pts[-1])
            if p.get("oneway") is not True and h1 > h0 + 2:  # drawn uphill: flip
                pts = pts[::-1]
            lines.append((p, pts))

    # spatial hash of samples
    grid: dict[tuple, list] = defaultdict(list)
    for li, (_, pts) in enumerate(lines):
        for si, pt in enumerate(pts):
            grid[(int(pt[0] // 30), int(pt[1] // 30))].append((li, si))

    def near_samples(pt, r):
        cx, cy = int(pt[0] // 30), int(pt[1] // 30)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for li, si in grid.get((cx + dx, cy + dy), ()):
                    q = lines[li][1][si]
                    if (q[0] - pt[0]) ** 2 + (q[1] - pt[1]) ** 2 <= r * r:
                        yield li, si

    # --- lift ends ---------------------------------------------------------------------
    lift_ends = []  # dicts: kind top/bottom, pos (where skiers are), travel bearing
    for lift in lifts:
        terms = {t["end"]: t for t in lift.get("terminals", [])}
        if "top" not in terms or "bottom" not in terms:
            continue
        top, bot = terms["top"], terms["bottom"]
        up = bearing((bot["east"], bot["north"]), (top["east"], top["north"]))
        # Riders leave the top in the direction of travel (ramp/side door), ~14 m on.
        d = np.array(top["dir"])
        exit_pt = np.array([top["east"], top["north"]]) - d * (top["length"] / 2 + 14)
        entry_pt = np.array([bot["east"], bot["north"]]) - np.array(bot["dir"]) * (
            bot["length"] / 2 + 8
        )
        lift_ends.append({"lift": lift, "end": "top", "pos": exit_pt, "travel": up})
        lift_ends.append({"lift": lift, "end": "bottom", "pos": entry_pt, "travel": up})

    # --- where each run leads (lift or village at its bottom) ---------------------------
    def destination(p) -> str | None:
        ends = [densify(ln) for ln in p["lines"]]
        if not ends:
            return None
        pts = np.vstack(ends)
        hs = np.array([ground(*q) for q in pts[:: max(1, len(pts) // 200)]])
        low = pts[:: max(1, len(pts) // 200)][int(np.argmin(hs))]
        best = None
        for le in lift_ends:
            if le["end"] != "bottom":
                continue
            d = float(np.hypot(*(le["pos"] - low)))
            if d < 150 and (best is None or d < best[0]):
                best = (d, le["lift"]["name"])
        if best:
            return best[1]
        for pl in places:
            d = math.hypot(pl["east"] - low[0], pl["north"] - low[1])
            if d < 500 and (best is None or d < best[0]):
                best = (d, pl["name"])
        return best[1] if best else None

    dest_cache: dict = {}

    def clearance(pt) -> float:
        best = 99.0
        for li, si in near_samples(pt, 30):
            q = lines[li][1][si]
            best = min(best, float(np.hypot(q[0] - pt[0], q[1] - pt[1])))
        return best

    def blocked(pt) -> bool:
        if tree is None:
            return False
        p = Point(float(pt[0]), float(pt[1]))
        for g in tree.geometries.take(tree.query(p.buffer(OBSTACLE_MARGIN))):
            if g.distance(p) < OBSTACLE_MARGIN:
                return True
        return False

    def ok(pt) -> bool:
        return clearance(pt) >= CLEAR and not blocked(pt)

    # --- events ------------------------------------------------------------------------
    events = []  # (pos, kind, payload)
    for li, (p, pts) in enumerate(lines):
        events.append((pts[0], "start", (li, 0)))
        events.append((pts[-1], "end", (li, len(pts) - 1)))
        # Branch-off: this run starts on another run's line mid-way.
        for lj, sj in near_samples(pts[0], TOUCH):
            q, qpts = lines[lj]
            if q["index"] == p["index"] or sj < 2 or sj > len(qpts) - 4:
                continue
            events.append((qpts[sj], "through", (lj, sj)))
    for le in lift_ends:
        events.append((le["pos"], "lift-" + le["end"], le))

    # --- cluster (greedy, by priority: lift tops first so they anchor their node) -------
    order = sorted(range(len(events)), key=lambda i: 0 if events[i][1] == "lift-top" else 1)
    nodes = []  # each: {"pos": mean, "events": [...]}
    for i in order:
        pos, kind, payload = events[i]
        best = None
        for n in nodes:
            d = float(np.hypot(*(n["pos"] - pos)))
            if d < CLUSTER and (best is None or d < best[0]):
                best = (d, n)
        if best:
            n = best[1]
            n["events"].append((pos, kind, payload))
            if not n["anchor"]:
                n["pos"] = np.mean([e[0] for e in n["events"]], axis=0)
        else:
            nodes.append(
                {
                    "pos": np.array(pos, float),
                    "events": [(pos, kind, payload)],
                    "anchor": kind == "lift-top",
                }
            )

    # --- decision points ------------------------------------------------------------------
    sites = []
    for n in nodes:
        outs = {}  # key -> option
        arrive = []  # bearings of arrival
        lift_top = None
        for _pos, kind, payload in n["events"]:
            if kind in ("start", "through"):
                li, si = payload
                p, pts = lines[li]
                aim = along(pts, si, AIM)
                key = ("piste", p["index"])
                b = bearing(pts[si], aim)
                if kind == "through" and si > 0:
                    arrive.append(bearing(pts[max(0, si - 4)], pts[si]))
                if key not in outs:
                    outs[key] = {"kind": "piste", "piste": p, "bearing": b, "pos": pts[si]}
            elif kind == "end":
                li, si = payload
                p, pts = lines[li]
                arrive.append(bearing(pts[max(0, si - 4)], pts[si]))
            elif kind == "lift-bottom":
                lift = payload["lift"]
                key = ("lift", lift["id"])
                outs[key] = {"kind": "lift", "lift": lift, "bearing": None, "pos": payload["pos"]}
            elif kind == "lift-top":
                lift_top = payload
                arrive.append(payload["travel"])
        # A run that both ends and starts here under the same piste is a continuation: fine.
        if len(outs) < 2 and not lift_top:
            continue
        if not outs:
            continue
        centre = n["pos"]
        for o in outs.values():
            if o["bearing"] is None:
                o["bearing"] = (
                    bearing(centre, o["pos"]) if np.hypot(*(o["pos"] - centre)) > 3 else None
                )
        if lift_top:  # people arrive off the lift: the board faces them
            arrive = [lift_top["travel"]]
        approach = (
            mean_bearing(arrive)
            if arrive
            else mean_bearing(
                [o["bearing"] for o in outs.values() if o["bearing"] is not None] or [0]
            )
        )
        blades = []
        for o in outs.values():
            rel = angdiff(approach, o["bearing"]) if o["bearing"] is not None else 0.0
            if o["kind"] == "piste":
                p = o["piste"]
                if p["index"] not in dest_cache:
                    dest_cache[p["index"]] = destination(p)
                blades.append(
                    {
                        "kind": "piste",
                        "piste": p["index"],
                        "name": p["name"],
                        "ref": p.get("ref"),
                        "difficulty": p["difficulty"],
                        "type": p.get("type", "downhill"),
                        "rel": round(rel),
                        "to": dest_cache[p["index"]],
                    }
                )
            else:
                lift = o["lift"]
                blades.append(
                    {
                        "kind": "lift",
                        "lift": lift["id"],
                        "name": lift["name"],
                        "liftType": lift["type"],
                        "rel": round(rel),
                    }
                )
        # Order like a real board: left to right, then easiest first.
        blades.sort(key=lambda b: (b["rel"], b.get("difficulty", 0)))
        kind = (
            "lift-top"
            if lift_top
            else ("lift-bottom" if any(b["kind"] == "lift" for b in blades) else "junction")
        )

        # Post position. Fork with clear divergence: in the gore between the two outermost
        # ways, far enough down that it's 6 m+ off both. Otherwise at the edge, just before.
        piste_rels = [b["rel"] for b in blades if b["kind"] == "piste"]
        widest = max(piste_rels) - min(piste_rels) if len(piste_rels) >= 2 else 0
        if lift_top:
            # Beside the ski-off, a little down, to the side away from the line.
            tb = lift_top["travel"]
            fwd = np.array([math.sin(math.radians(tb)), math.cos(math.radians(tb))])
            side = np.array([fwd[1], -fwd[0]])
            post = lift_top["pos"] + fwd * 6 + side * 9
            facing = (tb + 180) % 360
        elif widest >= 40:
            mid_rel = (max(piste_rels) + min(piste_rels)) / 2
            gb = (approach + mid_rel) % 360
            half = math.radians(min(widest, 150) / 2)
            dist = min(40.0, 7.0 / math.sin(half))
            post = centre + dist * np.array(
                [math.sin(math.radians(gb)), math.cos(math.radians(gb))]
            )
            facing = (approach + 180) % 360
        else:
            fwd = np.array([math.sin(math.radians(approach)), math.cos(math.radians(approach))])
            right = np.array([fwd[1], -fwd[0]])
            side = 1 if (piste_rels and np.mean(piste_rels) > 0) else -1
            post = centre - fwd * 15 + right * side * 14
            facing = (approach + 180) % 360
        # Keep the post clear of the skiing line and of buildings/terminals, searching rings
        # round the node for the nearest spot that is.
        moved = False
        if not ok(post):
            best = None
            for r in (10, 14, 18, 24, 30, 38):
                for k in range(24):
                    a = math.radians(k * 15)
                    c = centre + r * np.array([math.sin(a), math.cos(a)])
                    if not ok(c):
                        continue
                    cost = float(np.hypot(*(c - post)))
                    if best is None or cost < best[0]:
                        best = (cost, c)
                if best:
                    break
            if best:
                post = best[1]
                moved = True
        sites.append(
            {
                "moved": moved,
                "kind": kind,
                "east": round(float(post[0]), 1),
                "north": round(float(post[1]), 1),
                "ground": round(ground(*post), 2),
                "facing": round(facing, 1),
                "approach": round(approach, 1),
                "node": [round(float(centre[0]), 1), round(float(centre[1]), 1)],
                "lift": lift_top["lift"]["name"] if lift_top else None,
                "blades": blades,
            }
        )

    # --- density: lift tops win, then nodes with more choices -------------------------
    rank = {"lift-top": 0, "junction": 1, "lift-bottom": 2}
    sites.sort(key=lambda s: (rank[s["kind"]], -len(s["blades"])))
    kept = []
    for s in sites:
        if any(
            math.hypot(s["east"] - k["east"], s["north"] - k["north"]) < MIN_SPACING for k in kept
        ):
            continue
        kept.append(s)
    if max_sites:
        kept = kept[:max_sites]
    kept.sort(key=lambda s: (s["east"], s["north"]))  # stable order independent of input order
    for i, s in enumerate(kept):
        s["id"] = i
    stats = {
        "nodes": len(nodes),
        "candidates": len(sites),
        "kept": len(kept),
        "byKind": {k: sum(1 for s in kept if s["kind"] == k) for k in rank},
        "blades": sum(len(s["blades"]) for s in kept),
        "moved": sum(1 for s in kept if s["moved"]),
    }
    return {
        "version": VERSION,
        "synthetic": True,
        "basis": "piste graph (OSM piste ways), lift terminals, places; geometry algorithm",
        "stats": stats,
        "sites": kept,
    }


def clearing_shapes(data: dict) -> list:
    """Where trees must not stand: a small circle round each post (for `landcover`)."""
    return [Point(s["east"], s["north"]).buffer(CLEAR_TREES) for s in data["sites"]]


def manifest_entry(data: dict) -> dict | None:
    """The `manifest.signposts` entry, or None when there are no signs (no version bump)."""
    if not data["sites"]:
        return None
    return {"file": "signposts.json", "count": len(data["sites"]), "synthetic": True}


def building_obstacles(buildings: list[dict]) -> list:
    """Footprints of buildings as shapely polygons, for the post clearance search."""
    out = []
    for b in buildings:
        fp = b.get("footprint")
        if fp and len(fp) >= 3:
            poly = Polygon(fp)
            if poly.is_valid and not poly.is_empty:
                out.append(poly)
    return out


def _place_from_dir(resort: Path, max_sites: int | None = None) -> dict:
    manifest = json.loads((resort / "manifest.json").read_text())
    ground = Ground(resort, manifest)
    records = json.loads((resort / "pistes.json").read_text())["pistes"]
    features = json.loads((resort / "features.json").read_text())
    lifts = features["lifts"]
    places = features.get("places", [])
    obstacles = building_obstacles(features.get("buildings", []))
    for lift in lifts:
        for t in lift.get("terminals", []):
            obstacles.append(
                Point(t["east"], t["north"]).buffer(
                    (t["length"] + t.get("back", 0) + t["width"]) / 2
                )
            )
    return place(records, lifts, places, ground, obstacles, max_sites)


if __name__ == "__main__":
    args = sys.argv[1:]
    max_sites = None
    if "--max-sites" in args:
        i = args.index("--max-sites")
        max_sites = int(args[i + 1])
        args = args[:i] + args[i + 2 :]
    resort = Path(args[0])
    out = _place_from_dir(resort, max_sites)
    (resort / "signposts.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    )
    print(json.dumps(out["stats"]))
