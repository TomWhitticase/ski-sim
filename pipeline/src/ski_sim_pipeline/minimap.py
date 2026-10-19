"""Renders the minimap: winter-tinted hillshade, contour lines, buildings and lifts."""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

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
    for lift in features["lifts"]:
        points = [px(s["east"], s["north"]) for s in lift["supports"]]
        draw.line(points, fill=LIFT, width=2)
        for x, y in (points[0], points[-1]):
            draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=LIFT)


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
        for a, b in zip(points[::2], points[1::2], strict=False):
            draw.line([a, b], fill=colour, width=width)

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
