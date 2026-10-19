"""Regular height grids in the local frame.

Grids are grid-registered: sample (row, col) sits exactly at
    east  = extent.west  + col * cell_size
    north = extent.north - row * cell_size
Row 0 is the northern edge (image order). The sim relies on this layout.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.warp import Resampling, reproject

from .config import Extent
from .frame import LocalFrame


@dataclass(frozen=True)
class Grid:
    extent: Extent
    cell_size: float

    @property
    def width(self) -> int:
        return round(self.extent.width / self.cell_size) + 1

    @property
    def height(self) -> int:
        return round(self.extent.height / self.cell_size) + 1

    @property
    def transform(self) -> Affine:
        # Pixel *centres* land on the grid points, so the pixel edge is half a cell out.
        half = self.cell_size / 2
        return Affine(
            self.cell_size, 0, self.extent.west - half, 0, -self.cell_size, self.extent.north + half
        )

    def empty(self) -> np.ndarray:
        return np.full((self.height, self.width), np.nan, dtype=np.float32)

    def coords(self) -> tuple[np.ndarray, np.ndarray]:
        """Broadcastable (east[1, w], north[h, 1]) coordinate arrays."""
        east = self.extent.west + np.arange(self.width) * self.cell_size
        north = self.extent.north - np.arange(self.height) * self.cell_size
        return east[np.newaxis, :], north[:, np.newaxis]


def reproject_into(
    dst: np.ndarray,
    grid: Grid,
    frame: LocalFrame,
    src_path: Path,
    resampling: Resampling,
    src_crs: str | None = None,
    src_nodata: float | None = None,
) -> None:
    """Resample a source raster into `dst`, only overwriting cells the source covers."""
    with rasterio.open(src_path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_crs=CRS.from_string(src_crs) if src_crs else src.crs,
            src_nodata=src_nodata if src_nodata is not None else src.nodata,
            dst_transform=grid.transform,
            dst_crs=CRS.from_wkt(frame.crs.to_wkt()),
            dst_nodata=np.nan,
            init_dest_nodata=False,
            resampling=resampling,
        )


def sample_bilinear(
    heights: np.ndarray, grid: Grid, east: np.ndarray, north: np.ndarray
) -> np.ndarray:
    """Bilinearly sample a grid at arbitrary local coordinates (clamped to the grid edge)."""
    col = np.clip((np.asarray(east) - grid.extent.west) / grid.cell_size, 0, grid.width - 1)
    row = np.clip((grid.extent.north - np.asarray(north)) / grid.cell_size, 0, grid.height - 1)
    c0 = np.minimum(np.floor(col).astype(np.int64), grid.width - 2)
    r0 = np.minimum(np.floor(row).astype(np.int64), grid.height - 2)
    fc = col - c0
    fr = row - r0
    top = heights[r0, c0] * (1 - fc) + heights[r0, c0 + 1] * fc
    bottom = heights[r0 + 1, c0] * (1 - fc) + heights[r0 + 1, c0 + 1] * fc
    return top * (1 - fr) + bottom * fr


def stitch_far_to_near(far: np.ndarray, far_grid: Grid, near: np.ndarray, near_grid: Grid) -> None:
    """Overwrite far-grid samples inside the near extent with near data.

    The sim hides far terrain inside the near extent; making both surfaces agree there
    keeps the seam at the boundary to sub-cell interpolation differences.
    """
    east, north = far_grid.coords()
    east, north = np.broadcast_arrays(east, north)
    ext = near_grid.extent
    inside = (east >= ext.west) & (east <= ext.east) & (north >= ext.south) & (north <= ext.north)
    far[inside] = sample_bilinear(near, near_grid, east[inside], north[inside])


def despike(heights: np.ndarray, threshold: float = 25.0, window: int = 3) -> int:
    """Replace pits and spikes (lidar artefacts) in place; returns how many cells.

    A cell more than `threshold` off the median of its four neighbours can't be real
    ground at our cell sizes: on a cliff, the neighbours along the cliff agree with it.
    Flagged cells take the median of the unflagged cells within `window` cells, repeated
    until clusters (rings of pits) are filled from their edges inward.
    """
    fixed = 0
    for _ in range(8):
        h = heights
        nb = np.stack([h[:-2, 1:-1], h[2:, 1:-1], h[1:-1, :-2], h[1:-1, 2:]])
        bad = np.zeros(h.shape, dtype=bool)
        bad[1:-1, 1:-1] = np.abs(h[1:-1, 1:-1] - np.median(nb, axis=0)) > threshold
        if not bad.any():
            break
        rows, cols = np.nonzero(bad)
        values = []
        for r, c in zip(rows, cols, strict=True):
            r0, r1 = max(r - window, 0), r + window + 1
            c0, c1 = max(c - window, 0), c + window + 1
            patch = h[r0:r1, c0:c1][~bad[r0:r1, c0:c1]]
            values.append(np.median(patch) if patch.size else h[r, c])
        h[rows, cols] = values
        fixed += len(rows)
    return fixed
