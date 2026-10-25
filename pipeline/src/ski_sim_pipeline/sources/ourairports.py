"""OurAirports: a worldwide list of airports, heliports and their runways.

Two CSVs (`airports.csv`, `runways.csv`), downloaded once and cached under
`data/raw/ourairports/`: runway length, width, surface, threshold positions and
elevations, headings, where someone has entered them. Used to cross-check and fill in
what OSM's runway ways don't say (OSM has the geometry).

Licence: public domain ("all data is released to the Public Domain"), no attribution
required; we credit it anyway.
"""

from __future__ import annotations

import csv
import logging
from dataclasses import dataclass
from pathlib import Path

from .http import download

log = logging.getLogger(__name__)

BASE_URL = "https://davidmegginson.github.io/ourairports-data"
FILES = ("airports.csv", "runways.csv")
FOOT = 0.3048

PROVENANCE = {
    "name": "OurAirports",
    "url": "https://ourairports.com/data/",
    "license": "Public domain",
    "attribution": "OurAirports (ourairports.com)",
}


@dataclass(frozen=True)
class Airport:
    id: str
    ident: str
    type: str  # small_airport, heliport, closed, ...
    name: str
    lat: float
    lon: float
    elevation: float | None  # m
    icao: str | None
    iata: str | None


@dataclass(frozen=True)
class RunwayEnd:
    ident: str
    lat: float | None
    lon: float | None
    elevation: float | None  # m
    heading: float | None  # degrees true


@dataclass(frozen=True)
class Runway:
    airport: str  # Airport.id
    length: float | None  # m
    width: float | None  # m
    surface: str | None
    closed: bool
    ends: tuple[RunwayEnd, RunwayEnd]


def _float(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def _metres(value: str | None) -> float | None:
    feet = _float(value)
    return round(feet * FOOT, 1) if feet is not None else None


def fetch(cache_dir: Path) -> tuple[Path, Path]:
    """The two CSVs, downloaded once (they're ~17 MB together) and kept."""
    out = cache_dir / "ourairports"
    for name in FILES:
        if not (out / name).exists():
            log.info("Fetching OurAirports %s", name)
        download(f"{BASE_URL}/{name}", out / name)
    return out / FILES[0], out / FILES[1]


def load(cache_dir: Path, lonlat_bounds: tuple[float, ...]) -> tuple[list[Airport], list[Runway]]:
    """Airports (not closed) inside the lon/lat bounds, and their runways."""
    airports_csv, runways_csv = fetch(cache_dir)
    return read(airports_csv, runways_csv, lonlat_bounds)


def read(
    airports_csv: Path, runways_csv: Path, lonlat_bounds: tuple[float, ...]
) -> tuple[list[Airport], list[Runway]]:
    min_lon, min_lat, max_lon, max_lat = lonlat_bounds
    airports: dict[str, Airport] = {}
    with airports_csv.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            lat, lon = _float(row["latitude_deg"]), _float(row["longitude_deg"])
            if lat is None or lon is None or row["type"] == "closed":
                continue
            if not (min_lat <= lat <= max_lat and min_lon <= lon <= max_lon):
                continue
            airports[row["id"]] = Airport(
                id=row["id"],
                ident=row["ident"],
                type=row["type"],
                name=row["name"],
                lat=lat,
                lon=lon,
                elevation=_metres(row["elevation_ft"]),
                icao=row.get("icao_code") or (row["ident"] if len(row["ident"]) == 4 else None),
                iata=row.get("iata_code") or None,
            )
    runways = []
    with runways_csv.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["airport_ref"] not in airports:
                continue

            def end(prefix: str, row: dict = row) -> RunwayEnd:
                return RunwayEnd(
                    ident=row[f"{prefix}_ident"],
                    lat=_float(row[f"{prefix}_latitude_deg"]),
                    lon=_float(row[f"{prefix}_longitude_deg"]),
                    elevation=_metres(row[f"{prefix}_elevation_ft"]),
                    heading=_float(row[f"{prefix}_heading_degT"]),
                )

            runways.append(
                Runway(
                    airport=row["airport_ref"],
                    length=_metres(row["length_ft"]),
                    width=_metres(row["width_ft"]),
                    surface=row["surface"] or None,
                    closed=row["closed"] == "1",
                    ends=(end("le"), end("he")),
                )
            )
    return list(airports.values()), runways
