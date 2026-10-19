"""Pistes from OSM: rasterised coverage for rendering, a lookup grid for "which piste am
I on", edge marker poles, floodlights, and teleport destinations.

OSM maps pistes as centrelines (no width tag here, so a per-difficulty default width is
used) and, for many runs, as area polygons with the true extent. Both are combined.
Difficulty follows the OSM convention, which in France maps to the piste colours:
novice = green, easy = blue, intermediate = red, advanced = black.

Besides downhill runs, the other `piste:type`s in RUN_TYPES are kept (snow parks,
sledging, cross-country, kids' areas, touring and walking routes, connections). Segments
on a bridge or in a tunnel are kept apart from the ground lines: they're never graded,
and tunnels are left out of the overlay and lookup (the snow above isn't the run).
"""

from __future__ import annotations

import logging
import math

import numpy as np
from PIL import Image
from rasterio import features as rio_features
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from .config import Extent
from .frame import LocalFrame
from .grid import Grid

log = logging.getLogger(__name__)

# Codes stored in the lookup grid; 0 = no piste.
DIFFICULTY_CODES = {
    "novice": 1,
    "easy": 2,
    "intermediate": 3,
    "advanced": 4,
    "expert": 5,
    "freeride": 6,
}
DIFFICULTY_COLOURS = {  # French piste colours (RGB)
    1: (46, 158, 68),
    2: (28, 110, 220),
    3: (214, 40, 40),
    4: (25, 25, 28),
    5: (25, 25, 28),
    6: (240, 140, 0),
}
DEFAULT_WIDTH = {1: 30.0, 2: 35.0, 3: 30.0, 4: 25.0, 5: 20.0, 6: 20.0}
FREERIDE = DIFFICULTY_CODES["freeride"]

#: `piste:type`s kept, with the code stored in the lookup grid's high nibble.
RUN_TYPES = {
    "downhill": 0,
    "snow_park": 1,
    "sled": 2,
    "nordic": 3,
    "playground": 4,
    "skitour": 5,
    "hike": 6,
    "connection": 7,
}
#: Colours for the other run types (OpenSkiMap-like: parks orange). Connections without
#: a difficulty are grey; with one they take its colour.
TYPE_COLOURS = {
    "snow_park": (255, 110, 0),
    "sled": (140, 70, 190),
    "nordic": (0, 150, 170),
    "playground": (235, 90, 170),
    "skitour": (150, 110, 40),
    "hike": (120, 85, 60),
    "connection": (130, 130, 140),
}
#: Default width (m) of a mapped centreline, for types other than downhill.
TYPE_WIDTH = {
    "snow_park": 30.0,
    "sled": 6.0,
    "nordic": 5.0,
    "playground": 25.0,
    "skitour": 6.0,
    "hike": 4.0,
    "connection": 10.0,
}
#: Routes over unprepared snow: no overlay, markers or grading, and powder physics.
UNGROOMED_TYPES = {"skitour", "hike"}
#: Floodlit runs get masts and a glow; a lit street or footpath (connection, winter
#: walk) is lit by ordinary street lamps, so isn't.
FLOODLIT_TYPES = {"downhill", "snow_park", "sled", "nordic", "playground"}
#: Parks are big areas: a light wash of their colour, not a solid fill.
PARK_TINT = 0.35
MARKER_SPACING = 40.0
RASTER_CELL = 2.0  # rasterise finer than the terrain, then downsample for soft edges
LOOKUP_CELL = 8.0
#: Floodlit runs: masts every LAMP_SPACING m, alternating sides, LAMP_SET_BACK outside
#: the edge. Each lights a pool (Gaussian, POOL_SIGMA m) aimed onto the run (at the
#: centreline, or AIM_IN m inside a lit area) that stops LIT_SPILL beyond its edge.
LAMP_SPACING = 40.0
LAMP_SET_BACK = 3.0
POOL_SIGMA = 15.0
AIM_IN = 15.0
LIT_SPILL = 8.0
LIT_CELL = 4.0


def _name(tags: dict) -> str | None:
    return tags.get("piste:name") or tags.get("name")


def _run_type(tags: dict) -> str | None:
    """The first kept type of a (possibly multi-valued, e.g. `nordic;hike`) piste:type."""
    for value in tags.get("piste:type", "").split(";"):
        if value.strip() in RUN_TYPES:
            return value.strip()
    return None


def _difficulty(tags: dict, run_type: str = "downhill") -> int:
    """Difficulty code. Downhill runs default to easy; other types to 0 (none) unless
    tagged."""
    if run_type == "downhill" and tags.get("piste:grooming") == "backcountry":
        return FREERIDE
    default = DIFFICULTY_CODES["easy"] if run_type == "downhill" else 0
    return DIFFICULTY_CODES.get(tags.get("piste:difficulty", ""), default)


def _structure(tags: dict) -> str | None:
    """ "bridge", "tunnel" or None. A bare `layer` counts: above ground is a bridge,
    below a tunnel."""
    if tags.get("bridge", "no") != "no":
        return "bridge"
    if tags.get("tunnel", "no") != "no":
        return "tunnel"
    try:
        layer = int(tags.get("layer", "0"))
    except ValueError:
        return None
    return "bridge" if layer > 0 else "tunnel" if layer < 0 else None


def _lit(tags: dict) -> bool:
    """Floodlit: `lit` or `piste:lit` set to anything but no (yes, hours, ...)."""
    return any(tags.get(k, "no") not in ("no", "disused") for k in ("lit", "piste:lit"))


def width_of(piste: dict) -> float:
    run_type = piste.get("type", "downhill")
    if run_type == "downhill":
        return DEFAULT_WIDTH[piste["difficulty"]]
    return TYPE_WIDTH[run_type]


def colour_of(piste: dict) -> tuple[int, int, int]:
    run_type = piste.get("type", "downhill")
    if run_type == "downhill" or (run_type == "connection" and piste["difficulty"]):
        return DIFFICULTY_COLOURS[piste["difficulty"]]
    return TYPE_COLOURS[run_type]


def collect(
    elements: list[dict], frame: LocalFrame, extent: Extent
) -> tuple[list[dict], list[tuple]]:
    """Group OSM ways into pistes. Returns (pistes, shapes) where shapes are
    (piste_index, shapely geometry already buffered to width, is_area, centreline|None)
    for everything on the snow surface (tunnels are left out)."""
    pistes: list[dict] = []
    index_of: dict[tuple, int] = {}
    shapes = []
    for el in elements:
        tags = el.get("tags", {})
        run_type = _run_type(tags)
        if el["type"] != "way" or run_type is None:
            continue
        geometry = el.get("geometry", [])
        if len(geometry) < 2:
            continue
        lons = np.array([p["lon"] for p in geometry])
        lats = np.array([p["lat"] for p in geometry])
        east, north = frame.to_local(lons, lats)
        pts = np.column_stack([east, north])
        inside = (
            (pts[:, 0] >= extent.west)
            & (pts[:, 0] <= extent.east)
            & (pts[:, 1] >= extent.south)
            & (pts[:, 1] <= extent.north)
        )
        if not inside.any():
            continue

        name = _name(tags)
        difficulty = _difficulty(tags, run_type)
        # Named runs group across segments; unnamed segments group by difficulty only.
        key = (run_type, name, difficulty)
        if key not in index_of:
            index_of[key] = len(pistes)
            pistes.append(
                {
                    "index": len(pistes) + 1,  # 0 is reserved for "no piste"
                    "name": name,
                    "type": run_type,
                    "difficulty": difficulty,
                    "groomed": difficulty != FREERIDE and run_type not in UNGROOMED_TYPES,
                    "ref": None,
                    "oneway": None,
                    "lines": [],
                    "areas": [],
                    "bridges": [],
                    "tunnels": [],
                    "lit": [],
                }
            )
        piste = pistes[index_of[key]]
        piste["ref"] = piste["ref"] or tags.get("piste:ref") or tags.get("ref")
        oneway = tags.get("piste:oneway", tags.get("oneway"))
        if oneway in ("yes", "no"):
            piste["oneway"] = bool(piste["oneway"]) or oneway == "yes"

        closed = geometry[0] == geometry[-1] and len(geometry) >= 4
        is_area = closed and (tags.get("area") == "yes" or "landuse" in tags)
        if is_area:
            polygon = Polygon(pts[:-1])
            if polygon.is_valid and polygon.area > 1:
                piste["areas"].append(polygon)
                shapes.append((piste["index"], polygon, True, None))
                if _lit(tags) and run_type in FLOODLIT_TYPES:
                    piste["lit"].append(polygon)
        else:
            line = LineString(pts)
            structure = _structure(tags)
            if structure == "tunnel":
                piste["tunnels"].append(line)
                continue
            (piste["bridges"] if structure == "bridge" else piste["lines"]).append(line)
            buffered = line.buffer(width_of(piste) / 2, cap_style="round")
            shapes.append((piste["index"], buffered, False, line))
            if _lit(tags) and run_type in FLOODLIT_TYPES:
                piste["lit"].append(line)
    return pistes, shapes


def rasterise(shapes: list[tuple], grid: Grid, pistes: list[dict] | None = None) -> np.ndarray:
    """Piste index per cell (0 = none). Later shapes win where they overlap: named runs
    beat unnamed connectors, then surveyed areas beat buffered centrelines."""
    named = {p["index"] for p in pistes if p.get("name")} if pistes else set()
    ordered = sorted(shapes, key=lambda s: (s[0] in named, s[2]))
    return rio_features.rasterize(
        [(geom, idx) for idx, geom, _, _ in ordered],
        out_shape=(grid.height, grid.width),
        transform=grid.transform,
        fill=0,
        dtype="uint16",
    )


def _box_average(values: np.ndarray, factor: int) -> np.ndarray:
    """Mean over a (2·factor-1)² window centred on every factor-th sample."""
    pad = factor - 1
    padded = np.pad(values, pad, mode="edge")
    integral = np.pad(padded.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    k = 2 * factor - 1
    window = (integral[k:, k:] - integral[:-k, k:] - integral[k:, :-k] + integral[:-k, :-k]) / (
        k * k
    )
    return window[::factor, ::factor]


def overlay_image(fine: np.ndarray, pistes: list[dict], factor: int) -> Image.Image:
    """RGBA texture on the terrain grid: A = groomed-piste coverage, RGB = piste colour
    premultiplied by coverage (so soft edges fade out instead of toward another hue).
    Freeride itineraries and touring/walking routes are left out: they're not groomed."""
    colours = np.zeros((len(pistes) + 1, 4), dtype=np.float32)
    for p in pistes:
        if p["groomed"]:
            k = PARK_TINT if p.get("type") == "snow_park" else 1.0
            colours[p["index"]] = (*(np.array(colour_of(p)) * k), 255 * k)
    per_cell = colours[fine]  # fine-grid RGBA, A = 255 inside groomed pistes
    channels = [_box_average(per_cell[..., c], factor) for c in range(4)]
    coverage = channels[3] / 255
    rgba = np.dstack([channels[0], channels[1], channels[2], coverage * 255])
    # RGB averaged with zeros outside pistes is already premultiplied by coverage.
    return Image.fromarray(np.clip(np.round(rgba), 0, 255).astype(np.uint8), mode="RGBA")


def lookup_image(fine: np.ndarray, pistes: list[dict], factor: int) -> Image.Image:
    """Coarse RGB lookup grid: R,G = piste index (16-bit, little-endian), B = difficulty
    (low nibble, 0 = none) | RUN_TYPES code << 4 (0 = downhill, so downhill B = difficulty)."""
    ids = fine[::factor, ::factor].astype(np.uint16)
    code = np.zeros(len(pistes) + 1, dtype=np.uint8)
    for p in pistes:
        code[p["index"]] = p["difficulty"] | RUN_TYPES[p.get("type", "downhill")] << 4
    rgb = np.dstack([ids & 0xFF, ids >> 8, code[ids]]).astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB")


def edge_markers(
    shapes: list[tuple], pistes: list[dict], fine: np.ndarray, grid: Grid, ground
) -> list[list]:
    """Poles every MARKER_SPACING m along the outer edge of the groomed downhill area
    (runs and connections), each tagged with the index of the piste it borders."""
    groomed_ids = {
        p["index"]
        for p in pistes
        if p["groomed"] and p.get("type", "downhill") in ("downhill", "connection")
    }
    groomed = [geom for idx, geom, _, _ in shapes if idx in groomed_ids]
    if not groomed:
        return []
    union = unary_union(groomed).simplify(1.0)
    rings = []
    for poly in getattr(union, "geoms", [union]):
        rings.append(poly.exterior)
        rings.extend(poly.interiors)

    points = []
    for ring in rings:
        n = int(ring.length // MARKER_SPACING)
        for i in range(n):
            p = ring.interpolate(i * MARKER_SPACING)
            points.append((p.x, p.y))
    if not points:
        return []
    pts = np.array(points)

    # Colour: the piste index found just inside the edge (search a few fine cells).
    cols = np.round((pts[:, 0] - grid.extent.west) / grid.cell_size).astype(int)
    rows = np.round((grid.extent.north - pts[:, 1]) / grid.cell_size).astype(int)
    found = np.zeros(len(pts), dtype=np.uint16)
    for r in range(4):
        for dr in range(-r, r + 1):
            for dc in range(-r, r + 1):
                rr = np.clip(rows + dr, 0, grid.height - 1)
                cc = np.clip(cols + dc, 0, grid.width - 1)
                v = fine[rr, cc]
                take = (found == 0) & (v > 0)
                found[take] = v[take]
    heights = ground(pts[:, 0], pts[:, 1])
    return [
        [round(float(e), 1), round(float(n), 1), round(float(h), 1), int(i)]
        for (e, n), h, i in zip(pts, heights, found, strict=True)
        if i in groomed_ids
    ]


def summarise(pistes: list[dict], ground) -> list[dict]:
    """JSON-ready piste records with length, a label point and the top of the run."""
    out = []
    for p in pistes:
        lines = p["lines"] + p.get("bridges", [])
        tunnels = p.get("tunnels", [])
        geoms = lines + [a.exterior for a in p["areas"]] + tunnels
        coords = np.vstack([np.asarray(g.coords) for g in geoms])
        heights = ground(coords[:, 0], coords[:, 1])
        top = int(np.argmax(heights))
        te, tn = coords[top]
        heading = _start_heading(lines, (te, tn), ground)
        if heading is None:  # area-only run: follow the fall line
            be, bn = coords[int(np.argmin(heights))]
            heading = (math.degrees(math.atan2(be - te, bn - tn)) + 360) % 360
        if lines:
            label = max(lines, key=lambda line: line.length).interpolate(0.5, normalized=True)
        elif p["areas"]:
            label = p["areas"][0].representative_point()
        else:
            label = tunnels[0].interpolate(0.5, normalized=True)
        out.append(
            {
                "index": p["index"],
                "name": p["name"],
                "type": p.get("type", "downhill"),
                "difficulty": p["difficulty"],
                "groomed": p["groomed"],
                "ref": p.get("ref"),
                "oneway": p.get("oneway"),
                "lit": bool(p.get("lit")),
                "length": round(sum(line.length for line in lines + tunnels), 1),
                "top": {
                    "east": round(float(te), 1),
                    "north": round(float(tn), 1),
                    "ground": round(float(heights[top]), 1),
                    "heading": round(heading, 1),
                },
                "vertical": round(float(heights[top] - heights.min()), 1),
                "label": {"east": round(label.x, 1), "north": round(label.y, 1)},
                "lines": [np.round(np.asarray(line.coords), 1).tolist() for line in lines],
                "areas": [np.round(np.asarray(a.exterior.coords), 1).tolist() for a in p["areas"]],
                "tunnels": [np.round(np.asarray(t.coords), 1).tolist() for t in tunnels],
            }
        )
    return out


START_LOOKAHEAD = 60.0  # metres down the run used to aim a skier starting at the top


def _start_heading(lines: list[LineString], top: tuple[float, float], ground) -> float | None:
    """Compass heading from the top of a run toward a point a little way down it, along
    whichever centreline starts there. None if no centreline touches the top."""
    best = None
    start = Point(top)
    for line in lines:
        if line.distance(start) > 1:
            continue
        d = line.project(start)
        for along in (d + START_LOOKAHEAD, d - START_LOOKAHEAD):
            p = line.interpolate(min(max(along, 0), line.length))
            h = float(ground(np.array([p.x]), np.array([p.y]))[0])
            if best is None or h < best[0]:
                best = (h, p.x, p.y)
    if best is None:
        return None
    _, x, y = best
    return (math.degrees(math.atan2(x - top[0], y - top[1])) + 360) % 360


def floodlights(pistes: list[dict], ground) -> list[list[float]]:
    """Mast positions [east, north, ground] along floodlit runs: alternating sides of lit
    centrelines, and round the outline of lit areas."""
    points: list[tuple[float, float]] = []
    for p in pistes:
        half = width_of(p) / 2 + LAMP_SET_BACK
        for geom in p.get("lit", []):
            if isinstance(geom, Polygon):
                ring = geom.buffer(LAMP_SET_BACK).exterior
                n = max(int(ring.length // LAMP_SPACING), 3)
                points.extend(ring.interpolate(i * ring.length / n).coords[0] for i in range(n))
                continue
            n = max(int(geom.length // LAMP_SPACING), 1)
            for i in range(n):
                d = (i + 0.5) * geom.length / n
                a = np.asarray(geom.interpolate(max(d - 1, 0)).coords[0])
                b = np.asarray(geom.interpolate(min(d + 1, geom.length)).coords[0])
                t = (b - a) / max(float(np.linalg.norm(b - a)), 1e-9)
                side = 1 if i % 2 == 0 else -1
                c = np.asarray(geom.interpolate(d).coords[0])
                points.append((c[0] - t[1] * half * side, c[1] + t[0] * half * side))
    if not points:
        return []
    pts = np.array(points)
    heights = ground(pts[:, 0], pts[:, 1])
    return [
        [round(float(e), 1), round(float(n), 1), round(float(h), 1)]
        for (e, n), h in zip(pts, heights, strict=True)
    ]


def _aim_points(pistes: list[dict], masts: np.ndarray) -> np.ndarray:
    """Where each mast's light lands: the nearest point of a lit centreline, or of a lit
    area shrunk by AIM_IN."""
    from shapely.ops import nearest_points

    targets = []
    for geom in (g for p in pistes for g in p.get("lit", [])):
        if isinstance(geom, Polygon):
            inner = geom.buffer(-AIM_IN)
            targets.append(inner if not inner.is_empty else geom.centroid)
        else:
            targets.append(geom)
    lit = unary_union(targets)
    return np.array([nearest_points(lit, Point(e, n))[0].coords[0] for e, n in masts])


def _blur(values: np.ndarray, radius: int) -> np.ndarray:
    """Separable box blur (edge-padded)."""
    out = values
    for axis in (0, 1):
        padded = np.pad(out, [(radius, radius) if a == axis else (0, 0) for a in (0, 1)], "edge")
        c = np.cumsum(padded, axis=axis, dtype=np.float64)
        c = np.insert(c, 0, 0, axis=axis)
        k = 2 * radius + 1
        n = out.shape[axis]
        out = (np.take(c, range(k, k + n), axis=axis) - np.take(c, range(n), axis=axis)) / k
    return out


def lit_mask(pistes: list[dict], lamps: list[list[float]]) -> tuple[Image.Image, Extent] | None:
    """Night glow on floodlit runs (L, 0..255) on its own LIT_CELL grid covering the lamps:
    pools of light round each mast, kept to the run plus a little spill."""
    if not lamps:
        return None
    pts = np.array([lamp[:2] for lamp in lamps])
    targets = _aim_points(pistes, pts)
    margin = 4 * POOL_SIGMA
    extent = Extent(
        math.floor((pts[:, 0].min() - margin) / LIT_CELL) * LIT_CELL,
        math.ceil((pts[:, 0].max() + margin) / LIT_CELL) * LIT_CELL,
        math.floor((pts[:, 1].min() - margin) / LIT_CELL) * LIT_CELL,
        math.ceil((pts[:, 1].max() + margin) / LIT_CELL) * LIT_CELL,
    )
    grid = Grid(extent, LIT_CELL)
    shapes = [
        geom.buffer(LIT_SPILL)
        if isinstance(geom, Polygon)
        else geom.buffer(width_of(p) / 2 + LIT_SPILL)
        for p in pistes
        for geom in p.get("lit", [])
    ]
    run = rio_features.rasterize(
        [(g, 1) for g in shapes],
        out_shape=(grid.height, grid.width),
        transform=grid.transform,
        fill=0,
        dtype="uint8",
    ).astype(np.float64)
    run = _blur(run, 2)
    pool = np.zeros_like(run)
    east, north = grid.coords()
    reach = int(math.ceil(3 * POOL_SIGMA / LIT_CELL))
    for e, n in targets:
        col = round((e - extent.west) / LIT_CELL)
        row = round((extent.north - n) / LIT_CELL)
        r0, r1 = max(row - reach, 0), min(row + reach + 1, grid.height)
        c0, c1 = max(col - reach, 0), min(col + reach + 1, grid.width)
        de = east[0, c0:c1] - e
        dn = north[r0:r1, 0] - n
        d2 = dn[:, None] ** 2 + de[None, :] ** 2
        pool[r0:r1, c0:c1] += np.exp(-d2 / (2 * POOL_SIGMA**2))
    glow = np.clip(pool, 0, 1) * run
    image = Image.fromarray(np.round(glow * 255).astype(np.uint8), mode="L")
    return image, extent
