from ski_sim_pipeline.cli import build_each, resort_ids


def test_resort_ids_are_every_config_in_name_order(tmp_path):
    for resort_id in ("zermatt", "arlberg", "niseko"):
        (tmp_path / resort_id).mkdir()
        (tmp_path / resort_id / "resort.json").write_text("{}")
    (tmp_path / "scratch").mkdir()  # no config: not a resort
    assert resort_ids(tmp_path) == ["arlberg", "niseko", "zermatt"]


def test_a_failed_build_does_not_stop_the_rest():
    built = []

    def build_one(resort_id):
        if resort_id == "b":
            raise RuntimeError("Overpass timed out")
        built.append(resort_id)

    assert build_each(["a", "b", "c"], build_one) == ["b"]
    assert built == ["a", "c"]
