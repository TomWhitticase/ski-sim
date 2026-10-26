"""Renders the minimap: winter-tinted hillshade, contour lines, buildings and lifts."""

from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import LineString

SNOW = np.array([246, 249, 252], dtype=np.float32)
SNOW_SHADOW = np.array([150, 170, 200], dtype=np.float32)
ROCK = np.array([118, 112, 108], dtype=np.float32)
CONTOUR = np.array([90, 110, 140], dtype=np.float32)


def downsample(heights: np.ndarray, factor: int) -> np.ndarray:
    """Block-mean downsample by an integer factor (edges cropped to a whole block)."""
    if factor == 1:
        return heights
    h = heights.shape[0] // factor * factor
    w = heights.shape[1] // factor * factor
    return heights[:h, :w].reshape(h // factor, factor, w // factor, factor).mean(axis=(1, 3))


def render(
    heights: np.ndarray, cell_size: float, contour_interval: float, sun_azimuth: float = 315
) -> Image.Image:
    """`heights` is north-up (row 0 = north). Returns an RGB image of the same shape."""
    # np.gradient along rows runs southward, so negate for d/dnorth.
    d_north, d_east = np.gradient(heights, cell_size)
    d_north = -d_north
    slope = np.arctan(np.hypot(d_east, d_north))
    aspect = np.arctan2(-d_east, -d_north)  # downslope direction, clockwise from north

    az = np.radians(sun_azimuth)
    alt = np.radians(40)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    shade = np.clip(shade, 0, 1)[..., np.newaxis]

    color = SNOW_SHADOW + (SNOW - SNOW_SHADOW) * shade
    rock = np.clip((np.degrees(slope) - 38) / 10, 0, 1)[..., np.newaxis]
    color = color * (1 - rock) + ROCK * (0.55 + 0.45 * shade) * rock

    band = np.floor(heights / contour_interval)
    edge = np.zeros(heights.shape, dtype=bool)
    edge[:-1, :] |= band[:-1, :] != band[1:, :]
    edge[:, :-1] |= band[:, :-1] != band[:, 1:]
    major = np.floor(heights / (contour_interval * 5))
    major_edge = np.zeros(heights.shape, dtype=bool)
    major_edge[:-1, :] |= major[:-1, :] != major[1:, :]
    major_edge[:, :-1] |= major[:, :-1] != major[:, 1:]
    strength = np.where(major_edge, 0.75, np.where(edge, 0.35, 0.0))[..., np.newaxis]
    color = color * (1 - strength) + CONTOUR * strength

    return Image.fromarray(np.clip(color, 0, 255).astype(np.uint8), mode="RGB")


FOREST = np.array([62, 104, 78], dtype=np.float32)


def shade_forest(image: Image.Image, cover, west: float, north: float, cell_size: float) -> None:
    """Tint forest green by tree cover. `cover(east, north)` samples it (0-1) at arrays of
    pixel centres; (west, north) is the image's top-left."""
    rgb = np.asarray(image, dtype=np.float32)
    h, w = rgb.shape[:2]
    east = west + (np.arange(w) + 0.5) * cell_size
    nrth = north - (np.arange(h) + 0.5) * cell_size
    e, n = np.meshgrid(east, nrth)
    k = 0.6 * np.clip(cover(e, n), 0, 1)[..., np.newaxis]
    image.paste(Image.fromarray(np.round(rgb * (1 - k) + FOREST * k).astype(np.uint8), "RGB"))


BUILDING = (112, 104, 100)
LIFT = (35, 35, 40)


def draw_features(
    image: Image.Image, features: dict, west: float, north: float, cell_size: float
) -> None:
    """Overlay building footprints and lift lines. (west, north) is the image's top-left."""
    draw = ImageDraw.Draw(image)

    def px(east: float, n: float) -> tuple[float, float]:
        return (east - west) / cell_size, (north - n) / cell_size

    for building in features["buildings"]:
        draw.polygon([px(e, n) for e, n in building["footprint"]], fill=BUILDING)
    draw_airfields(draw, features.get("airfields"), px)
    for lift in features["lifts"]:
        points = [px(s["east"], s["north"]) for s in lift["supports"]]
        draw.line(points, fill=LIFT, width=2)
        for x, y in (points[0], points[-1]):
            draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=LIFT)


#: Airfield surfaces on the map: paved (cleared) dark grey, snow surfaces pale grey-blue,
#: helipads as a ring (the sim's world map draws the same, `ui/world-map.ts`).
PAVED = (78, 80, 86)
SNOW_SURFACE = (178, 186, 198)
HELIPAD = (40, 42, 48)


def draw_airfields(draw: ImageDraw.ImageDraw, fields: dict | None, px) -> None:
    if not fields:
        return

    def colour(item: dict) -> tuple[int, int, int]:
        return PAVED if item["winter"] == "cleared" else SNOW_SURFACE

    for apron in fields["aprons"]:
        draw.polygon([px(e, n) for e, n in apron["ring"]], fill=colour(apron))
    for strip in (*fields["taxiways"], *fields["runways"]):
        line = LineString(strip["line"])
        shape = line.buffer(strip["width"] / 2, cap_style="flat")
        for poly in getattr(shape, "geoms", [shape]):
            draw.polygon([px(e, n) for e, n in poly.exterior.coords], fill=colour(strip))
    for pad in fields["helipads"]:
        x, y = px(pad["east"], pad["north"])
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), outline=HELIPAD, width=1)


#: Roads on the map, under the runs (the sim's world map draws the same, `ui/roads-map.ts`):
#: a casing and a fill, yellow for main roads, white for the rest; snow-covered roads and
#: tracks a thin dashed line; tunnels dashed grey.
ROAD_CASING = (128, 118, 108)
ROAD_MAIN = (247, 215, 118)
ROAD_MINOR = (255, 255, 255)
ROAD_SNOW = (138, 124, 110)
ROAD_TUNNEL = (120, 120, 120)
#: Fill widths (px) by map rank (0 motorways .. 6 tracks).
ROAD_PX = (4, 3, 3, 2, 2, 1, 1)


def draw_roads(
    image: Image.Image, record: dict | None, west: float, north: float, cell_size: float
) -> None:
    """Roads (features.json `roads`) at the minimap's scale: snow roads and tunnels
    dashed, cleared roads cased, minor ones first so main roads cross over them."""
    if not record:
        return
    from .roads import CLASSES

    draw = ImageDraw.Draw(image)

    def px(points: list) -> list[tuple[float, float]]:
        return [((e - west) / cell_size, (north - n) / cell_size) for e, n in points]

    cleared = []
    for r in record["roads"]:
        points = px(r["line"])
        rank = CLASSES[r["class"]][0]
        if r["structure"] == "tunnel":
            for dash in dashes(points, 4, 3):
                draw.line(dash, fill=ROAD_TUNNEL, width=1)
        elif r["winter"] != "cleared":
            for dash in dashes(points, 4, 3):
                draw.line(dash, fill=ROAD_SNOW, width=1)
        else:
            cleared.append((rank, r, points))
    cleared.sort(key=lambda c: -c[0])
    for rank, _, points in cleared:
        if ROAD_PX[rank] > 1:
            draw.line(points, fill=ROAD_CASING, width=ROAD_PX[rank] + 2, joint="curve")
    for rank, _, points in cleared:
        colour = ROAD_MAIN if rank <= 2 else ROAD_MINOR if ROAD_PX[rank] > 1 else ROAD_CASING
        draw.line(points, fill=colour, width=ROAD_PX[rank], joint="curve")


#: Dashed routes on the map: pixels drawn, then pixels skipped, measured along the line.
DASH_ON = 7.0
DASH_OFF = 5.0


def dashes(points: list[tuple[float, float]], on: float, off: float) -> list[list]:
    """Even dashes along a polyline: `on` px drawn then `off` px skipped, measured along
    its length and carried round its bends, whatever the spacing of its vertices."""
    out: list[list] = []
    current: list = []
    drawing, left = True, on
    for (x0, y0), (x1, y1) in zip(points, points[1:], strict=False):
        seg = math.hypot(x1 - x0, y1 - y0)
        at = 0.0
        while seg - at > 1e-9:
            step = min(left, seg - at)
            t0, t1 = at / seg, (at + step) / seg
            if drawing:
                if not current:
                    current.append((x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0))
                current.append((x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1))
            at += step
            left -= step
            if left <= 1e-9:
                if drawing and current:
                    out.append(current)
                current = []
                drawing = not drawing
                left = on if drawing else off
    if drawing and len(current) > 1:
        out.append(current)
    return out


def draw_pistes(
    image: Image.Image, records: list[dict], west: float, north: float, cell_size: float
) -> None:
    """Translucent piste areas and centrelines in piste colours (drawn under lifts).
    Other run types get their own colour and line: parks as orange areas, thin
    cross-country tracks, dashed touring/walking routes and tunnels."""
    from .pistes import FREERIDE, colour_of

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def px(points: list) -> list[tuple[float, float]]:
        return [((e - west) / cell_size, (north - n) / cell_size) for e, n in points]

    def dashed(points, colour, width):
        for dash in dashes(points, DASH_ON, DASH_OFF):
            draw.line(dash, fill=colour, width=width)

    for r in records:
        colour = colour_of(r)
        alpha = 150 if r["type"] == "snow_park" else 70
        for area in r["areas"]:
            draw.polygon(px(area), fill=(*colour, alpha))
    for r in records:
        colour = (*colour_of(r), 230)
        kind = r["type"]
        for line in r["lines"]:
            points = px(line)
            if r["difficulty"] == FREERIDE or kind in ("skitour", "hike"):
                dashed(points, colour, 2)  # itinerary or route, not a groomed run
            elif kind in ("nordic", "connection"):
                draw.line(points, fill=colour, width=2)
            else:
                draw.line(points, fill=colour, width=3)
        for line in r.get("tunnels", []):
            dashed(px(line), (90, 90, 90, 200), 2)
    image.paste(Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB"))


#: The menu's preview of a resort (resort cards, the start-point map): the minimap scaled
#: to fit this many pixels on its long side, as a small JPEG.
PREVIEW_SIZE = 1024


def preview(image: Image.Image, size: int = PREVIEW_SIZE) -> Image.Image:
    """The minimap scaled down for the menu (same extent, so pins line up)."""
    scale = size / max(image.size)
    if scale >= 1:
        return image.convert("RGB")
    w, h = (max(1, round(d * scale)) for d in image.size)
    return image.convert("RGB").resize((w, h), Image.LANCZOS)
