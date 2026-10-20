"""Start locations: the ski villages of a resort, found automatically.

A village qualifies if it's a named OSM settlement with lift bottom stations nearby.
Each start point stands on the snow just in front of the village's busiest lift
(clear of buildings), facing it, so you arrive ready to ride.
"""

from __future__ import annotations

import math

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

from .config import Area
from .features import display_name
from .frame import LocalFrame

VILLAGE_RADIUS = 700.0  # lifts this close to a place make it a ski village (m)
MAX_BASES = 16
# The sim lets you board within 35 m of a bottom station.
RING_RADII = (20, 26, 32, 14, 9)
FALLBACK_RADII = (45, 60)
RING_ANGLES = (0, 25, -25, 50, -50, 80, -80, 115, -115)
PLACE_RANK = {"town": 0, "village": 1, "suburb": 2, "hamlet": 3, "neighbourhood": 4}
LIFT_RANK = {"cable_car": 0, "gondola": 1, "mixed_lift": 1, "chair_lift": 2}


def find_bases(
    places: list[dict],
    lifts: list[dict],
    buildings: list[dict],
    frame: LocalFrame,
    extent: Area,
    ground,
) -> list[dict]:
    footprints = [Polygon(b["footprint"]).buffer(2) for b in buildings]
    tree = STRtree(footprints) if footprints else None

    def clear(e: float, n: float) -> bool:
        if tree is None:
            return True
        p = Point(e, n)
        return not any(footprints[int(i)].contains(p) for i in tree.query(p))

    bottoms = [
        (lift, lift["supports"][0], lift["supports"][-1])
        for lift in lifts
        if lift.get("name")
        and lift["type"]
        in ("cable_car", "gondola", "mixed_lift", "chair_lift", "platter", "t-bar", "drag_lift")
    ]
    bases = []
    for place in places:
        name = display_name(place.get("tags", {}))
        kind = place.get("tags", {}).get("place")
        if not name or place.get("type") != "node":
            continue
        e, n = frame.to_local(place["lon"], place["lat"])
        if not extent.contains(e, n):
            continue
        nearby = [
            (lift, b, t)
            for lift, b, t in bottoms
            if math.hypot(b["east"] - e, b["north"] - n) < VILLAGE_RADIUS
        ]
        if not nearby:
            continue
        # The village's main lift: biggest kind of lift, then the nearest.
        lift, b, t = min(
            nearby,
            key=lambda x: (
                LIFT_RANK.get(x[0]["type"], 3),
                math.hypot(x[1]["east"] - e, x[1]["north"] - n),
            ),
        )
        heading = math.atan2(t["east"] - b["east"], t["north"] - b["north"])
        # Stand by the bottom station facing up the lift, within boarding range: behind
        # it first, then round the sides, closest first; only if the station is boxed in
        # by buildings go further out.
        spot = None
        for radius in (*RING_RADII, *FALLBACK_RADII):
            for turn in RING_ANGLES:
                angle = heading + math.pi + math.radians(turn)
                se = b["east"] + math.sin(angle) * radius
                sn = b["north"] + math.cos(angle) * radius
                if extent.contains(se, sn) and clear(se, sn):
                    spot = (se, sn)
                    break
            if spot:
                break
        if spot is None:
            continue
        se, sn = spot
        bases.append(
            {
                "name": name,
                "kind": kind,
                "lift": lift["name"],
                "lifts": len(nearby),
                "east": round(se, 1),
                "north": round(sn, 1),
                "ground": round(float(ground(np.array([se]), np.array([sn]))[0]), 1),
                "heading": round(math.degrees(heading) % 360, 1),
            }
        )
    # Most important first; drop near-duplicates (two place nodes for one village).
    bases.sort(key=lambda x: (PLACE_RANK.get(x["kind"], 5), -x["lifts"]))
    kept: list[dict] = []
    for base in bases:
        if all(
            math.hypot(base["east"] - k["east"], base["north"] - k["north"]) > 250 for k in kept
        ):
            kept.append(base)
    return kept[:MAX_BASES]
