"""Copernicus GLO-30 DEM (global, 30 m DSM) from the AWS open data bucket.

Heights are metres above the EGM2008 geoid. Note this is a surface model: forests and
buildings are included.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

from .http import NotFound, download

log = logging.getLogger(__name__)

BUCKET_URL = "https://copernicus-dem-30m.s3.amazonaws.com"

PROVENANCE = {
    "name": "Copernicus GLO-30 DEM",
    "url": "https://registry.opendata.aws/copernicus-dem/",
    "license": "Copernicus DEM licence (free, attribution required)",
    "attribution": (
        "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under "
        "COPERNICUS by the European Union and ESA; all rights reserved"
    ),
    "nativeResolution": 30.0,
    "verticalDatum": "EGM2008 (orthometric)",
}


def tile_name(lat: int, lon: int) -> str:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def fetch(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[Path]:
    """Download every 1°x1° tile intersecting (min_lon, min_lat, max_lon, max_lat)."""
    min_lon, min_lat, max_lon, max_lat = lonlat_bounds
    paths = []
    for lat in range(math.floor(min_lat), math.floor(max_lat) + 1):
        for lon in range(math.floor(min_lon), math.floor(max_lon) + 1):
            name = tile_name(lat, lon)
            dest = cache_dir / f"{name}.tif"
            if not dest.exists():
                log.info("Fetching Copernicus tile %s", name)
            try:
                paths.append(download(f"{BUCKET_URL}/{name}/{name}.tif", dest))
            except NotFound:
                log.info("No Copernicus tile %s (open ocean)", name)
    return paths
