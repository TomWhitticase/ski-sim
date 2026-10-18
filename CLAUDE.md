# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**mountain-map** is a 3D immersive simulation of real ski resorts. The goal is fidelity: a resort in the sim should match its real-world counterpart as closely as public geospatial data allows. Terrain, pistes, lifts, buildings and tree lines all come from real data, not hand-authored approximations.

Status: **pre-code.** The tech stack is decided (see below). Nothing is scaffolded yet.

## Tech stack

Full rationale: `docs/decisions/0001-tech-stack.md`.

The project is built by Claude Code, so **everything must be operable from text files and the CLI**: no GUI editors, binary scene formats or menu-driven config. Keep it that way when picking any new tool.

- **Sim (`sim/`):** TypeScript (strict), Three.js (`WebGPURenderer` with WebGL 2 fallback, TSL shaders), Vite, Rapier (WASM) physics, Web Workers for heavy compute, Vitest, Playwright, ESLint + Prettier, pnpm.
- **Pipeline (`pipeline/`):** Python 3.12+, uv, rasterio, numpy, geopandas, shapely, pyproj, pyosmium, pytest, ruff.
- **Asset contract (pipeline → sim):** tiled LOD heightmaps + JSON manifest, KTX2/WebP textures, GLB (meshopt) models, GeoJSON pre-projected into the resort's local ENU frame, and a per-resort manifest with origin, CRS and provenance.

## Verifying work

Don't consider visual work done until you've looked at it. Run the dev server and capture Playwright screenshots of the affected view, then inspect them. Where a view is deterministic, add a screenshot test. Accuracy checks (elevations, lift lengths) belong in automated tests, not eyeballing.

## Core principles

1. **Real data first.** Every placed feature should trace back to a source dataset. When data is missing or too coarse, fill the gap procedurally, and record that it is synthetic. Never silently invent geography.
2. **Provenance is tracked.** Each resort build records which datasets (and versions/dates) it used, their resolution, and their license.
3. **Reproducible pipeline.** Raw data → processed assets must be a scripted, re-runnable pipeline. No manual edits to generated assets; fix the pipeline or add an explicit override file.
4. **Measurable accuracy.** Prefer things we can verify: lift lengths/vertical against published specs, piste lengths against the resort's own figures, summit/base elevations against official values.
5. **Resort-agnostic.** The pipeline should work for any resort given a bounding box/boundary. Resort-specific data lives in config, not code.

## Geospatial data sources

Use the best available source for the region; fall back to global datasets.

| Layer | High-res regional | Global fallback |
|---|---|---|
| Elevation (DEM) | USGS 3DEP lidar (US, ~1 m), swisstopo swissALTI3D (CH, 0.5 m), IGN RGE ALTI (FR, 1 m), Austrian state ALS DGMs (AT, 1 m), Kartverket (NO), LINZ (NZ), GSI (JP) | Copernicus GLO-30 DEM (30 m) |
| Imagery | USGS NAIP, swisstopo SWISSIMAGE, IGN BD ORTHO | Sentinel-2 (10 m) |
| Pistes, lifts, resort boundary | OpenStreetMap (`piste:type`, `piste:difficulty`, `aerialway=*`, `aerialway:*`, `landuse=winter_sports`) | OpenSkiMap (processed OSM ski data, GeoJSON exports) |
| Buildings | swissBUILDINGS3D (CH), national 3D building datasets | OSM buildings |
| Vegetation / tree line | Meta/WRI 1 m global canopy height, national forest inventories | ESA WorldCover (10 m), ETH global canopy height (10 m) |
| Lift specs (capacity, speed, manufacturer, towers) | Lift-World (lift-world.info), remontees-mecaniques.net, resort websites | OSM `aerialway:*` tags |
| Weather / snow | Open-Meteo, national weather services | — |

Licensing matters. OSM is ODbL and needs attribution plus share-alike on derived databases. Check each dataset's terms before using it and record them in the provenance metadata. Never commit data whose license forbids redistribution.

## Geospatial conventions

- **Store** source data in its native CRS. **Process** in a projected metric CRS local to the resort (the appropriate UTM zone or national grid).
- **At runtime**, use a local ENU / tangent-plane frame centered on a per-resort origin, in metres. This avoids float32 precision loss at large coordinates.
- Elevations are metres above the vertical datum the source uses. Record the datum and convert explicitly; don't mix ellipsoidal and orthometric heights.
- Units are SI throughout (metres, seconds, m/s). Convert at the UI layer only.

## Repository layout (planned)

```
docs/           Design notes, data source research, decisions (ADRs)
data/
  raw/          Downloaded source data (git-ignored)
  processed/    Pipeline outputs (git-ignored)
  resorts/      Per-resort config: boundary, origin, source selection, overrides (committed)
pipeline/       Data acquisition + processing (DEM, imagery, vectors → engine assets)
sim/            The 3D simulation / engine project
```

Large binaries (DEMs, imagery, meshes) are never committed directly. Generate them through the pipeline. If shared assets ever have to live in the repo, use Git LFS.

## Open decisions

These need to be settled with the user before implementation starts. Record each one in `docs/decisions/` (numbered ADRs) once made.

- Pilot resort for the first vertical slice
- Scope of simulation (free-roam skiing physics, lift operations, snow/weather, crowds)

## Working in this repo

- Ask before adding a major dependency or making a stack-level choice.
- Keep resort-specific values out of code. They belong in `data/resorts/<resort>/`.
- When you add a data source, update the table above and `docs/` with its URL, license, resolution and coverage.
