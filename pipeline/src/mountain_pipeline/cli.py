"""Command line entry point: `uv run mountain-pipeline build <resort-id>`."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

from .build import build

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"


def main() -> None:
    parser = argparse.ArgumentParser(prog="mountain-pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    build_cmd = sub.add_parser("build", help="Build processed assets for a resort")
    build_cmd.add_argument("resort", help="Resort id (directory name under data/resorts/)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.command == "build":
        resort_dir = DATA_DIR / "resorts" / args.resort
        if not (resort_dir / "resort.json").exists():
            parser.error(f"No resort config at {resort_dir / 'resort.json'}")
        build(resort_dir, DATA_DIR / "raw", DATA_DIR / "processed")
