import pytest
from pyproj import Transformer

from ski_sim_pipeline.config import Extent, GeoPoint
from ski_sim_pipeline.frame import LocalFrame

ORIGIN = GeoPoint(lat=45.2981, lon=6.5803)


def test_origin_maps_to_zero():
    frame = LocalFrame(ORIGIN)
    east, north = frame.to_local(ORIGIN.lon, ORIGIN.lat)
    assert east == pytest.approx(0, abs=1e-6)
    assert north == pytest.approx(0, abs=1e-6)


def test_north_is_meridional_distance():
    # One hundredth of a degree of latitude at 45.3°N is ~1111.4 m on WGS84.
    east, north = LocalFrame(ORIGIN).to_local(ORIGIN.lon, ORIGIN.lat + 0.01)
    assert east == pytest.approx(0, abs=1e-6)
    assert north == pytest.approx(1111.4, abs=0.5)


def test_round_trip():
    frame = LocalFrame(ORIGIN)
    lon, lat = frame.to_lonlat(*frame.to_local(6.6240193, 45.2813645))
    assert lon == pytest.approx(6.6240193, abs=1e-9)
    assert lat == pytest.approx(45.2813645, abs=1e-9)


def test_bounds_in_lambert93_contains_extent():
    # Lambert-93 is rotated ~2.6° from true north here, so the box is a little larger
    # than the extent; what matters is that every corner falls inside it.
    frame = LocalFrame(ORIGIN)
    extent = Extent(-1000, 1000, -1000, 1000)
    minx, miny, maxx, maxy = frame.bounds_in("EPSG:2154", extent)
    to_l93 = Transformer.from_crs(frame.crs, "EPSG:2154", always_xy=True)
    for east in (extent.west, extent.east):
        for north in (extent.south, extent.north):
            x, y = to_l93.transform(east, north)
            assert minx <= x <= maxx
            assert miny <= y <= maxy
