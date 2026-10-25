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


def _bbox(lonlat_bounds: tuple[float, ...]) -> str:
    min_lon, min_lat, max_lon, max_lat = lonlat_bounds
    return f"{min_lat:.5f},{min_lon:.5f},{max_lat:.5f},{max_lon:.5f}"


def fetch_features(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Aerialways and buildings (ways, with geometry) intersecting the bounds."""
    bbox = _bbox(lonlat_bounds)
    query = (
        "[out:json][timeout:180];"
        f'(way["aerialway"]({bbox});way["building"]({bbox}););'
        "out tags geom;"
    )
    return _query(query, cache_dir, "lifts and buildings")


def fetch_lifts(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Aerialways only (ways, with geometry): cheap over a wide box, unlike buildings."""
    query = f'[out:json][timeout:180];way["aerialway"]({_bbox(lonlat_bounds)});out tags geom;'
    return _query(query, cache_dir, "lifts")


def fetch_peaks(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Named peak nodes within the bounds."""
    query = f'[out:json][timeout:180];node["natural"="peak"]["name"]({_bbox(lonlat_bounds)});out;'
    return _query(query, cache_dir, "peaks")


def fetch_pistes(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Piste ways (lines and areas) with geometry."""
    query = f'[out:json][timeout:180];way["piste:type"]({_bbox(lonlat_bounds)});out tags geom;'
    return _query(query, cache_dir, "pistes")


def fetch_restaurants(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Food and drink places (nodes, and ways with geometry) and mapped outdoor seating."""
    bbox = _bbox(lonlat_bounds)
    query = (
        "[out:json][timeout:180];"
        f'(nwr["amenity"~"^(restaurant|bar|cafe|pub|fast_food|biergarten)$"]({bbox});'
        f'nwr["tourism"="alpine_hut"]({bbox});'
        f'way["leisure"="outdoor_seating"]({bbox}););'
        "out tags geom;"
    )
    return _query(query, cache_dir, "restaurants")


def fetch_airfields(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Everything tagged `aeroway` (aerodromes, runways, taxiways, aprons, helipads,
    windsocks, hangars...): nodes, and ways and relations with geometry."""
    query = f'[out:json][timeout:180];nwr["aeroway"]({_bbox(lonlat_bounds)});out tags geom;'
    return _query(query, cache_dir, "airfields")


def fetch_places(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Named settlements (towns, villages, hamlets, suburbs) within the bounds."""
    query = (
        "[out:json][timeout:120];"
        f'node["place"~"^(town|village|hamlet|suburb|neighbourhood)$"]["name"]({_bbox(lonlat_bounds)});'
        "out;"
    )
    return _query(query, cache_dir, "places")


def fetch_borders(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Ways of national borders (members of admin_level=2 boundary relations) within the
    bounds, with geometry. Empty where the area is inside one country."""
    bbox = _bbox(lonlat_bounds)
    query = (
        "[out:json][timeout:180];"
        f'relation["boundary"="administrative"]["admin_level"="2"]({bbox})->.c;'
        f"way(r.c)({bbox});"
        "out tags geom;"
    )
    return _query(query, cache_dir, "borders")


def query(text: str, cache_dir: Path, description: str) -> list[dict]:
    """Any Overpass query, cached by its text."""
    return _query(text, cache_dir, description)


def fetch_ski_areas(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Ski area outlines (`landuse=winter_sports` ways) within the bounds, with geometry."""
    query = (
        "[out:json][timeout:120];"
        f'way["landuse"="winter_sports"]({_bbox(lonlat_bounds)});'
        "out tags geom;"
    )
    return _query(query, cache_dir, "ski areas")


def find_ski_area(name: str, cache_dir: Path) -> tuple[float, float, float, float] | None:
    """Lat/lon bounds (south, west, north, east) of OSM ski areas (`landuse=winter_sports`)
    whose name matches, unioned. None if nothing matches."""
    pattern = name.replace('"', "")
    query = (
        "[out:json][timeout:120];"
        f'(way["landuse"="winter_sports"]["name"~"{pattern}",i];'
        f'relation["landuse"="winter_sports"]["name"~"{pattern}",i];);out bb tags;'
    )
    elements = _query(query, cache_dir, f"ski area '{name}'")
    boxes = [e["bounds"] for e in elements if "bounds" in e]
    if not boxes:
        return None

    # Names repeat around the world: keep only areas near the largest match.
    def centre(b: dict) -> tuple[float, float]:
        return (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2

    def size(b: dict) -> float:
        return (b["maxlat"] - b["minlat"]) * (b["maxlon"] - b["minlon"])

    anchor = centre(max(boxes, key=size))
    boxes = [
        b
        for b in boxes
        if abs(centre(b)[0] - anchor[0]) < 0.3 and abs(centre(b)[1] - anchor[1]) < 0.4
    ]
    return (
        min(b["minlat"] for b in boxes),
        min(b["minlon"] for b in boxes),
        max(b["maxlat"] for b in boxes),
        max(b["maxlon"] for b in boxes),
    )


def _query(query: str, cache_dir: Path, description: str) -> list[dict]:
    key = hashlib.sha256(query.encode()).hexdigest()[:16]
    dest = cache_dir / "osm" / f"overpass-{key}.json"
    if not dest.exists():
        log.info("Fetching OSM %s from Overpass", description)
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
