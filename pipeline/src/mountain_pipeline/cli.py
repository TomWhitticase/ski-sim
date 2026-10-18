"""Command line entry points.

uv run mountain-pipeline init <resort-id> --name "Name" --country FR --ski-area "Val Thorens"
uv run mountain-pipeline init <resort-id> --name "Name" --country FR --bbox S,W,N,E
uv run mountain-pipeline build <resort-id>
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
from pathlib import Path

from .build import build
from .sources import osm

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"
INIT_MARGIN_M = 1500  # around the ski area, so summits and valley floors are included


def slugify(name: str) -> str:
    import unicodedata

    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")


def resort_config(
    resort_id: str,
    name: str,
    country: str,
    bounds: tuple[float, float, float, float],
    margin: float = INIT_MARGIN_M,
) -> dict:
    """A minimal resort config: everything else is derived at build time."""
    south, west, north, east = bounds
    lat_pad = margin / 111_320
    lon_pad = margin / (111_320 * math.cos(math.radians((south + north) / 2)))
    return {
        "id": resort_id,
        "name": name,
        "country": country,
        "bounds": {
            "south": round(south - lat_pad, 4),
            "west": round(west - lon_pad, 4),
            "north": round(north + lat_pad, 4),
            "east": round(east + lon_pad, 4),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(prog="mountain-pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    build_cmd = sub.add_parser("build", help="Build processed assets for a resort")
    build_cmd.add_argument("resort", help="Resort id (directory name under data/resorts/)")
    init_cmd = sub.add_parser("init", help="Create a resort config from a ski area or bbox")
    init_cmd.add_argument("resort", nargs="?", help="Resort id (default: slug of --name)")
    init_cmd.add_argument("--name", required=True)
    init_cmd.add_argument("--country", required=True, help="ISO code, e.g. FR, CH, AT")
    where = init_cmd.add_mutually_exclusive_group(required=True)
    where.add_argument("--ski-area", help="OSM ski area name (landuse=winter_sports), regex ok")
    where.add_argument("--bbox", help="south,west,north,east in degrees")
    init_cmd.add_argument(
        "--margin", type=float, default=INIT_MARGIN_M, help="Padding around the area (m)"
    )
    init_cmd.add_argument("--force", action="store_true", help="Overwrite an existing config")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.command == "init":
        resort_id = args.resort or slugify(args.name)
        if args.bbox:
            parts = [float(v) for v in args.bbox.split(",")]
            if len(parts) != 4:
                parser.error("--bbox needs four numbers: south,west,north,east")
            bounds = (parts[0], parts[1], parts[2], parts[3])
        else:
            found = osm.find_ski_area(args.ski_area, DATA_DIR / "raw")
            if found is None:
                parser.error(f"No OSM ski area matching {args.ski_area!r}; try --bbox")
            bounds = found
        path = DATA_DIR / "resorts" / resort_id / "resort.json"
        if path.exists() and not args.force:
            parser.error(f"{path} exists (use --force to overwrite)")
        path.parent.mkdir(parents=True, exist_ok=True)
        config = resort_config(resort_id, args.name, args.country.upper(), bounds, args.margin)
        path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n")
        logging.info("Wrote %s; next: uv run mountain-pipeline build %s", path, resort_id)

    if args.command == "build":
        resort_dir = DATA_DIR / "resorts" / args.resort
        if not (resort_dir / "resort.json").exists():
            parser.error(f"No resort config at {resort_dir / 'resort.json'}")
        build(resort_dir, DATA_DIR / "raw", DATA_DIR / "processed")
