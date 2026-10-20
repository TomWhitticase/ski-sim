"""IGN elevation (France) via the Géoplateforme WMS-Raster service, in Lambert-93 (EPSG:2154).

Heights are orthometric metres in NGF-IGN69. Licence: Licence Ouverte / Etalab 2.0.

Layer choice matters: the generic ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES layer is
nearest-neighbour resampled from a ~1.5" geographic grid and produces stair-step
artefacts. The layers below are served from native Lambert-93 grids.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path

from .http import download

log = logging.getLogger(__name__)

CRS = "EPSG:2154"
NODATA = -99999.0
# Outside France tiles hold -9999 (not NODATA), and the service blends it into the valid
# heights next to it, so anything this low is missing data.
MIN_VALID = -1000.0
WMS_URL = "https://data.geopf.fr/wms-r"
MAX_TILE_PX = 4000  # service limit is 5010


@dataclass(frozen=True)
class IgnLayer:
    id: str
    wms_layer: str
    provenance: dict


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
            name = f"{layer.id}_{cell_size:g}m_{x:.0f}_{y:.0f}_{width}x{height}.tif"
            url = (
                f"{WMS_URL}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={layer.wms_layer}"
                f"&STYLES=&CRS={CRS}&BBOX={x},{y},{x1},{y1}&WIDTH={width}&HEIGHT={height}"
                "&FORMAT=image/geotiff"
            )
            dest = cache_dir / layer.id / name
            if not dest.exists():
                log.info("Fetching %s tile %s", layer.id, name)
            paths.append(download(url, dest, expect_content_type="image/geotiff"))
            x = x1
        y = y1
    return paths
