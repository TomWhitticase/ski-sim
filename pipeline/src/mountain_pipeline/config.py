"""Per-resort configuration loaded from data/resorts/<id>/resort.json."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Extent:
    """Axis-aligned rectangle in local ENU metres (east/north relative to the resort origin)."""

    west: float
    east: float
    south: float
    north: float

    @property
    def width(self) -> float:
        return self.east - self.west

    @property
    def height(self) -> float:
        return self.north - self.south

    def contains(self, east: float, north: float) -> bool:
        return self.west <= east <= self.east and self.south <= north <= self.north

    def to_json(self) -> dict[str, float]:
        return {"west": self.west, "east": self.east, "south": self.south, "north": self.north}


@dataclass(frozen=True)
class GeoPoint:
    lat: float
    lon: float


@dataclass(frozen=True)
class Spawn:
    lat: float
    lon: float
    # None: pick a height above the terrain at build time.
    altitude: float | None
    heading: float


@dataclass(frozen=True)
class TerrainLayerConfig:
    # In priority order: holes in one source are filled from the next.
    sources: tuple[str, ...]
    extent: Extent
    cell_size: float
    fetch_cell_size: float | None
    description: str


@dataclass(frozen=True)
class MinimapConfig:
    cell_size: float
    contour_interval: float


@dataclass(frozen=True)
class Landmark:
    name: str
    lat: float
    lon: float
    ele: float
    osm_node: int | None


@dataclass(frozen=True)
class ResortConfig:
    id: str
    name: str
    country: str
    origin: GeoPoint
    spawn: Spawn
    near: TerrainLayerConfig
    far: TerrainLayerConfig
    minimap: MinimapConfig
    landmarks: tuple[Landmark, ...]


# Defaults that make a resort config just id + name + country + lat/lon bounds.
DEFAULT_NEAR_CELL = 4.0
DEFAULT_FAR_CELL = 50.0
MAX_GRID_SIZE = 8000
FAR_MARGIN = 55_000.0  # horizon terrain this far beyond the resort area (m)
NEAR_SOURCES_BY_COUNTRY = {"FR": ("ign-lidar-hd", "ign-rge-alti")}
FALLBACK_NEAR_SOURCES = ("copernicus-glo30",)


def _snap(value: float, step: float, up: bool) -> float:
    return (math.ceil if up else math.floor)(value / step) * step


def _layer(raw: dict, defaults: dict) -> TerrainLayerConfig:
    merged = {**defaults, **raw}
    return TerrainLayerConfig(
        sources=tuple(merged["sources"]),
        extent=Extent(**merged["extent"]),
        cell_size=float(merged["cellSize"]),
        fetch_cell_size=float(merged["fetchCellSize"]) if merged.get("fetchCellSize") else None,
        description=merged.get("description", ""),
    )


def load_resort(path: Path) -> ResortConfig:
    """Load a resort config. Only `id`, `name`, `country` and `bounds` (lat/lon box of the
    ski area) are required; origin, terrain extents and sources, spawn and minimap are
    derived when absent. Landmarks are optional: without them, summit validation uses
    every OSM peak with a published elevation in the area."""
    from .frame import LocalFrame

    raw = json.loads(path.read_text())
    b = raw.get("bounds")
    if "origin" in raw:
        origin = GeoPoint(raw["origin"]["lat"], raw["origin"]["lon"])
    elif b:
        origin = GeoPoint(
            round((b["south"] + b["north"]) / 2, 5), round((b["west"] + b["east"]) / 2, 5)
        )
    else:
        raise ValueError(f"{path}: needs `bounds` (or an explicit `origin` and `terrain`)")

    terrain = raw.get("terrain", {})
    near_raw = terrain.get("near", {})
    if "extent" not in near_raw:
        if not b:
            raise ValueError(f"{path}: needs `bounds` or `terrain.near.extent`")
        frame = LocalFrame(origin)
        cell = float(near_raw.get("cellSize", DEFAULT_NEAR_CELL))
        xs, ys = [], []
        for lat in (b["south"], b["north"]):
            for lon in (b["west"], b["east"]):
                x, y = frame.to_local(lon, lat)
                xs.append(x)
                ys.append(y)
        step = cell * 250  # whole-kilometre-ish edges keep grids tidy
        near_raw = {
            **near_raw,
            "extent": {
                "west": _snap(min(xs), step, False),
                "east": _snap(max(xs), step, True),
                "south": _snap(min(ys), step, False),
                "north": _snap(max(ys), step, True),
            },
        }
    # The sim uploads the near grid as a texture (typically max 8192 px a side):
    # coarsen the cell size for very large areas rather than fail.
    ext = near_raw["extent"]
    longest = max(ext["east"] - ext["west"], ext["north"] - ext["south"])
    cell = float(near_raw.get("cellSize", DEFAULT_NEAR_CELL))
    if longest / cell > MAX_GRID_SIZE:
        cell = math.ceil(longest / MAX_GRID_SIZE)
        near_raw = {**near_raw, "cellSize": cell, "fetchCellSize": cell / 2}
    near = _layer(
        near_raw,
        {
            "sources": NEAR_SOURCES_BY_COUNTRY.get(raw["country"], FALLBACK_NEAR_SOURCES),
            "cellSize": DEFAULT_NEAR_CELL,
            "fetchCellSize": DEFAULT_NEAR_CELL / 2,
            "description": raw["name"],
        },
    )
    far_raw = terrain.get("far", {})
    e = near.extent
    far = _layer(
        far_raw,
        {
            "sources": ("copernicus-glo30",),
            "cellSize": DEFAULT_FAR_CELL,
            "extent": {
                "west": _snap(e.west - FAR_MARGIN, 1000, False),
                "east": _snap(e.east + FAR_MARGIN, 1000, True),
                "south": _snap(e.south - FAR_MARGIN, 1000, False),
                "north": _snap(e.north + FAR_MARGIN, 1000, True),
            },
            "description": "Horizon terrain",
        },
    )
    spawn_raw = raw.get("spawn", {})
    spawn = Spawn(
        lat=spawn_raw.get("lat", origin.lat),
        lon=spawn_raw.get("lon", origin.lon),
        altitude=spawn_raw.get("altitude"),
        heading=spawn_raw.get("heading", 0.0),
    )
    minimap = raw.get("minimap", {})
    return ResortConfig(
        id=raw["id"],
        name=raw["name"],
        country=raw["country"],
        origin=origin,
        spawn=spawn,
        near=near,
        far=far,
        minimap=MinimapConfig(
            cell_size=float(minimap.get("cellSize", 8)),
            contour_interval=float(minimap.get("contourInterval", 100)),
        ),
        landmarks=tuple(
            Landmark(
                name=lm["name"],
                lat=lm["lat"],
                lon=lm["lon"],
                ele=float(lm["ele"]),
                osm_node=lm.get("osmNode"),
            )
            for lm in raw.get("landmarks", [])
        ),
    )
