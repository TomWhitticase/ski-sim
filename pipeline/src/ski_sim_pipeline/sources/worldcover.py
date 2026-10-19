"""ESA WorldCover 10 m land cover (2021, v200), global, from the AWS open data bucket.

Tiles are 3°x3° cloud-optimised GeoTIFFs (EPSG:4326) named by their south-west corner,
with internal overviews (20, 40, 80 m...). Only the window we need is read over HTTP, at
the coarsest overview that still resolves `resolution`, and cached as a small GeoTIFF.
"""

from __future__ import annotations

import logging
import math
import urllib.error
import urllib.request
from pathlib import Path

import rasterio
from rasterio.windows import Window, from_bounds

from .http import USER_AGENT

log = logging.getLogger(__name__)

BUCKET_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
TILE_DEG = 3
NATIVE_DEG = 1 / 12000  # 10 m at the equator
SNAP_DEG = 0.01  # window edges snapped outward to this, for stable cache keys

# Land cover classes (the map's pixel values).
TREE_COVER = 10
SHRUBLAND = 20
GRASSLAND = 30
CROPLAND = 40
BUILT_UP = 50
BARE = 60
SNOW_ICE = 70
WATER = 80
WETLAND = 90
MANGROVES = 95
MOSS_LICHEN = 100

PROVENANCE = {
    "name": "ESA WorldCover 10 m 2021 v200",
    "url": "https://esa-worldcover.org/en/data-access",
    "license": "CC BY 4.0",
    "attribution": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data "
    "(2021) processed by ESA WorldCover consortium",
    "nativeResolution": 10.0,
}

_GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_USERAGENT": USER_AGENT,
    "GDAL_HTTP_MAX_RETRY": "4",
    "GDAL_HTTP_RETRY_DELAY": "5",
}


def tile_name(lat: int, lon: int) -> str:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"ESA_WorldCover_10m_2021_v200_{ns}{abs(lat):02d}{ew}{abs(lon):03d}_Map"


def _exists(url: str) -> bool:
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60):
            return True
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):  # S3 answers 403 for missing keys without list rights
            return False
        raise


def fetch(lonlat_bounds: tuple[float, ...], cache_dir: Path, resolution: float = 10.0):
    """Cropped GeoTIFFs covering (min_lon, min_lat, max_lon, max_lat) at roughly
    `resolution` metres per pixel, one per 3° tile it touches (open ocean has no tile)."""
    min_lon, min_lat, max_lon, max_lat = (
        math.floor(lonlat_bounds[0] / SNAP_DEG) * SNAP_DEG,
        math.floor(lonlat_bounds[1] / SNAP_DEG) * SNAP_DEG,
        math.ceil(lonlat_bounds[2] / SNAP_DEG) * SNAP_DEG,
        math.ceil(lonlat_bounds[3] / SNAP_DEG) * SNAP_DEG,
    )
    # Power-of-two decimation, matching the file's overviews.
    factor = 2 ** max(0, math.floor(math.log2(max(resolution / 10.0, 1.0))))
    paths = []
    lat0 = math.floor(min_lat / TILE_DEG) * TILE_DEG
    lon0 = math.floor(min_lon / TILE_DEG) * TILE_DEG
    for lat in range(lat0, math.floor(max_lat / TILE_DEG) * TILE_DEG + 1, TILE_DEG):
        for lon in range(lon0, math.floor(max_lon / TILE_DEG) * TILE_DEG + 1, TILE_DEG):
            w, s = max(min_lon, lon), max(min_lat, lat)
            e, n = min(max_lon, lon + TILE_DEG), min(max_lat, lat + TILE_DEG)
            if e <= w or n <= s:
                continue
            name = tile_name(lat, lon)
            dest = cache_dir / f"{name}_{10 * factor}m_{w:.2f}_{s:.2f}_{e:.2f}_{n:.2f}.tif"
            if dest.exists():
                paths.append(dest)
                continue
            url = f"{BUCKET_URL}/{name}.tif"
            if not _exists(url):
                log.info("No WorldCover tile %s (open ocean)", name)
                continue
            log.info("Fetching WorldCover %s window at %d m", name, 10 * factor)
            _read_window(url, (w, s, e, n), factor, dest)
            paths.append(dest)
    return paths


def _read_window(url: str, bounds: tuple[float, ...], factor: int, dest: Path) -> None:
    with rasterio.Env(**_GDAL_ENV), rasterio.open(f"/vsicurl/{url}") as src:
        window = from_bounds(*bounds, transform=src.transform).round_offsets().round_lengths()
        window = window.intersection(Window(0, 0, src.width, src.height))
        out_shape = (
            max(1, math.ceil(window.height / factor)),
            max(1, math.ceil(window.width / factor)),
        )
        # A decimated read is served from the matching overview (nearest: classes).
        data = src.read(1, window=window, out_shape=out_shape)
        transform = src.window_transform(window) * rasterio.Affine.scale(
            window.width / out_shape[1], window.height / out_shape[0]
        )
        profile = {
            "driver": "GTiff",
            "dtype": "uint8",
            "count": 1,
            "width": out_shape[1],
            "height": out_shape[0],
            "crs": src.crs,
            "transform": transform,
            "nodata": 0,
            "compress": "deflate",
        }
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part.tif")
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(data, 1)
    tmp.replace(dest)
