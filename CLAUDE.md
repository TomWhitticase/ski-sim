# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**mountain-map** is a 3D immersive simulation of real ski resorts. The goal is fidelity: a resort in the sim should match its real-world counterpart as closely as public geospatial data allows. Terrain, pistes, lifts, buildings and tree lines all come from real data, not hand-authored approximations.

Status: **first vertical slice.** Val Thorens (France) renders from real lidar terrain, with basic lifts and buildings from OSM, fly mode, HUD, minimap and a bluebird sky. The long-term goal is the whole Three Valleys (Val Thorens, Les Menuires, Méribel, Courchevel). Grow extents and add resorts through config.

## Tech stack

Full rationale: `docs/decisions/0001-tech-stack.md`.

The project is built by Claude Code, so **everything must be operable from text files and the CLI**: no GUI editors, binary scene formats or menu-driven config. Keep it that way when picking any new tool.

- **Sim (`sim/`):** TypeScript (strict), Three.js (`WebGPURenderer` with WebGL 2 fallback, TSL shaders), Vite, Rapier (WASM) physics, Web Workers for heavy compute, Vitest, Playwright, ESLint + Prettier, pnpm.
- **Pipeline (`pipeline/`):** Python 3.12+, uv, rasterio, numpy, geopandas, shapely, pyproj, pyosmium, pytest, ruff.
- **Asset contract (pipeline → sim):** tiled LOD heightmaps + JSON manifest, KTX2/WebP textures, GLB (meshopt) models, GeoJSON pre-projected into the resort's local ENU frame, and a per-resort manifest with origin, CRS and provenance.
- TypeScript is pinned to 6.x because typescript-eslint doesn't support TS 7 yet.

## Commands

```sh
# Pipeline (run from pipeline/)
uv run mountain-pipeline build val-thorens   # fetch sources (cached in data/raw) and write data/processed/val-thorens
uv run pytest                                # tests
uv run ruff check . && uv run ruff format --check .

# Sim (run from sim/)
pnpm dev               # http://localhost:5173 (serves data/processed as static files)
pnpm test              # Vitest unit tests
pnpm screenshot        # Playwright: renders e2e view poses + runs control tests
pnpm perf              # load time + fps at fixed poses (needs pnpm dev running)
pnpm typecheck && pnpm lint
pnpm build
```

The sim needs pipeline output. Run the pipeline build first on a fresh checkout.

Useful URL params: `?resort=<id>`, `?at=lat,lon,altitude&heading=deg&pitch=deg` (jump the camera to a pose). Start pose priority: `?at=` > saved pose (written ~1/s and on page hide) > manifest spawn. Playwright gets a fresh browser context per test, so no saved pose leaks between tests. F3 in the sim shows fps, draw calls, triangles, position and sun angle.

## Verifying work

Don't consider visual work done until you've looked at it. `pnpm screenshot` renders the poses in `sim/e2e/views.spec.ts` to `sim/test-results/views/*.png`. Read those images, and add a pose when you touch a new area. Playwright launches Chromium with the real GPU (WebGPU works headless on macOS). Pointer lock can't be granted headless, so `e2e/controls.spec.ts` fakes `document.pointerLockElement`.

Accuracy checks belong in automated tests, not eyeballing. The pipeline compares DEM summit heights against the `landmarks` in each resort config and records the errors in the manifest. Val Thorens summits are currently within ~1–6 m.

When something renders wrong, isolate it before guessing. Tinting each terrain layer a flat colour (near vs far) quickly shows which layer, or which gap, is at fault.

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
| Elevation (DEM) | **In use (FR):** IGN LiDAR HD MNT (0.5 m), with IGN RGE ALTI (1 m) as gap fill. Others: USGS 3DEP lidar (US, ~1 m), swisstopo swissALTI3D (CH, 0.5 m), Austrian state ALS DGMs (AT, 1 m), Kartverket (NO), LINZ (NZ), GSI (JP) | **In use:** Copernicus GLO-30 DEM (30 m, a DSM that includes trees and buildings) |
| Imagery | USGS NAIP, swisstopo SWISSIMAGE, IGN BD ORTHO | Sentinel-2 (10 m) |
| Pistes, lifts, resort boundary | OpenStreetMap (`piste:type`, `piste:difficulty`, `aerialway=*`, `aerialway:*`, `landuse=winter_sports`) | OpenSkiMap (processed OSM ski data, GeoJSON exports) |
| Buildings | swissBUILDINGS3D (CH), national 3D building datasets | OSM buildings |
| Vegetation / tree line | Meta/WRI 1 m global canopy height, national forest inventories | ESA WorldCover (10 m), ETH global canopy height (10 m) |
| Lift specs (capacity, speed, manufacturer, towers) | Lift-World (lift-world.info), remontees-mecaniques.net, resort websites | OSM `aerialway:*` tags |
| Weather / snow | Open-Meteo, national weather services | — |

**IGN gotcha:** fetch from the WMS-R service (`data.geopf.fr/wms-r`) using the native Lambert-93 layers in `pipeline/src/mountain_pipeline/sources/ign.py`. The generic `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES` layer is nearest-neighbour resampled from a ~1.5" geographic grid. It returns runs of duplicated heights and produces visible stair-step artefacts.

Licensing matters. OSM is ODbL and needs attribution plus share-alike on derived databases. Check each dataset's terms before using it and record them in the provenance metadata. Never commit data whose license forbids redistribution.

## Geospatial conventions

- **Store** source data in its native CRS, cached under `data/raw/<source>/`.
- **Process** onto a per-resort transverse Mercator centred on the resort origin (`pipeline/.../frame.py`). Local east/north metres are then effectively ENU. The proj4 string goes in the manifest, and the sim converts back to lat/lon with proj4js using the same string.
- **Grids** are grid-registered with row 0 at the north edge: sample (row, col) sits at `east = west + col*cell`, `north = north - row*cell`.
- **World axes in the sim:** x = east, y = up (metres above sea level), z = **−north**. This sign flip is an easy source of bugs; see `sim/src/geo/local-frame.ts`.
- Elevations are metres above the vertical datum the source uses. Record the datum and convert explicitly; don't mix ellipsoidal and orthometric heights.
- Units are SI throughout (metres, seconds, m/s). Convert at the UI layer only.

## Repository layout

```
docs/decisions/       ADRs
data/
  raw/                Downloaded source data cache (git-ignored)
  processed/<resort>/ Pipeline outputs: manifest.json, terrain-*.bin, features.json, minimap.png (git-ignored)
  resorts/<resort>/   resort.json: origin, spawn, terrain extents/sources, landmarks (committed)
pipeline/src/mountain_pipeline/
  build.py            Orchestrates a resort build
  sources/            One module per data provider (ign, copernicus, osm)
  features.py         Lifts (stations, towers, clearance-driven synthetic towers) and buildings
  frame.py, grid.py   Local projection; grid resampling, sampling and near/far stitching
  export.py, minimap.py
sim/src/
  main.ts             Bootstrap and frame loop
  config.ts           Sim-wide tunables (time of day, fly speeds, LOD, minimap zoom)
  terrain/            Chunked LOD terrain, normal-map texture, TSL snow/rock material
  features/           Lifts (instanced towers/arms/cables/stations) and extruded buildings
  env/                Sky, sun position, lights, cascaded shadows, fog
  render/             Adaptive resolution (render scale follows frame time)
  controls/           Shared input + mouse look; fly mode; ski mode (ski-physics.ts is pure and unit-tested)
  nav/                Saved pose (localStorage, per resort) and teleport destinations
  ui/                 HUD, minimap, fullscreen world map (M), world-anchored name labels
sim/e2e/              Playwright view screenshots and control tests
```

### Terrain rendering

There are two layers. **Near** is lidar at 4 m covering the ski area. **Far** is Copernicus at 50 m out to ~60 km, so Mont Blanc is on the horizon.
- Far terrain discards fragments inside the near extent, and dips its vertices along that boundary so the near layer's skirts cover the join.
- The pipeline overwrites far samples inside the near extent with near data so the two surfaces agree.
- Each layer is split into chunks whose LOD is chosen by camera distance. Lighting comes from a full-resolution normal texture, so coarse LODs still shade with 4 m detail.

### Ski mode

`controls/ski-physics.ts` treats the skier as a point mass on the heightmap surface: gravity along the slope, snow friction, v² drag (lower when tucked), carving toward the ski direction, skid deceleration proportional to sideways slip, and airborne when the ground falls away.
- It's intentionally forgiving: no falls, a speed cap (`SKI.maxSpeed`), and no collisions with buildings or towers.
- Tune feel in the `SKI` constants and add unit tests against synthetic slopes; `e2e/ski.spec.ts` runs it on a real 21° slope above the village.
- The mode (fly/ski) is remembered in localStorage.
- Switching fly → ski keeps your position and flying velocity: if you're in the air you fall and land. Ski poses track the feet (`EYE_HEIGHT` below the camera).
- First person hides the skier's body but keeps skis and boots (`kit`) visible below the camera.
- Off-piste (per the piste lookup grid) uses higher friction and drag than groomed runs.

### Pistes

`pipeline/pistes.py` turns OSM `piste:type=downhill` ways into:
- centrelines buffered to a default width per difficulty (OSM has no widths here), plus area polygons where mapped;
- `pistes-overlay.png`: RGBA on the near terrain grid, premultiplied piste colour plus coverage, sampled by the terrain shader;
- `pistes-lookup.png`: an 8 m grid where R,G = piste index and B = difficulty, used for the HUD "RUN" row and groomed-vs-powder physics;
- `pistes.json`: run records (top, start heading, length, lines/areas) and edge-marker poles.

Difficulty codes are 1 green (novice), 2 blue (easy), 3 red (intermediate), 4/5 black, 6 freeride. Freeride itineraries (and `piste:grooming=backcountry`) count as off-piste: no overlay and no markers.

### Lifts and buildings

Both come from OSM through Overpass (`sources/osm.py`). The response is cached under `data/raw/osm/`; delete the cache to refresh.
- **Lifts:** stations sit at the way's ends and intermediate nodes become towers. `features.place_supports` adds `synthetic-tower`s wherever the straight cable would drop below the type's minimum clearance or a span is too long. Per-type dimensions live in `LIFT_PROFILES`.
- **Buildings:** OSM height tags are used when present; otherwise height is estimated from footprint area (`heightSource: "estimate"`, about 98% of Val Thorens). Ruins and roofs are skipped. Lift-station footprints replace the sim's placeholder station boxes.
- Lifts that leave the near terrain extent are skipped (logged), e.g. links into neighbouring valleys.
- **Peaks:** named `natural=peak` nodes, snapped to the highest DEM sample within 30 m. Every peak in the near extent is kept. Beyond it, only peaks of at least 3500 m (`FAR_PEAK_MIN_ELE`), so the horizon shows the big names.

### Labels

`sim/src/ui/labels.ts` draws HTML tags projected from world anchors (L / P toggle them; the choice persists in localStorage).
- Labels are hidden when terrain occludes them. A ray-march against the heightmap runs on a rolling budget, so not every label is checked every frame.
- Labels are also hidden beyond a per-kind distance, or when they'd overlap a higher-priority tag. Lifts and local peaks win; distant peaks are ranked by elevation.

### Performance notes

Measure with `pnpm perf` before and after any rendering change. In dev builds, `window.__sim` exposes `scene`, `renderer`, `camera`, `labels` and `minimap` for profiling scripts.
- **Use reversed-Z, not a logarithmic depth buffer.** Log depth writes depth from the fragment shader, which disables early-Z. With terrain overdraw that cost ~2.5× frame time (23 → 56 fps in the village view). Reversed-Z gives the same far-range precision. Anything that projects to NDC must not assume z ∈ [-1, 1] or z > 1 = behind; cull in view space instead (see `ui/labels.ts`).
- Avoid `Math.hypot` in per-sample hot loops; it's far slower than `Math.sqrt` in V8 (normal textures went from 750 ms to 177 ms).
- The terrain is GPU-bound. Shadows cost ~20%, and the far terrain about a quarter of the frame. CPU submission is ~1 ms.

Known limits:
- 4 m data looks soft at ground level, though a tiling procedural snow-detail normal map (`terrain/snow-detail.ts`) adds texture within ~400 m. Skiing will need finer tiles streamed near the camera.
- There's no texture/imagery drape yet. Snow vs rock is decided by slope.
- Pistes use default widths, so edges are approximate where OSM has no area polygon.
- Lifts are static: no chairs or cabins. Cables are straight with no sag. Building roofs are flat, and multipolygon buildings (courtyards) are skipped.

Large binaries (DEMs, imagery, meshes) are never committed directly. Generate them through the pipeline. If shared assets ever have to live in the repo, use Git LFS.

## Open decisions

These need to be settled with the user before implementation starts. Record each one in `docs/decisions/` (numbered ADRs) once made.

- Scope of simulation (free-roam skiing physics, lift operations, snow/weather, crowds)

## Working in this repo

- Ask before adding a major dependency or making a stack-level choice.
- Keep resort-specific values out of code. They belong in `data/resorts/<resort>/`.
- When you add a data source, update the table above and `docs/` with its URL, license, resolution and coverage.
