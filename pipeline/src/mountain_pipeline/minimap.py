"""Renders the minimap base image: winter-tinted hillshade with contour lines."""

from __future__ import annotations

import numpy as np
from PIL import Image

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
