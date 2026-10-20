import json

import pytest

from ski_sim_pipeline.cli import resort_config, slugify
from ski_sim_pipeline.config import load_resort


def test_minimal_config_derives_everything(tmp_path):
    path = tmp_path / "resort.json"
    path.write_text(
        json.dumps(
            {
                "id": "x",
                "name": "X",
                "country": "FR",
                "bounds": {"south": 45.2, "west": 6.5, "north": 45.3, "east": 6.6},
            }
        )
    )
    cfg = load_resort(path)
    assert cfg.origin.lat == pytest.approx(45.25)
    e = cfg.near.extent
    # ~7.9 km x 11.1 km, snapped outward to whole kilometres.
    assert e.west <= -3900 and e.east >= 3900 and e.south <= -5550 and e.north >= 5550
    assert e.width % 1000 == 0
    # The unsnapped box is kept too (start villages must be inside it).
    a = cfg.area
    assert a.west > e.west and a.east < e.east and a.north < e.north
    assert a.width == pytest.approx(7860, abs=50)
    assert cfg.near.sources == ("ign-lidar-hd", "ign-rge-alti")
    assert cfg.far.extent.west == pytest.approx(e.west - 55_000)
    assert cfg.spawn.altitude is None
    assert cfg.landmarks == ()


def test_unknown_countries_fall_back_to_global_terrain(tmp_path):
    path = tmp_path / "resort.json"
    raw = resort_config("y", "Y", "CA", (50.0, -122.0, 50.1, -121.9))
    path.write_text(json.dumps(raw))
    assert load_resort(path).near.sources == ("copernicus-glo30",)


def test_init_helpers():
    assert slugify("Les 3 Vallées · Méribel") == "les-3-vallees-meribel"
    cfg = resort_config("z", "Z", "FR", (45.0, 6.0, 45.1, 6.1))
    assert cfg["bounds"]["south"] < 45.0 and cfg["bounds"]["east"] > 6.1  # padded


def test_huge_areas_get_a_coarser_grid(tmp_path):
    path = tmp_path / "resort.json"
    path.write_text(json.dumps(resort_config("h", "H", "FR", (45.0, 6.0, 45.5, 6.5), margin=0)))
    cfg = load_resort(path)  # ~56 km tall: 4 m would be 14k samples
    assert cfg.near.extent.height / cfg.near.cell_size <= 8000
    assert cfg.near.cell_size > 4


def test_time_zone_comes_from_the_country_or_the_config(tmp_path):
    from ski_sim_pipeline.build import utc_offset_hours

    path = tmp_path / "resort.json"
    base = {"id": "x", "name": "X", "bounds": {"south": 45, "west": 6, "north": 45.1, "east": 6.1}}
    path.write_text(json.dumps({**base, "country": "JP"}))
    assert load_resort(path).timezone == "Asia/Tokyo"
    path.write_text(json.dumps({**base, "country": "US", "timezone": "America/Denver"}))
    assert utc_offset_hours(load_resort(path).timezone) == -7  # February: standard time
    assert utc_offset_hours("Asia/Kathmandu") == 5.75
    # Several zones and none given: estimated from the longitude (-111.5° -> UTC-7).
    utah = {"south": 40.6, "west": -111.6, "north": 40.7, "east": -111.4}
    path.write_text(json.dumps({**base, "country": "US", "bounds": utah}))
    assert utc_offset_hours(load_resort(path).timezone) == -7
