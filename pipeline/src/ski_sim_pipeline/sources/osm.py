"""OpenStreetMap features via the Overpass API.

Licence: ODbL. Attribution "© OpenStreetMap contributors"; derived databases must be
shared under the same licence.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import time
import urllib.parse
from pathlib import Path

from . import http

log = logging.getLogger(__name__)

#: Public Overpass instances, tried in order and cycled through across retry rounds. The
#: main instance goes first (the most capacity for big queries); overpass.osm.ch is a
#: reliable fallback when overpass-api.de is throwing 502s. Override with the OVERPASS_URLS
#: env var (comma- or space-separated) to pin or extend the list.
DEFAULT_OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)

#: Total time to keep retrying across all mirrors before giving up, seconds. Overridable
#: with OVERPASS_BUDGET_S (env) or `ski-sim build --overpass-budget`.
DEFAULT_OVERPASS_BUDGET_S = 600.0

#: One request's timeout. Long enough for a real multi-minute resort query, short enough
#: that a hung mirror fails and we move on instead of eating the whole budget.
OVERPASS_TIMEOUT_S = 120.0

_BASE_BACKOFF_S = 5.0
_MAX_BACKOFF_S = 120.0


def _overpass_urls() -> tuple[str, ...]:
    override = os.environ.get("OVERPASS_URLS", "")
    urls = tuple(u.strip() for u in re.split(r"[,\s]+", override) if u.strip())
    return urls or DEFAULT_OVERPASS_URLS


def _overpass_budget() -> float:
    raw = os.environ.get("OVERPASS_BUDGET_S")
    if raw:
        try:
            return max(1.0, float(raw))
        except ValueError:
            log.warning("Ignoring invalid OVERPASS_BUDGET_S=%r", raw)
    return DEFAULT_OVERPASS_BUDGET_S


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


#: Road classes fetched (`highway=*`): through roads to residential streets, service roads
#: and tracks. Footways, paths, steps, cycleways and bridleways aren't: in winter they're
#: under the snow (walking routes the resort keeps open are mapped as pistes).
ROAD_CLASSES = (
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "track",
)


def fetch_roads(lonlat_bounds: tuple[float, ...], cache_dir: Path) -> list[dict]:
    """Road ways (`highway` of ROAD_CLASSES) within the bounds, with geometry."""
    classes = "|".join(ROAD_CLASSES)
    query = (
        f'[out:json][timeout:180];way["highway"~"^({classes})$"]({_bbox(lonlat_bounds)});'
        "out tags geom;"
    )
    return _query(query, cache_dir, "roads")


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


def _is_vertex(point: object) -> bool:
    return isinstance(point, dict) and "lat" in point and "lon" in point


def strip_null_vertices(elements: list[dict]) -> list[dict]:
    """Drop null (and otherwise malformed) entries from every `out geom` geometry array.

    Some mirrors (overpass.osm.ch) put `null` in the `geometry` list for points clipped by
    the bbox; the territory and geometry parsers choke on them. Sanitising centrally here
    means every `fetch_*` gets clean {lat, lon} vertices, from a fresh fetch or an old cache.
    """
    for element in elements:
        geometry = element.get("geometry")
        if isinstance(geometry, list):
            element["geometry"] = [p for p in geometry if _is_vertex(p)]
        for member in element.get("members") or []:
            member_geometry = member.get("geometry")
            if isinstance(member_geometry, list):
                member["geometry"] = [p for p in member_geometry if _is_vertex(p)]
    return elements


def _fetch_overpass(
    query: str,
    *,
    urls: tuple[str, ...],
    budget: float,
    sleep=time.sleep,
    clock=time.monotonic,
    jitter=random.random,
) -> bytes:
    """Fetch one Overpass query, cycling through `urls` over as many rounds as `budget`
    (seconds) allows, with exponential backoff + jitter between rounds and honouring any
    Retry-After. Returns the raw response body; raises RuntimeError once the budget runs out."""
    body = urllib.parse.urlencode({"data": query}).encode()
    deadline = clock() + budget
    last_error: Exception | None = None
    round_no = 0
    while True:
        round_no += 1
        retry_after = 0.0
        for url in urls:
            try:
                return http.fetch(
                    url,
                    data=body,
                    expect_content_type="application/json",
                    timeout=OVERPASS_TIMEOUT_S,
                )
            except http.RateLimited as e:
                last_error = e
                if e.retry_after:
                    retry_after = max(retry_after, e.retry_after)
                log.warning(
                    "Overpass %s rate-limited%s",
                    url,
                    f" (Retry-After {e.retry_after:.0f}s)" if e.retry_after else "",
                )
            except Exception as e:  # noqa: BLE001 - fall through to the next mirror
                last_error = e
                log.warning("Overpass %s failed: %s", url, e)
        # Every mirror failed this round. Back off (honouring Retry-After) and go again,
        # unless the wait would run past the budget.
        backoff = min(_MAX_BACKOFF_S, _BASE_BACKOFF_S * 2 ** (round_no - 1))
        wait = max(retry_after, backoff) * (0.5 + jitter())
        if clock() + wait >= deadline:
            raise RuntimeError(
                f"All Overpass mirrors failed within the {budget:.0f}s budget"
            ) from last_error
        log.warning("Overpass round %d failed on every mirror; retrying in %.0fs", round_no, wait)
        sleep(wait)


def _query(query: str, cache_dir: Path, description: str) -> list[dict]:
    key = hashlib.sha256(query.encode()).hexdigest()[:16]
    dest = cache_dir / "osm" / f"overpass-{key}.json"
    if dest.exists():
        # An old cache may hold a mirror's null vertices, so sanitise on read too.
        return strip_null_vertices(json.loads(dest.read_text()).get("elements", []))

    log.info("Fetching OSM %s from Overpass", description)
    raw = _fetch_overpass(query, urls=_overpass_urls(), budget=_overpass_budget())
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Overpass sent invalid JSON for {description}") from e
    if "elements" not in data:
        raise RuntimeError(f"Overpass response for {description} had no elements")
    strip_null_vertices(data["elements"])

    # Only cache a validated, sanitised response, written atomically: a failed or partial
    # fetch leaves no file, so a re-run resumes from the queries that did succeed.
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".json.part")
    tmp.write_text(json.dumps(data))
    tmp.replace(dest)
    return data["elements"]
