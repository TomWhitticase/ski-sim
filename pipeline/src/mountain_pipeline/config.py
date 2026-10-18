"""Per-resort configuration loaded from data/resorts/<id>/resort.json."""

from __future__ import annotations

import json
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
    altitude: float
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


def _layer(raw: dict) -> TerrainLayerConfig:
    return TerrainLayerConfig(
        sources=tuple(raw["sources"]),
        extent=Extent(**raw["extent"]),
        cell_size=float(raw["cellSize"]),
        fetch_cell_size=float(raw["fetchCellSize"]) if "fetchCellSize" in raw else None,
        description=raw.get("description", ""),
    )


def load_resort(path: Path) -> ResortConfig:
    raw = json.loads(path.read_text())
    return ResortConfig(
        id=raw["id"],
        name=raw["name"],
        country=raw["country"],
        origin=GeoPoint(raw["origin"]["lat"], raw["origin"]["lon"]),
        spawn=Spawn(**raw["spawn"]),
        near=_layer(raw["terrain"]["near"]),
        far=_layer(raw["terrain"]["far"]),
        minimap=MinimapConfig(
            cell_size=float(raw["minimap"]["cellSize"]),
            contour_interval=float(raw["minimap"]["contourInterval"]),
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
