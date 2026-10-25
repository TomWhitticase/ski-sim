"""What a resort was built from, so a stale build can be found and rebuilt.

A build records two hashes in its manifest (`build`): the pipeline's code and locked
dependencies, and the resort's own `resort.json`. A build is stale when either has
changed since, when its manifest version isn't the current one, or when there's no
build at all. Downloaded sources aren't hashed: the caches never change (OSM responses
are keyed by query text, which is pipeline code).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
#: Outside the package, these change what a build produces too.
PROJECT_FILES = ("pyproject.toml", "uv.lock")


def _digest(paths: list[Path], root: Path) -> str:
    h = hashlib.sha256()
    for path in sorted(paths):
        h.update(path.relative_to(root).as_posix().encode())
        h.update(b"\0")
        h.update(path.read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:16]


def pipeline_hash(package: Path = PACKAGE) -> str:
    """The pipeline's source (every .py in the package) and its locked dependencies."""
    project = package.parents[1]
    files = [p for p in package.rglob("*.py") if "__pycache__" not in p.parts]
    files += [project / f for f in PROJECT_FILES if (project / f).exists()]
    return _digest(files, project)


def config_hash(resort_dir: Path) -> str:
    return _digest([resort_dir / "resort.json"], resort_dir)


def fingerprint(resort_dir: Path) -> dict:
    """The manifest's `build` record."""
    return {"pipeline": pipeline_hash(), "config": config_hash(resort_dir)}


def stale_reason(resort_dir: Path, out_dir: Path, version: int) -> str | None:
    """Why the build in `out_dir` no longer matches, or None if it's current."""
    manifest = out_dir / "manifest.json"
    if not manifest.exists():
        return "never built"
    m = json.loads(manifest.read_text())
    if m.get("version") != version:
        return f"manifest version {m.get('version')}, now {version}"
    built = m.get("build")
    if not built:
        return "built before builds were fingerprinted"
    if built.get("pipeline") != pipeline_hash():
        return "pipeline changed"
    if built.get("config") != config_hash(resort_dir):
        return "resort.json changed"
    return None
