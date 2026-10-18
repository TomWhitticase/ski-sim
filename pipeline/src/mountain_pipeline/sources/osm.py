"""OpenStreetMap features via the Overpass API.

Licence: ODbL. Attribution "© OpenStreetMap contributors"; derived databases must be
shared under the same licence.
"""

from __future__ import annotations

import hashlib
import json
import logging
import urllib.parse
from pathlib import Path

from .http import download

log = logging.getLogger(__name__)

# Public instances are often overloaded; try each in turn.
OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)

PROVENANCE = {
    "name": "OpenStreetMap",
    "url": "https://www.openstreetmap.org/copyright",
    "license": "ODbL 1.0",
    "attribution": "© OpenStreetMap contributors",
}


def fetch_features(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Aerialways and buildings (ways, with geometry) intersecting the bounds."""
    min_lon, min_lat, max_lon, max_lat = lonlat_bounds
    bbox = f"{min_lat:.5f},{min_lon:.5f},{max_lat:.5f},{max_lon:.5f}"
    query = (
        "[out:json][timeout:180];"
        f'(way["aerialway"]({bbox});way["building"]({bbox}););'
        "out tags geom;"
    )
    key = hashlib.sha256(query.encode()).hexdigest()[:16]
    dest = cache_dir / "osm" / f"overpass-{key}.json"
    if not dest.exists():
        log.info("Fetching OSM lifts and buildings from Overpass")
    body = urllib.parse.urlencode({"data": query}).encode()

    last_error: Exception | None = None
    for url in OVERPASS_URLS:
        try:
            download(url, dest, expect_content_type="application/json", retries=2, data=body)
            break
        except Exception as e:  # noqa: BLE001 - fall through to the next mirror
            log.warning("Overpass %s failed: %s", url, e)
            last_error = e
    else:
        raise RuntimeError("All Overpass mirrors failed") from last_error

    return json.loads(dest.read_text())["elements"]
