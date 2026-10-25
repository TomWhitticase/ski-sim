import json

from ski_sim_pipeline import fingerprint
from ski_sim_pipeline.cli import stale_resorts
from ski_sim_pipeline.fingerprint import config_hash, pipeline_hash, stale_reason


def resort(root, id_, built=None, version=9, config=None):
    cfg = root / "resorts" / id_
    cfg.mkdir(parents=True)
    (cfg / "resort.json").write_text(json.dumps(config or {"id": id_}))
    out = root / "processed" / id_
    if built is not None:
        out.mkdir(parents=True)
        manifest = {"version": version}
        if built:
            manifest["build"] = {"pipeline": pipeline_hash(), "config": config_hash(cfg)}
        (out / "manifest.json").write_text(json.dumps(manifest))
    return cfg, out


def test_stale_reasons(tmp_path):
    current = resort(tmp_path, "current", built=True)
    assert stale_reason(*current, 9) is None
    assert stale_reason(*resort(tmp_path, "new"), 9) == "never built"
    assert "version 8" in stale_reason(*resort(tmp_path, "old", built=True, version=8), 9)
    assert "fingerprinted" in stale_reason(*resort(tmp_path, "unmarked", built=False), 9)
    cfg, out = resort(tmp_path, "edited", built=True)
    (cfg / "resort.json").write_text(json.dumps({"id": "edited", "bounds": 1}))
    assert stale_reason(cfg, out, 9) == "resort.json changed"
    assert stale_resorts(tmp_path / "resorts", tmp_path / "processed").keys() == {
        "edited",
        "new",
        "old",
        "unmarked",
    }


def test_pipeline_hash_follows_the_code(tmp_path):
    package = tmp_path / "src" / "pkg"
    package.mkdir(parents=True)
    (package / "a.py").write_text("x = 1\n")
    (tmp_path / "uv.lock").write_text("lock 1\n")
    before = fingerprint.pipeline_hash(package)
    (package / "__pycache__").mkdir()
    (package / "__pycache__" / "a.pyc").write_bytes(b"junk")
    assert fingerprint.pipeline_hash(package) == before  # bytecode doesn't count
    (package / "a.py").write_text("x = 2\n")
    assert fingerprint.pipeline_hash(package) != before
    (package / "a.py").write_text("x = 1\n")
    (tmp_path / "uv.lock").write_text("lock 2\n")
    assert fingerprint.pipeline_hash(package) != before  # dependencies count
