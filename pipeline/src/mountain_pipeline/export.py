"""Writes pipeline outputs in the format the sim consumes (see docs/decisions/0001)."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .grid import Grid

# Smallest height quantum that still fits the grid's range in 16 bits.
HEIGHT_SCALES = (0.01, 0.02, 0.05, 0.1, 0.2, 0.5)


def encode_heights(heights: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Quantise float heights to uint16: height = offset + value * scale."""
    if np.isnan(heights).any():
        raise ValueError("Cannot encode heights containing NaN")
    lo = float(np.floor(heights.min()))
    span = float(heights.max()) - lo
    scale = next((s for s in HEIGHT_SCALES if span / s <= 65535), None)
    if scale is None:
        raise ValueError(f"Height range {span:.0f} m too large for uint16 encoding")
    encoded = np.round((heights - lo) / scale).astype("<u2")
    return encoded, lo, scale


def write_heightmap(path: Path, heights: np.ndarray, grid: Grid) -> dict:
    encoded, offset, scale = encode_heights(heights)
    path.write_bytes(encoded.tobytes())
    return {
        "file": path.name,
        "encoding": "uint16le",
        "rowOrder": "north-to-south",
        "width": grid.width,
        "height": grid.height,
        "cellSize": grid.cell_size,
        "extent": grid.extent.to_json(),
        "heightOffset": offset,
        "heightScale": scale,
        "minHeight": round(float(heights.min()), 2),
        "maxHeight": round(float(heights.max()), 2),
    }
