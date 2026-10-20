"""IGN elevation (France) via the Géoplateforme WMS-Raster service, in Lambert-93 (EPSG:2154).

Heights are orthometric metres in NGF-IGN69. Licence: Licence Ouverte / Etalab 2.0.

Layer choice matters: the generic ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES layer is
nearest-neighbour resampled from a ~1.5" geographic grid and produces stair-step
artefacts. The layers below are served from native Lambert-93 grids.

RGE ALTI has no holes at the borders: beyond France it carries on with a coarse foreign
fill, hundreds of metres low on sharp summits (Aiguille Blanche de Peuterey, Italy: 3404 m
vs 4099 m). Its source mask (SRC layer, a styled RGB image) paints that fill magenta, so
`foreign_mask` turns it into nodata and a better source fills it.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio

from .http import download

log = logging.getLogger(__name__)

CRS = "EPSG:2154"
WMS_URL = "https://data.geopf.fr/wms-r"
MAX_TILE_PX = 4000  # service limit is 5010


@dataclass(frozen=True)
class IgnLayer:
    id: str
    wms_layer: str
    provenance: dict
    # WMS layer saying where the heights come from (see `foreign_mask`).
    source_layer: str | None = None


#: Source-mask colours that aren't IGN survey data: the foreign fill, and no source.
FOREIGN_SOURCE_COLOURS = ((225, 80, 200), (0, 0, 0))
#: The source mask only needs to resolve the border, not the terrain.
SOURCE_MASK_CELL = 8.0


LAYERS = {
    layer.id: layer
    for layer in (
        IgnLayer(
            id="ign-lidar-hd",
            wms_layer="IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93",
            provenance={
                "name": "IGN LiDAR HD MNT (0.5 m)",
                "url": "https://geoservices.ign.fr/lidarhd",
                "license": "Licence Ouverte / Etalab 2.0",
                "attribution": "IGN – LiDAR HD",
                "nativeResolution": 0.5,
                "verticalDatum": "NGF-IGN69 (orthometric)",
            },
        ),
        IgnLayer(
            id="ign-rge-alti",
            wms_layer="RGEALTI-MNT_PYR-ZIP_FXX_LAMB93_WMS",
            source_layer="RGEALTI-SRC_PYR-ZIP_FXX_LAMB93_WMS",
            provenance={
                "name": "IGN RGE ALTI® 1 m",
                "url": "https://geoservices.ign.fr/rgealti",
                "license": "Licence Ouverte / Etalab 2.0",
                "attribution": "IGN – RGE ALTI®",
                "nativeResolution": 1.0,
                "verticalDatum": "NGF-IGN69 (orthometric)",
            },
        ),
    )
}


def fetch(
    layer: IgnLayer, bounds: tuple[float, ...], cell_size: float, cache_dir: Path
) -> list[Path]:
    """Download tiles covering `bounds` (Lambert-93) at `cell_size` metres per pixel."""
    return _fetch_tiles(layer.id, layer.wms_layer, bounds, cell_size, cache_dir)


def fetch_source_mask(layer: IgnLayer, bounds: tuple[float, ...], cache_dir: Path) -> list[Path]:
    """Source-mask tiles for `layer` (empty if it has none)."""
    if layer.source_layer is None:
        return []
    return _fetch_tiles(
        f"{layer.id}-source", layer.source_layer, bounds, SOURCE_MASK_CELL, cache_dir
    )


def foreign_mask(path: Path) -> tuple[np.ndarray, rasterio.Affine]:
    """1.0 where a source-mask tile shows non-IGN data, else 0.0; with its transform."""
    with rasterio.open(path) as src:
        rgb = src.read()
        transform = src.transform
    if rgb.shape[0] < 3:
        raise ValueError(f"{path}: expected an RGB source mask, got {rgb.shape[0]} band(s)")
    foreign = np.zeros(rgb.shape[1:], dtype=bool)
    for colour in FOREIGN_SOURCE_COLOURS:
        foreign |= (rgb[:3] == np.array(colour, dtype=rgb.dtype)[:, None, None]).all(axis=0)
    return foreign.astype(np.float32), transform


def _fetch_tiles(
    tile_id: str, wms_layer: str, bounds: tuple[float, ...], cell_size: float, cache_dir: Path
) -> list[Path]:
    minx, miny, maxx, maxy = bounds
    # Snap to the cell grid so cache keys are stable across runs.
    minx = math.floor(minx / cell_size) * cell_size
    miny = math.floor(miny / cell_size) * cell_size
    maxx = math.ceil(maxx / cell_size) * cell_size
    maxy = math.ceil(maxy / cell_size) * cell_size
    tile_span = MAX_TILE_PX * cell_size
    paths = []
    y = miny
    while y < maxy:
        y1 = min(y + tile_span, maxy)
        x = minx
        while x < maxx:
            x1 = min(x + tile_span, maxx)
            width = round((x1 - x) / cell_size)
            height = round((y1 - y) / cell_size)
            name = f"{tile_id}_{cell_size:g}m_{x:.0f}_{y:.0f}_{width}x{height}.tif"
            url = (
                f"{WMS_URL}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={wms_layer}"
                f"&STYLES=&CRS={CRS}&BBOX={x},{y},{x1},{y1}&WIDTH={width}&HEIGHT={height}"
                "&FORMAT=image/geotiff"
            )
            dest = cache_dir / tile_id / name
            if not dest.exists():
                log.info("Fetching %s tile %s", tile_id, name)
            paths.append(download(url, dest, expect_content_type="image/geotiff"))
            x = x1
        y = y1
    return paths
