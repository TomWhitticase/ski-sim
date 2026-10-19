"""Builds a resort's processed assets: terrain heightmaps, minimap and manifest."""

from __future__ import annotations

import json
import logging
import math
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from rasterio.warp import Resampling

from . import approach, features, grading, minimap, pistes, restaurants, terminals, territory
from . import bases as base_finder
from .config import Area, ResortConfig, load_resort
from .export import write_heightmap
from .frame import LocalFrame
from .grid import Grid, despike, reproject_into, sample_bilinear, stitch_far_to_near
from .sources import copernicus, ign, osm

log = logging.getLogger(__name__)

MANIFEST_VERSION = 7
LANDMARK_SEARCH_RADIUS = 30.0  # OSM summit nodes are often a few metres off the true top
LANDMARK_TOLERANCE = 15.0


def build_far(cfg: ResortConfig, frame: LocalFrame, raw_dir: Path) -> tuple[np.ndarray, Grid]:
    if cfg.far.sources != ("copernicus-glo30",):
        raise ValueError(f"Unsupported far terrain sources {cfg.far.sources!r}")
    grid = Grid(cfg.far.extent, cfg.far.cell_size)
    bounds = frame.bounds_in("EPSG:4326", grid.extent, margin=cfg.far.cell_size * 2)
    heights = grid.empty()
    for path in copernicus.fetch(bounds, raw_dir / "copernicus-glo30"):
        reproject_into(heights, grid, frame, path, Resampling.bilinear)
    missing = np.isnan(heights)
    if missing.any():
        log.warning("Far terrain: %d cells without data, filling with 0 m", missing.sum())
        heights[missing] = 0.0
    return heights, grid


def build_near(
    cfg: ResortConfig, frame: LocalFrame, raw_dir: Path, far: np.ndarray, far_grid: Grid
) -> tuple[np.ndarray, Grid, dict[str, float]]:
    """Fill the near grid from each source in priority order; returns per-source coverage."""
    grid = Grid(cfg.near.extent, cfg.near.cell_size)
    fetch_cell = cfg.near.fetch_cell_size or cfg.near.cell_size
    bounds = frame.bounds_in(ign.CRS, grid.extent, margin=cfg.near.cell_size * 4)
    heights = grid.empty()
    coverage: dict[str, float] = {}

    for source in cfg.near.sources:
        layer_heights = grid.empty()
        if source == "copernicus-glo30":
            # Global fallback: coarse, but lets any resort on Earth build.
            lonlat = frame.bounds_in("EPSG:4326", grid.extent, margin=100)
            for path in copernicus.fetch(lonlat, raw_dir / "copernicus-glo30"):
                reproject_into(layer_heights, grid, frame, path, Resampling.cubic)
        elif (layer := ign.LAYERS.get(source)) is not None:
            for path in ign.fetch(layer, bounds, fetch_cell, raw_dir):
                reproject_into(
                    layer_heights,
                    grid,
                    frame,
                    path,
                    Resampling.average,
                    src_crs=ign.CRS,
                    src_nodata=ign.NODATA,
                )
        else:
            raise ValueError(f"Unsupported near terrain source {source!r}")
        fill = np.isnan(heights) & ~np.isnan(layer_heights)
        heights[fill] = layer_heights[fill]
        coverage[source] = round(float(fill.mean()), 6)
        log.info("Near terrain: %.2f%% of cells from %s", 100 * fill.mean(), source)
        if not np.isnan(heights).any():
            break

    holes = np.isnan(heights)
    if holes.any():
        log.warning("Near terrain: %d cells filled from far terrain", holes.sum())
        east, north = np.broadcast_arrays(*grid.coords())
        heights[holes] = sample_bilinear(far, far_grid, east[holes], north[holes])
        coverage["far"] = round(float(holes.mean()), 6)
    spikes = despike(heights)
    if spikes:
        log.info("Near terrain: %d pit/spike cells (lidar artefacts) smoothed", spikes)
    return heights, grid, coverage


def build_features(
    cfg: ResortConfig,
    frame: LocalFrame,
    raw_dir: Path,
    near: np.ndarray,
    near_grid: Grid,
    far: np.ndarray,
    far_grid: Grid,
    area: Area | None = None,
) -> dict:
    """Lifts, buildings and peaks from OSM, placed on the terrain."""
    bounds = frame.bounds_in("EPSG:4326", near_grid.extent)
    elements = osm.fetch_features(bounds, raw_dir)

    def ground(east: np.ndarray, north: np.ndarray) -> np.ndarray:
        return sample_bilinear(near, near_grid, east, north)

    # Lift terminals first: they flatten pads into the terrain (in place), and everything
    # else is then placed on the flattened ground.
    first_pass = features.extract_lifts(elements, frame, near_grid.extent, ground, [], area)
    terms = terminals.plan(first_pass)
    terminals.flatten(terms, near, near_grid, ground)
    log.info("Flattened %d lift terminal pads", len(terms))

    buildings, stations = features.extract_buildings(elements, frame, near_grid.extent, ground)
    lifts = features.extract_lifts(elements, frame, near_grid.extent, ground, stations, area)
    by_lift: dict[int, list[dict]] = {}
    for t in terms:
        by_lift.setdefault(t["lift"], []).append(t)

    # Smooth the line where it leaves each terminal (towers inside/crowding stations,
    # steep exits), then report what's left.
    smooth = {"dropped": 0, "adjusted": 0, "inserted": 0, "unresolved": 0}
    steep = []
    for lift in lifts:
        ends = by_lift.get(lift["id"], [])
        if len(ends) != 2:
            continue
        # Match terminals to the line's ends by position: on a short lift both pads can
        # share one height, so "bottom" by elevation may not be supports[0]'s end.
        s0 = lift["supports"][0]
        if math.hypot(ends[0]["east"] - s0["east"], ends[0]["north"] - s0["north"]) > math.hypot(
            ends[1]["east"] - s0["east"], ends[1]["north"] - s0["north"]
        ):
            ends.reverse()
        stats = approach.smooth_lift(lift, ends, ground)
        smooth = {k: smooth[k] + stats[k] for k in smooth}
        kind = terminals.KIND[lift["type"]]
        for t, seq in ((ends[0], lift["supports"]), (ends[1], lift["supports"][::-1])):
            angle = approach.exit_angle(seq, t, kind)
            limit = max(approach.MAX_EXIT_ANGLE[kind], approach.feasible_exit_angle(seq, t, kind))
            if angle > limit + 0.5:
                steep.append(f"{lift['name'] or lift['id']} {t['end']} {angle:.0f}°")
    log.info(
        "Lift approaches: %d towers dropped, %d adjusted, %d added; %d steep station exits",
        smooth["dropped"],
        smooth["adjusted"],
        smooth["inserted"],
        len(steep),
    )
    if steep:
        log.warning("Steep station exits: %s", ", ".join(steep[:12]))

    # Entrances, then cut buildings only as much as lifts need (3D volumes).
    terminals.choose_entrances(terms, buildings)
    cuts = terminals.cut_volumes(lifts, terms)
    buildings, cut_stats = terminals.cut_buildings(buildings, cuts)
    log.info(
        "Lift clearance: %d station buildings replaced, %d buildings cut (%d raised pieces)",
        cut_stats["removedAsStation"],
        cut_stats["cut"],
        cut_stats["raisedPieces"],
    )
    problems = terminals.conflicts(buildings, cuts)
    for problem in problems:
        log.error("Lift clearance check failed: %s", problem)
    entrances = {}
    for t in terms:
        entrances[t["entrance"]] = entrances.get(t["entrance"], 0) + 1
    log.info("Terminal entrances: %s", entrances)
    for t in terms:
        t.pop("lift")
    for lift in lifts:
        lift["terminals"] = by_lift.get(lift["id"], [])
        lift["detachable"] = bool(lift["terminals"] and lift["terminals"][0]["detachable"])
    cut_stats = {**cut_stats, "steepExits": len(steep), **smooth}

    for lift in sorted(lifts, key=lambda lift: lift["name"] or ""):
        kinds = [s["kind"] for s in lift["supports"]]
        log.info(
            "Lift %-28s %-11s %5.0f m long %+5.0f m  towers: %2d osm, %2d synthetic",
            lift["name"] or f"<way {lift['id']}>",
            lift["type"],
            lift["length"],
            lift["vertical"],
            kinds.count("tower"),
            kinds.count("synthetic-tower"),
        )
    peak_elements = osm.fetch_peaks(frame.bounds_in("EPSG:4326", far_grid.extent), raw_dir)
    peaks = features.extract_peaks(peak_elements, frame, near, near_grid, far, far_grid)
    log.info("%d named peaks", len(peaks))

    estimated = sum(b["heightSource"] == "estimate" for b in buildings)
    log.info(
        "%d lifts, %d buildings (%d with estimated height)", len(lifts), len(buildings), estimated
    )
    return {
        "lifts": lifts,
        "buildings": buildings,
        "peaks": peaks,
        "_clearance": {**cut_stats, "problems": problems},
    }


def build_pistes(
    frame: LocalFrame,
    raw_dir: Path,
    near: np.ndarray,
    near_grid: Grid,
    out_dir: Path,
    area: Area | None = None,
) -> dict:
    """Piste overlay texture, lookup grid, edge markers and run records."""
    extent = near_grid.extent
    elements = osm.fetch_pistes(frame.bounds_in("EPSG:4326", extent), raw_dir)
    runs, shapes = pistes.collect(elements, frame, extent, area)

    def ground(east: np.ndarray, north: np.ndarray) -> np.ndarray:
        return sample_bilinear(near, near_grid, east, north)

    fine_grid = Grid(extent, pistes.RASTER_CELL)
    fine = pistes.rasterise(shapes, fine_grid, runs)
    overlay_factor = round(near_grid.cell_size / pistes.RASTER_CELL)
    lookup_factor = round(pistes.LOOKUP_CELL / pistes.RASTER_CELL)
    pistes.overlay_image(fine, runs, overlay_factor).save(
        out_dir / "pistes-overlay.png", optimize=True
    )
    pistes.lookup_image(fine, runs, lookup_factor).save(
        out_dir / "pistes-lookup.png", optimize=True
    )
    markers = pistes.edge_markers(shapes, runs, fine, fine_grid, ground)
    records = pistes.summarise(runs, ground)

    named = [r for r in records if r["name"]]
    groomed_km = sum(r["length"] for r in records if r["groomed"]) / 1000
    log.info(
        "%d pistes (%d named), %.0f km of mapped centreline, %d edge markers",
        len(records),
        len(named),
        groomed_km,
        len(markers),
    )
    (out_dir / "pistes.json").write_text(
        json.dumps(
            {"pistes": records, "markers": markers}, separators=(",", ":"), ensure_ascii=False
        )
    )
    return {
        "file": "pistes.json",
        "overlay": {"file": "pistes-overlay.png", "cellSize": near_grid.cell_size},
        "lookup": {"file": "pistes-lookup.png", "cellSize": pistes.LOOKUP_CELL},
        "extent": extent.to_json(),
        "count": len(records),
        "markers": len(markers),
    }


def validate_peaks(peaks: list[dict], extent) -> list[dict]:
    """Check DEM summit heights against every OSM peak in the resort area that has a
    published elevation (no hand-picked list needed). Logs a summary and the outliers."""
    results = [
        {
            "name": p["name"],
            "published": p["ele"],
            "dem": p["ground"],
            "error": round(p["ground"] - p["ele"], 1),
        }
        for p in peaks
        if p["ele"] is not None and extent.contains(p["east"], p["north"])
    ]
    if not results:
        log.warning("No OSM peaks with elevations to validate the terrain against")
        return results
    errors = np.abs([r["error"] for r in results])
    within = int((errors <= LANDMARK_TOLERANCE).sum())
    log.info(
        "Summit check: %d/%d OSM peaks within %.0f m (median error %.1f m)",
        within,
        len(results),
        LANDMARK_TOLERANCE,
        float(np.median(errors)),
    )
    for r in sorted(results, key=lambda r: -abs(r["error"]))[:5]:
        if abs(r["error"]) > LANDMARK_TOLERANCE:
            log.warning(
                "  outlier %-28s published %6.0f m  DEM %7.1f m  (OSM tag may be off)",
                r["name"],
                r["published"],
                r["dem"],
            )
    return results


def validate_landmarks(
    cfg: ResortConfig, frame: LocalFrame, heights: np.ndarray, grid: Grid
) -> list[dict]:
    """Compare DEM summit heights against published elevations."""
    results = []
    r = int(np.ceil(LANDMARK_SEARCH_RADIUS / grid.cell_size))
    for lm in cfg.landmarks:
        east, north = frame.to_local(lm.lon, lm.lat)
        if not grid.extent.contains(east, north):
            continue
        col = round((east - grid.extent.west) / grid.cell_size)
        row = round((grid.extent.north - north) / grid.cell_size)
        window = heights[max(row - r, 0) : row + r + 1, max(col - r, 0) : col + r + 1]
        dem = float(window.max())
        error = dem - lm.ele
        ok = abs(error) <= LANDMARK_TOLERANCE
        (log.info if ok else log.warning)(
            "Landmark %-28s published %6.0f m  DEM %7.1f m  error %+6.1f m%s",
            lm.name,
            lm.ele,
            dem,
            error,
            "" if ok else "  <-- OUT OF TOLERANCE",
        )
        results.append(
            {"name": lm.name, "published": lm.ele, "dem": round(dem, 1), "error": round(error, 1)}
        )
    return results


def write_resort_index(out_root: Path) -> Path:
    """`resorts.json`: every built resort, for the sim's ski-area menu."""
    resorts = []
    for manifest_path in sorted(out_root.glob("*/manifest.json")):
        m = json.loads(manifest_path.read_text())
        resorts.append(
            {
                **m["resort"],
                "bases": [b["name"] for b in m.get("bases", [])],
                "lifts": m.get("features", {}).get("lifts"),
                "pistes": m.get("pistes", {}).get("count"),
            }
        )
    path = out_root / "resorts.json"
    path.write_text(json.dumps({"resorts": resorts}, indent=2, ensure_ascii=False) + "\n")
    return path


def build(resort_dir: Path, raw_root: Path, out_root: Path) -> Path:
    """Source caches under `raw_root` are shared across resorts."""
    cfg = load_resort(resort_dir / "resort.json")
    frame = LocalFrame(cfg.origin)
    out_dir = out_root / cfg.id
    out_dir.mkdir(parents=True, exist_ok=True)

    log.info("Building far terrain (%s)", ", ".join(cfg.far.sources))
    far, far_grid = build_far(cfg, frame, raw_root)
    log.info("Building near terrain (%s)", ", ".join(cfg.near.sources))
    near, near_grid, coverage = build_near(cfg, frame, raw_root, far, far_grid)
    ours = territory.from_osm(
        osm.fetch_ski_areas(frame.bounds_in("EPSG:4326", near_grid.extent), raw_root),
        frame,
        cfg.area or near_grid.extent,
    )
    log.info("Grading pistes into the terrain")
    piste_elements = osm.fetch_pistes(frame.bounds_in("EPSG:4326", near_grid.extent), raw_root)
    graded = grading.grade(
        pistes.collect(piste_elements, frame, near_grid.extent, ours)[0], near, near_grid
    )
    log.info(
        "Graded %d runs (%.0f km): climbing along them %.0f m -> %.0f m, max fill %.1f m",
        graded["runs"],
        graded["km"],
        graded["climbBefore"],
        graded["climbAfter"],
        graded["maxFill"],
    )
    stitch_far_to_near(far, far_grid, near, near_grid)

    log.info("Building lifts and buildings (OpenStreetMap)")
    feature_data = build_features(cfg, frame, raw_root, near, near_grid, far, far_grid, ours)
    clearance = feature_data.pop("_clearance")
    places = osm.fetch_places(frame.bounds_in("EPSG:4326", near_grid.extent), raw_root)
    start_bases = base_finder.find_bases(
        places,
        feature_data["lifts"],
        feature_data["buildings"],
        frame,
        ours,  # not the villages of a neighbouring resort
        lambda e, n: sample_bilinear(near, near_grid, e, n),
    )
    log.info("Start locations: %s", ", ".join(b["name"] for b in start_bases) or "none")
    if cfg.landmarks:
        validation = validate_landmarks(cfg, frame, near, near_grid)
    else:
        validation = validate_peaks(feature_data["peaks"], near_grid.extent)

    log.info("Building pistes (OpenStreetMap)")
    pistes_meta = build_pistes(frame, raw_root, near, near_grid, out_dir, ours)
    piste_records = json.loads((out_dir / "pistes.json").read_text())["pistes"]
    feature_data["restaurants"] = restaurants.extract(
        osm.fetch_restaurants(frame.bounds_in("EPSG:4326", near_grid.extent), raw_root),
        frame,
        ours,
        near,
        near_grid,
        feature_data["buildings"],
        feature_data["lifts"],
        piste_records,
        start_bases,
    )

    log.info("Writing outputs to %s", out_dir)
    (out_dir / "features.json").write_text(json.dumps(feature_data, separators=(",", ":")))
    near_meta = write_heightmap(out_dir / "terrain-near.bin", near, near_grid)
    far_meta = write_heightmap(out_dir / "terrain-far.bin", far, far_grid)

    factor = max(1, round(cfg.minimap.cell_size / near_grid.cell_size))
    mm_heights = minimap.downsample(near, factor)
    mm_cell = near_grid.cell_size * factor
    ext = near_grid.extent
    # Each minimap pixel covers a block of grid samples; its edges are half a sample out.
    half = near_grid.cell_size / 2
    image = minimap.render(mm_heights, mm_cell, cfg.minimap.contour_interval)
    minimap.draw_pistes(image, piste_records, ext.west - half, ext.north + half, mm_cell)
    minimap.draw_features(image, feature_data, ext.west - half, ext.north + half, mm_cell)
    image.save(out_dir / "minimap.png", optimize=True)
    minimap_meta = {
        "file": "minimap.png",
        "extent": {
            "west": ext.west - half,
            "north": ext.north + half,
            "east": ext.west - half + mm_heights.shape[1] * mm_cell,
            "south": ext.north + half - mm_heights.shape[0] * mm_cell,
        },
    }

    spawn_east, spawn_north = frame.to_local(cfg.spawn.lon, cfg.spawn.lat)
    now = datetime.now(UTC).replace(microsecond=0).isoformat()
    manifest = {
        "version": MANIFEST_VERSION,
        "generatedAt": now,
        "resort": {"id": cfg.id, "name": cfg.name, "country": cfg.country},
        "origin": {"lat": cfg.origin.lat, "lon": cfg.origin.lon},
        "projection": frame.proj4,
        "spawn": {
            "east": round(spawn_east, 2),
            "north": round(spawn_north, 2),
            "altitude": cfg.spawn.altitude
            if cfg.spawn.altitude is not None
            else round(float(sample_bilinear(near, near_grid, spawn_east, spawn_north)) + 150),
            "heading": cfg.spawn.heading,
        },
        "terrain": {"near": near_meta, "far": far_meta},
        "bases": start_bases,
        "minimap": minimap_meta,
        "pistes": pistes_meta,
        "features": {
            "file": "features.json",
            "lifts": len(feature_data["lifts"]),
            "buildings": len(feature_data["buildings"]),
            "peaks": len(feature_data["peaks"]),
            "restaurants": len(feature_data["restaurants"]),
        },
        "validation": {
            "landmarks": validation,
            "pisteGrading": graded,
            "nearCoverage": coverage,
            "liftClearance": clearance,
        },
        "provenance": [
            *(
                {
                    "layer": "terrain.near",
                    **ign.LAYERS[source].provenance,
                    "processedResolution": near_grid.cell_size,
                    "coverage": fraction,
                }
                for source, fraction in coverage.items()
                if source in ign.LAYERS and fraction > 0
            ),
            {
                "layer": "terrain.far",
                **copernicus.PROVENANCE,
                "processedResolution": far_grid.cell_size,
            },
            {"layer": "features", **osm.PROVENANCE},
        ],
    }
    path = out_dir / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    write_resort_index(out_root)
    log.info("Done: %s", path)
    return path
