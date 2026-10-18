"""The per-resort local ENU frame.

All processed data is resampled onto a transverse Mercator projection centred on the
resort origin. Within ~60 km of the origin its scale error is < 0.005%, so local
east/north metres are effectively a tangent plane and the sim can treat them as ENU.
The sim converts back to lat/lon with the same proj4 string (written to the manifest).
"""

from __future__ import annotations

from pyproj import CRS, Transformer

from .config import Extent, GeoPoint


class LocalFrame:
    def __init__(self, origin: GeoPoint) -> None:
        self.origin = origin
        self.proj4 = (
            f"+proj=tmerc +lat_0={origin.lat} +lon_0={origin.lon} +k=1 "
            "+x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"
        )
        self.crs = CRS.from_proj4(self.proj4)
        self._to_local = Transformer.from_crs("EPSG:4326", self.crs, always_xy=True)
        self._to_lonlat = Transformer.from_crs(self.crs, "EPSG:4326", always_xy=True)

    def to_local(self, lon: float, lat: float) -> tuple[float, float]:
        """WGS84 lon/lat -> local (east, north) metres."""
        return self._to_local.transform(lon, lat)

    def to_lonlat(self, east: float, north: float) -> tuple[float, float]:
        return self._to_lonlat.transform(east, north)

    def bounds_in(self, crs: str, extent: Extent, margin: float = 0.0) -> tuple[float, ...]:
        """Bounding box (minx, miny, maxx, maxy) of a local extent expressed in another CRS."""
        transformer = Transformer.from_crs(self.crs, crs, always_xy=True)
        return transformer.transform_bounds(
            extent.west - margin,
            extent.south - margin,
            extent.east + margin,
            extent.north + margin,
            densify_pts=64,
        )
