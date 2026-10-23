# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**ski-sim** is a 3D immersive simulation of real ski resorts. The goal is fidelity: a resort in the sim should match its real-world counterpart as closely as public geospatial data allows. Terrain, pistes, lifts, buildings and tree lines all come from real data, not hand-authored approximations.

Status: **playable multi-valley map.** Val Thorens (France) renders from real lidar terrain, with basic lifts and buildings from OSM, forests, rock and glaciers from ESA WorldCover, fly mode, HUD, minimap and a bluebird sky. The long-term goal is the whole Three Valleys (Val Thorens, Les Menuires, Méribel, Courchevel). Grow extents and add resorts through config.

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
uv run ski-sim init <id> --name "Name" --country FR --bbox S,W,N,E   # or --ski-area "OSM name"
uv run ski-sim build <id> [<id>...] # fetch sources (cached in data/raw), write data/processed/<id>
uv run ski-sim build --all         # every resort in data/resorts, one after another
uv run pytest                                # tests
uv run ruff check . && uv run ruff format --check .

# Sim (run from sim/)
pnpm dev               # http://localhost:5173 (serves data/processed as static files)
pnpm test              # Vitest unit tests
pnpm screenshot        # Playwright: renders e2e view poses + runs control tests (serial: workers=1)
pnpm perf              # load time + fps at fixed poses (needs pnpm dev running)
SIM_PORT=5176 pnpm screenshot   # Playwright and perf honour SIM_PORT (default 5173) for parallel worktrees
pnpm typecheck && pnpm lint
pnpm build
```

The sim needs pipeline output. Run the pipeline build first on a fresh checkout.

Useful URL params: `?resort=<id>`, `?at=lat,lon,altitude&heading=deg&pitch=deg` (jump the camera to a pose). Start pose priority: `?at=` > saved pose (written ~1/s and on page hide) > manifest spawn. Playwright gets a fresh browser context per test, so no saved pose leaks between tests. F3 in the sim shows fps, draw calls, triangles, position and sun angle.

## Verifying work

Don't consider visual work done until you've looked at it. `pnpm screenshot` renders the poses in `sim/e2e/views.spec.ts` to `sim/test-results/views/*.png`. Read those images, and add a pose when you touch a new area. Playwright launches Chromium with the real GPU (WebGPU works headless on macOS). Pointer lock can't be granted headless, so `e2e/controls.spec.ts` fakes `document.pointerLockElement`.

Accuracy checks belong in automated tests, not eyeballing. The pipeline compares DEM summit heights against the `landmarks` in each resort config and records the errors in the manifest. Val Thorens summits are currently within ~1–6 m.

### Station audit

`pnpm station-audit` (needs `pnpm dev` running; `--port` or `SIM_PORT` if it's not on 5173) renders every lift terminal from four angles (front, side, behind, top-down) into `sim/test-results/station-audit/index.html`, a contact sheet with failing stations first, plus `report.json`.
- **Failing** means a static check in `sim/scripts/station-checks.mjs` failed (a tower inside the hall, or an exit rope to the next support steeper than the pipeline allows: 18° chairs/gondolas, 25° drags, 35° cable cars, or more where the ground outside is steeper and the next tower is already at minimum height), or a `LiftSystem.check()` problem or console error names the lift. Add new checks to `CHECKS` in that module.
- **Selection:** by default it renders every failing terminal plus `--sample N` (8) passing ones. `--lift "<regex>"` renders all matching terminals; `--all`, `--failing-only` and `--limit N` are also available. Other options: `--resort <id>`, `--out <dir>`.
- **Speed:** ~0.8 s a shot. One page loads the sim once, then teleports the camera by hooking the dev-exposed camera, and falls back to a reload if the hook stops working. `--reload` forces a reload for every shot.
- **Occlusion:** side and behind views try mirrored, further-out and higher candidates and keep the one buildings hide least. Captions show how much of each view is still hidden.

### Changing the pipeline

Built resorts are snapshots of the pipeline that built them: a pipeline change reaches a resort only when it's rebuilt. Sim-only changes need no rebuild.
- **Format changes** (anything the sim reads differently: a renamed or moved field, a new required file, a changed encoding) bump `MANIFEST_VERSION` in `pipeline/.../build.py` and `SUPPORTED_VERSION` in `sim/src/resort/manifest.ts` together. The sim refuses any other version, so every resort must then be rebuilt before it loads. Take the next number after the highest on `main` *and* any open branch; two branches once both used 8.
- **Other pipeline changes** (better buildings, grading, land cover...) leave old builds loadable but without the improvement until rebuilt.
- **Rebuilding everything:** `uv run ski-sim build --all` builds every resort in `data/resorts/` in turn. It reuses the download caches, so it's processing only. A failed resort is logged and the rest still build; it exits non-zero and lists the failures at the end. Builds run one at a time on purpose: they share the caches and `resorts.json`, and each uses several GB of memory.
- **Caches** (`data/raw/<source>/`) are kept forever. OSM responses are keyed by query text, so a changed query fetches afresh; delete `data/raw/osm/` to pick up newer OSM edits. Terrain and land-cover tiles never change. A new source downloads its own tiles once.
- **Deploying a format change:** the live site reads the published data in R2, not the branch's, and a publish is live at once. Data at the new version breaks the deployed code, and new code breaks the old data, so rebuild everything, push to `main`, and run `scripts/publish-data.sh` the moment the deploy finishes (a minute or two of broken loads). Format changes that stay readable by the old code avoid that window.

When something renders wrong, isolate it before guessing. Tinting each terrain layer a flat colour (near vs far) quickly shows which layer, or which gap, is at fault.

## Deployment

GitHub Pages for the site and Cloudflare R2 for the resort data, both free (R2: 10 GB storage, no egress fees). `ci.yml` runs lint/typecheck/unit tests (sim) and ruff/pytest (pipeline); e2e needs a GPU, so it stays local. `deploy.yml` (push to `main`, or manual) builds with `SIM_BASE=/<repo>/` and `VITE_DATA_URL` from the repo variable `DATA_URL`, and publishes `sim/dist` to Pages.
- Resort data is built locally (`ski-sim build --all`) and published with `scripts/publish-data.sh [ids]` (default: every resort with a committed `resort.json`). It uploads each resort's files, then its manifest, then a `resorts.json` listing only those ids, to the R2 bucket named by the repo variable `DATA_BUCKET` (needs `npx wrangler login`). The site reads them live, so publishing needs no redeploy. Only the listed resorts show in the menu, so pass every resort you want on the site.
- Caching: manifests and `resorts.json` are uploaded `no-cache`; other files for a day, since `resortUrl` adds `?v=<manifest generatedAt>`.
- Bucket and Worker are infrastructure as code in `infra/` (`infra/setup.sh --free-plan-checked`; read `infra/README.md` first). The bucket is private: the site reads it only through the `ski-sim-data` Worker (`https://ski-sim-data.tom-pe-wh.workers.dev/`, the `DATA_URL`), so the Workers Free plan's 100,000 requests a day caps R2 reads under the free tier. Never enable the bucket's r2.dev URL or attach a domain to it, and never move the account to Workers Paid: either would make usage billable. `publish-data.sh` refuses uploads that could pass 9 GB or 20,000 files.
- Without `DATA_URL` the old path still works: the deploy bundles `resorts.tar.gz` from the GitHub `data` release into the site, and publish-data.sh uploads there when `DATA_BUCKET` is unset. Pages caps a site at 1 GB, which is why the data moved to R2.
- Asset URLs must go through `resortUrl` / `DATA_URL` (`resort/manifest.ts`), never a leading `/`: the site lives under `/<repo>/`.

## Core principles

1. **Real data first.** Every placed feature should trace back to a source dataset. When data is missing or too coarse, fill the gap procedurally, and record that it is synthetic. Never silently invent geography.
2. **Provenance is tracked.** Each resort build records which datasets (and versions/dates) it used, their resolution, and their license.
3. **Reproducible pipeline.** Raw data → processed assets must be a scripted, re-runnable pipeline. No manual edits to generated assets; fix the pipeline or add an explicit override file.
4. **Measurable accuracy.** Prefer things we can verify: lift lengths/vertical against published specs, piste lengths against the resort's own figures, summit/base elevations against official values.
5. **Resort-agnostic.** The pipeline should work for any resort given a bounding box/boundary. Resort-specific data lives in config, not code.

## Adding a resort

The whole pipeline is driven by `data/resorts/<id>/resort.json`, and only `id`, `name`, `country` and `bounds` (a lat/lon box) are required. `ski-sim init` writes that file from a bbox, or from an OSM ski-area name (matches are clustered around the largest one, because names repeat worldwide). Everything else is derived in `config.load_resort`:
- origin (bbox centre) and near extent, snapped to whole kilometres;
- far extent (55 km margin);
- terrain sources by country (FR: IGN LiDAR HD, then RGE ALTI, then Copernicus beyond the border; elsewhere: Copernicus, so any resort builds). Each source only fills the previous ones' holes, shifted to meet them and blended over a band, so there's no step at the join (`grid.fill_holes`);
- cell size, coarsened automatically to keep the grid within 8000 px for GPU texture limits;
- spawn height (150 m above the DEM);
- summit validation against every OSM peak with an `ele` tag.

Lifts, stations, signs, buildings, mountain restaurants, pistes, peaks and sounds all come from OSM, and forests, rock, glaciers and lakes from ESA WorldCover, with no per-resort code.
- **Neighbours are left out** (`territory.py`): the near terrain reaches past `bounds`, and a padded box often clips the next resort along. OSM `landuse=winter_sports` outlines centred inside our bounds are ours, the rest are neighbours. Lifts need a station on our ground and none on a neighbour's (Courmayeur's Skyway reaches Chamonix's Pointe Helbronner but is Courmayeur's), pistes need most of their points on it, and start villages and restaurants must be on it. Optional overrides: `origin`, `spawn` (lat/lon/heading/altitude), `places` (extra start villages, `{name, lat, lon}`, for a resort village OSM has no place node for), `terrain.near/far`, `minimap`, `landmarks`, `timezone` (IANA name; derived for single-zone countries in `config.TIMEZONE_BY_COUNTRY`, so set it for the US, Canada and other multi-zone countries, or it's estimated from the longitude with a warning). Then open `?resort=<id>`, or set `DEFAULT_RESORT` in `sim/src/config.ts`.

Current resorts:
- `les-3-vallees`: Val Thorens, Orelle, Les Menuires, Saint-Martin, Méribel incl. Mont Vallon, Courchevel.
- `arlberg`: St. Anton, St. Christoph, Stuben, Zürs, Lech, Warth, Schröcken, plus Sonnenkopf. Copernicus terrain until an Austrian lidar source exists.
- `tignes-val-disere`: Tignes (Le Lac, Val Claret, Le Lavachet, Les Boisses, Les Brévières) and Val d'Isère (La Daille, Le Fornet), with the Grande Motte and Pissaillas glaciers. Bounds from OSM's ski-area outline; Paradiski to the west and Sainte-Foy to the south are left out.
- `grand-domaine`: Le Grand Domaine: Saint-François-Longchamp, the Col de la Madeleine, Doucy and Valmorel. Valmorel's resort village has no OSM place node, so it's added with `places`. Les 3 Vallées next door is left out.
- `paradiski`: La Plagne (incl. Montalbert, Champagny, Montchavin–Les Coches) and Les Arcs (incl. Peisey-Vallandry, Villaroger), linked by the Vanoise Express. Tignes and La Rosière next door are excluded.
- `everest`: Mount Everest, Lhotse, Nuptse and the Khumbu valley to Kala Patthar (the spawn, looking at the summit). Copernicus terrain and WorldCover glaciers; OSM has no lifts or pistes there, so it's a fly / glide / ski-anywhere map with no start villages. The 30 m DSM rounds off the sharpest summits (Everest is ~115 m low).
- `chamonix`: Le Tour / Balme and Vallorcine, Grands Montets, Brévent–Flégère (and the Liaison), Les Houches (Prarion / Bellevue), the valley areas (Savoy, Planards, La Vormaine, Le Tourchet, La Poya), the Aiguille du Midi and the Panoramic Mont-Blanc to Pointe Helbronner. Saint-Gervais / Megève, Courmayeur's Skyway and the Swiss side are excluded. The near terrain reaches Mont Blanc's summit (lidar, 0.4 m low); Switzerland and Italy are Copernicus, so the sharp Italian spires (Brenva, Grand Pilier d'Angle) are 200–250 m low.
- `romme-alpin` (SE), `niseko` (JP: Hirafu, Hanazono, Village, Annupuri), `whistler-blackcomb` (CA), `park-city` (US: Park City Mountain incl. Canyons; Solitude over the ridge is cut off by the west edge), `snow-space-salzburg` (AT: St. Johann-Alpendorf, Wagrain, Flachau, plus linked Kleinarl and Zauchensee), `grandvalira` (AD), `garmisch-zugspitze` (DE), `oberstdorf-kleinwalsertal` (DE/AT: Nebelhorn, Fellhorn–Kanzelwand, Söllereck, Ifen, Walmendingerhorn, Heuberg), `zermatt` (CH/IT: Zermatt with Cervinia and Valtournenche), `portes-du-soleil` (FR/CH). Added from config alone, with no checks beyond one overview view each. All but Portes du Soleil are Copernicus terrain, so sharp summits come out low (Matterhorn ~195 m, Garmisch's Wetterstein 10–85 m); a national lidar source per country would fix it. Portes du Soleil is IGN lidar on the French side and Copernicus on the Swiss side. Niseko's start points are named after Hirafu's street blocks ("Niseko-Hirafu-1-jo 4-chome"), which OSM maps as places.
- `verbier-4-vallees` (CH: Verbier, Le Châble, La Tzoumaz, Nendaz, Veysonnaz, Thyon, Mont Fort), `st-moritz` (CH: Corviglia, Corvatsch–Furtschellas, Diavolezza–Lagalb, Muottas Muragl; OSM splits them into separate ski areas, so the bounds are set by hand), `ischgl-samnaun` (AT/CH: Silvretta Arena), `soelden` (AT: Giggijoch, Gaislachkogl, the Rettenbach and Tiefenbach glaciers), `les-2-alpes` (FR, IGN lidar), `alpe-dhuez` (FR: Alpe d'Huez, Auris, Oz, Vaujany, Villard-Reculas), `sella-ronda` (IT: Val Gardena, Alta Badia, Arabba, Val di Fassa round the Sella; 173 lifts), `kitzbuehel` (AT: KitzSki incl. Kirchberg, Jochberg and Pass Thurn; the south edge leaves out Wildkogel), `vail` (US), `jackson-hole` (US: Teton Village). Also from config alone (`--ski-area`), checked with one overview view each.

### Interface design (Glacier)

One design system, two glass modes (`ui/theme.css`): **dark glass in the world, light glass in menus.** If you're skiing it's dark (`#hud`: compass tape, minimap card, quick toggles, run chip, stat strip, prompts, world labels), because dark reads best over bright snow. If you've stopped to choose something it's light (`#overlay` main/pause menu, the `#options` hub, the world map), frosted over the scene. A container's class (`.glass-dark` / `.glass-light`) sets the custom properties every component reads (`.glass`, `.tiles`, `.btn`, `.setup-options`, `.switch`, `.lab`, sliders). Radii 8 (panels) / 6 (controls) / 4 (chips). Geist for words and Geist Mono for every number, self-hosted in `sim/src/fonts/` (SIL OFL, licence alongside). Orange is reserved for best times; piste colours appear only as small squares.
- **Glass behind glass:** `backdrop-filter` on an ancestor (or `opacity` < 1) makes it a backdrop root, so a panel inside it blurs nothing. The menu's scene blur is therefore on `#overlay::before`, not `#overlay`.
- **Display settings** (`ui/display-settings.ts`, pure, unit-tested; `ski-sim.display`): glass strength (full / light / tint only, for slow GPUs) as `data-glass` on `<html>`, and `--ui-scale` (the window height ÷ 900, clamped 0.85–1.3, × the player's choice) applied with CSS `zoom` on the HUD, menu, hub and map panels.
- The menu backdrop before any map is loaded is a frame from the sim (`sim/src/assets/menu-backdrop.jpg`); with a world loaded (`body.world`), the live scene shows through.

### Menus and navigation

The overlay (`ui/main-menu.ts`, light glass) shows one screen at a time, kept on a stack (`ui/screens.ts`, pure, unit-tested): **Esc or the ← in the top-left corner goes back one screen**, and the ← says where to. Every screen has one main action (Enter does it too).
- **Title** (main menu): centred over the backdrop, no header bar. First visit: Play, Multiplayer, Ski setup, Options. Returning (`ski-sim.resort` set): a Continue card (that area's preview, "Where you left off · 2,412 m") and Continue lead, then "Choose a resort"; Continue goes straight to loading at the saved pose. Controls sits small in the corner.
- **Resorts:** every area from `data/processed/resorts.json` as a card (name, country, lifts, runs, `preview.jpg`), sorted by name, filtered by a search box (name, country or village) and a country menu, so it scales to hundreds. The highlighted area's map, numbers and start villages sit on the right, with "Choose start point →".
- **Resort (start points):** the area's `bases` (highest first) beside its preview map with a pin for each, framed on them (`frameStarts`, `startsAspect`; the panel takes the starts' shape). A link's `start=` preselects one; "Where you left off" is offered when there's a saved pose. The button says what it'll do: "Ski from <start>", "Host from <start>" (after Multiplayer → Host), or, for the area already loaded, "Go to <start>" (a teleport, no reload). Another area while one's loaded asks "Leave <area>?" (`#confirm`), then reloads with `?resort=<id>&start=<name>`.
- **Loading:** full screen, one card at the bottom: area · start, stage ("Downloading map data · 48 MB", building terrain, forests, lifts, graphics), progress and a tip. When it's ready you go straight into the world (no "ready" screen): the HUD shows with a small "Click to play" chip (`#click-to-play`, `body.entering`), and a click anywhere or Enter captures the mouse (pointer lock needs that gesture). Errors show with "Try again"; ← Cancel goes back to a fresh menu. A link naming a resort, game or pose (`?resort=`, `?join=`, `?at=`) skips straight here, which the tests rely on.
- **Pause** (Esc in game): Resume, Map, Change start point, Change resort, Multiplayer, Options, Main menu (confirms first). Shows the game code when you're in one. The Esc that releases the mouse isn't taken as a "back".
- **Multiplayer:** its own screen (from the title, Pause or N), no longer an Options tab. Before a map's loaded, Host goes to Resorts to choose where (then `?host=1` hosts once it's ready) and Join loads the game (`?join=`; a guest on another area reloads into the host's).
- **Options** stays an overlay over any screen (G / T / O open their tab).
- **Start at:** the resort's `bases`, which the pipeline finds automatically (`bases.py`). A base is an OSM town or village with lift bottom stations within 700 m, ranked villages first. Each start point is placed 9–32 m from its main lift's bottom station, clear of buildings, facing up the lift, so the E prompt is live on arrival.
- **Preview:** the pipeline writes `preview.jpg` beside `minimap.png` (the same image and extent, 1024 px on its long side, ~250 kB) for the menu's cards, preview and start-point map; nothing heavier loads before you choose.

Scaling notes for big areas (learned on the 3 Vallées):
- Anything turned into a texture must stay under 8192 px a side. The terrain cell size auto-coarsens for this, and the lift-sign atlas is a square grid. The view tests fail on any console error, so they catch a GPU validation error.
- Lift carriers are drawn only within 3.5 km of the camera, packed into the instance buffer each frame. Tiny parts (sheaves, bullwheels) cast no shadows: thousands of instances × 3 shadow cascades was the biggest cost.
- Label priority: lifts beyond 3 km yield to peaks; 4000 m+ horizon peaks always win.

## Geospatial data sources

Use the best available source for the region; fall back to global datasets.

| Layer | High-res regional | Global fallback |
|---|---|---|
| Elevation (DEM) | **In use (FR):** IGN LiDAR HD MNT (0.5 m), with IGN RGE ALTI (1 m) as gap fill and Copernicus beyond the border. Others: USGS 3DEP lidar (US, ~1 m), swisstopo swissALTI3D (CH, 0.5 m), Austrian state ALS DGMs (AT, 1 m), Kartverket (NO), LINZ (NZ), GSI (JP) | **In use:** Copernicus GLO-30 DEM (30 m, a DSM that includes trees and buildings) |
| Imagery | USGS NAIP, swisstopo SWISSIMAGE, IGN BD ORTHO | Sentinel-2 (10 m) |
| Pistes, lifts, resort boundary, national borders | OpenStreetMap (`piste:type`, `piste:difficulty`, `aerialway=*`, `aerialway:*`, `landuse=winter_sports`) | OpenSkiMap (processed OSM ski data, GeoJSON exports) |
| Buildings | swissBUILDINGS3D (CH), national 3D building datasets | OSM buildings |
| Land cover (forest, bare rock, glaciers, water) | Meta/WRI 1 m global canopy height (not yet: no overviews, ~375 MB tiles), national forest inventories | **In use:** ESA WorldCover 10 m 2021 v200 (CC BY 4.0, global COGs on AWS, windowed reads; see ADR 0003) |
| Lift specs (capacity, speed, manufacturer, towers) | Lift-World (lift-world.info), remontees-mecaniques.net, resort websites | OSM `aerialway:*` tags |
| Weather / snow | Open-Meteo, national weather services | — |

**IGN gotcha:** fetch from the WMS-R service (`data.geopf.fr/wms-r`) using the native Lambert-93 layers in `pipeline/src/ski_sim_pipeline/sources/ign.py`. The generic `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES` layer is nearest-neighbour resampled from a ~1.5" geographic grid. It returns runs of duplicated heights and produces visible stair-step artefacts.
- Off its coverage the lidar layer returns -9999 (not a declared nodata), blended into the next pixel or two (-8000 m beside 4000 m). `grid.mask_nodata` treats anything below -500 m as nodata, plus a 2 px fringe.
- RGE ALTI never has holes: beyond France it carries on with a coarse foreign fill, hundreds of metres low on sharp summits. Its source mask (`RGEALTI-SRC`, a styled RGB image) paints that fill magenta, and `ign.foreign_mask` turns it into nodata.
- The service sometimes drops a connection mid-tile; `http.download` checks Content-Length so a truncated GeoTIFF is retried, never cached.

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
  processed/<resort>/ Pipeline outputs: manifest.json, terrain-*.bin, features.json, minimap.png, preview.jpg (git-ignored)
  resorts/<resort>/   resort.json: origin, spawn, terrain extents/sources, landmarks (committed)
pipeline/src/ski_sim_pipeline/
  build.py            Orchestrates a resort build
  sources/            One module per data provider (ign, copernicus, osm, worldcover)
  features.py         Lifts (stations, towers, clearance-driven synthetic towers) and buildings
  pistes.py, parks.py Runs of every type, overlay/lookup/lit rasters, floodlights; generated snow park layouts
  frame.py, grid.py   Local projection; grid resampling, sampling and near/far stitching
  landcover.py        Forest / rock / ice / water coverage textures, tree clearings, tree line
  export.py, minimap.py
sim/src/
  main.ts             Bootstrap and frame loop
  config.ts           Sim-wide tunables (simulated day, fly speeds, LOD, minimap zoom)
  terrain/            Chunked LOD terrain, normal-map texture, TSL snow/rock material
  features/           Extruded buildings
  landcover/          Land cover texture; trees placed from it (instanced LODs, collisions)
  lifts/              Lift operation model, carriers, lift system (statics + moving carriers), riding
  env/                Sky, sun position, time-of-day clock, lights, cascaded shadows, fog
  parks/              Snow park surfaces (height, normals) and their meshes
  render/             Adaptive resolution (render scale follows frame time)
  controls/           Shared input + mouse look; fly mode; ski mode (ski-physics.ts and ski-setup.ts are pure and unit-tested);
                      paraglider and snowmobile (glider-physics.ts, snowmobile-physics.ts likewise)
  nav/                Saved pose (localStorage, per resort) and teleport destinations
  net/                Multiplayer: state codec, interpolation, host/guest session, transports, remote players
  ui/                 Theme (theme.css), HUD, main/pause menu, options hub and its tabs, minimap,
                      fullscreen world map (M), world-anchored name labels
                      (HUD: a small compass tape top centre with the guide marker; top right the minimap
                      card with the time and coordinates under it, then the quick toggles; bottom left the
                      run above the stat strip: mode · speed, altitude, slope. Key help lives in
                      Options → Controls.)
sim/e2e/              Playwright view screenshots and control tests (parks.spec.ts: kicker air, halfpipe air, park and night views)
```

### Terrain rendering

There are two layers. **Near** is lidar at 4 m covering the ski area. **Far** is Copernicus at 50 m out to ~60 km, so Mont Blanc is on the horizon.
- Far terrain discards fragments inside the near extent, and dips its vertices along that boundary so the near layer's skirts cover the join.
- The pipeline overwrites far samples inside the near extent with near data so the two surfaces agree.
- Each layer is split into chunks whose LOD is chosen by camera distance. Lighting comes from a full-resolution normal texture, so coarse LODs still shade with 4 m detail.

### Touch / mobile

Phones and tablets play by touch; desktop is unchanged. Everything goes through the same `Input` the keyboard drives, so there's no separate physics.
- **Detection** (`controls/touch-input.ts`, pure, unit-tested): touch when the primary pointer is coarse and there are touch points (`detectTouch`; never the user agent; `?touch=1` / `?touch=0` force it). `nextKind` switches live: a real mouse click or a key (not typed into a field) gives keyboard and mouse, the next finger gives touch back. `body.touch` marks it, for the menus too (`.touch-only` / `.desktop-only`).
- **No pointer lock on touch.** `Input.lock()` sets a playing flag instead and dispatches `pointerlockchange`, so everything that listens for pointer lock (body `flying`, the pause menu) works unchanged; `Input.unlock()` pauses (the ⏸ button top left, or putting the phone away). After loading it's "Tap to play" (`onPlay(choice, auto)`: auto never captures, so sound can start on the tap).
- **Controls** (`controls/touch-controls.ts`, `#touch` in index.html, under the HUD so tappable prompts win): a thumbstick wherever the left thumb lands (`stickVector`, dead zone, base follows a runaway thumb), look-drag on the right half (`TOUCH_LOOK_GAIN` × the mouse sensitivity). The stick sets `Input.stickX/Y`, read through `Input.turn`, `forward` and `throttle` (keys or stick, analog), plus per-mode keys (`stickKeys`: ski forward skates, back ploughs; glider bar/brakes; sled back brakes). Context buttons bottom right show per mode (ski: Jump, Tuck, Stop — a hockey stop with the stick sideways, else a plough (`stopKey`); in the air Front flip / Backflip; fly: Up, Down, Faster, Slower; sled: Hang off; lift: Fast, Skip, Off). Tools: map, fly, paraglider, snowmobile, view, labels (all three name kinds at once), fullscreen — a row along the bottom in landscape, a column on the right in portrait.
- **Key actions** live in one `act(code)` in main.ts, called by the keydown handler, the buttons, and any `#hud [data-key]` element (the "Ride …" / "Get back on the snowmobile" prompt, fly mode's ways out). Prompts name no keys on touch.
- **Map** (`ui/world-map.ts`): drag pans, pinch zooms about the fingers (`pinchScale`), tap drops the marker, touch and hold (`PRESS.longMs`) teleports (`classifyPress`); the readout floats above the finger while held. The panel is a bottom sheet on a narrow screen.
- **Layout:** the HUD is zoomed by `--ui-scale`, so touch offsets that line up with the unzoomed controls divide by it, as do minimum tap sizes in the menus. Phones may scale down to 0.7 (`uiScale` with the width). Narrow screens (≤ 760 px) get single-column menus (resorts grid over a compact preview, start map over the list, Options tabs as a scrolling row); short ones (≤ 500 px) scroll and slim the panels. `env(safe-area-inset-*)` throughout, `viewport-fit=cover`, no pinch zoom, callouts, double-tap zoom or overscroll. A dismissable "turn sideways" hint on upright phones.
- **Quality** (`render/quality.ts`, unit-tested): fixed at start-up from the device. Desktop is exactly the old settings. Touch: pixel ratio ≤ 1.5 (adaptive down to 0.75), no MSAA, 1024 px shadow maps over 2 cascades to 12 km, trees and terrain LOD distances × 0.6, and the lighter glass by default. Three picks WebGL 2 when there's no WebGPU (`?webgl=1` forces it).
- **Tests:** `e2e/mobile.spec.ts` emulates an iPhone 14 on Chromium (WebGPU) and drives real multi-touch through CDP (`Input.dispatchTouchEvent`): stick, look, jump/tuck/stop, pause, pinch and long-press on the map, Ride and Skip on a chairlift, fly/glide/sled buttons, and the menus at portrait, landscape and tablet sizes. Screenshots go to `test-results/mobile/`.

### Ski mode

`controls/ski-physics.ts` treats the skier as a point mass on the heightmap surface: gravity along the slope, snow friction, v² drag (lower when tucked), carving toward the ski direction, skid deceleration proportional to sideways slip, and airborne when the ground falls away.
- It's intentionally forgiving: the only falls are botched flip landings, there's a speed cap (`SKI.maxSpeed`), and no collisions with buildings or towers.
- Tune feel in the `SKI` constants and add unit tests against synthetic slopes; `e2e/ski.spec.ts` runs it on a real 21° slope above the village.
- The mode (fly/ski) is remembered in localStorage.
- Landing from fly mode (R, or F with no body waiting) puts you on the ground below, standing still (no flying momentum). Other switches (glide → ski, sled → ski) keep your momentum. Ski poses track the feet (`EYE_HEIGHT` below the camera).
- Ski keys: W skate, Ctrl toggle tuck (W or Shift stands you up), Shift snowplough, A/D or mouse steer, Space jump, [ / ] lean forward / back (flips in the air), V camera. Holding S locks the upper body/view and makes A/D swing only the skis (pivots, hockey stops). Grip scales with cos²(slip angle), so sideways skis skid instead of steering.
- `controls/ski-stance.ts` (pure, unit-tested) turns what the skier is doing into a pose: carve edge angle from speed × path turn rate (atan(a/g), capped at 60°), plough wedge, alternating V-skate strides, tuck crouch. `controls/ski-model.ts` builds the skier (sidecut/rocker ski geometry with orange tips and tails (white vanished against the snow), bindings; boots from side profiles extruded with rounded edges (`bootPiece`: sole with lugs, shell, forward-leaning cuff, power strap, buckles), the cuff hinged at the ankle so it leans with the shin (fore and aft only, -0.25 to +0.55 rad); poles with a moulded lathe grip, wrist strap and a gloved fist (fingers, thumb, gauntlet); shell jacket, helmet, mirrored goggles) and applies the pose. Legs and arms use two-bone IK (`solveJoint`): ankles are pinned inside the boots so legs follow the skis in every stance, and hands follow the torso and carry the poles.
- First person hides the body (`body`) but keeps skis, boots and poles visible below the camera.
- Balance: the body aligns with gravity plus the skier's smoothed acceleration (the force the snow pushes back with), not the slope normal. That gives upright shoulders on a traverse, leaning into carves, and leaning uphill in a hockey stop. The ski edge angle is that balance line's tilt across the skis relative to the slope (`balanceEdge`).
- V (first/third person) works in every mode but fly and is remembered. Third person is the default; Options → Display has a "First person" switch.
- **Fly mode is out of body** (`body` in `main.ts`): F from skiing, gliding or the snowmobile leaves that skier frozen where it was (its controller isn't updated; `showFrozen()` draws it whole) and you fly as a free camera with no body and no first/third person (`FlyControls` is camera only). The skier gets a white "Your skier · 840 m" tag (`ui/body-marker.ts`, pinned to the screen edge when out of view) and a white dot on both maps. F goes back into it, moving as it was; R ("Ski from here") or any other way out (P, B, E onto a lift, a map teleport, J, a start point) drops it and you carry on from where you are. The ways out are always on screen above the fly speed (`#fly-keys`). F does nothing on a lift. A reload while flying has no body to go back to, so F then just lands you. Fly mode is silent (no wind). The set fly speed (default 60 m/s, 2–1500 m/s with the mouse wheel; no sprint) is shown at the bottom of the screen.
- e2e tests use a frozen lake at 45.28856, 6.5752 (under 15 cm of relief over 100 m) as flat ground.
- Off-piste (per the piste lookup grid) uses higher friction and drag than groomed runs.
- Take-off: you leave the snow when your ballistic path `SKI.liftLook` (0.06 s) ahead is more than `liftGap` (15 cm) above the snow there (a kicker's lip), or a step drops more than `airThreshold`. Snapping to the snow each step alone only ever lets go at cliffs. `SkiTerrain.normal` (optional) supplies a finer normal than the default 2 m finite difference; snow parks use it. On walls steeper than `peelFrom` (45°) you also leave when the snow you step onto turns away from your path faster than `peelSpeed` (a halfpipe's coping, where the look-ahead sees the wall rising as fast as you); on ordinary slopes that would bounce you off every lidar crease. Leaving a wall steeper than `vertAngle` (70°), or one ridden in the last `vertMemory` s, sends you straight up: your motion across the coping is replaced by a `vertDrift` (0.35 m/s) back into the pipe, so you land on the transition. On walls steeper than 40–55° `skiDirection` blends from projecting the yaw along the normal to projecting it straight down, so a diagonal line up a near-vertical wall stays diagonal; ordinary slopes are unchanged.
- W by speed: below ~16 km/h it skates (or walks or climbs, with footstep sounds under 9 km/h); above that it double-poles (`ski-stance` pole cycle plus `SKI.poleAccel`, up to ~32 km/h) with pole-plant sounds. Stance animation emits `step`/`plant` events and the controller exposes them as `footstep`/`polePlant` for audio.
- Skating (W below skating speed) holds your edges: sideways slip is cancelled, so you can skate along a traverse instead of being pinned by the side slope.
- Walking uphill: with W held and the skis pointing up a slope too steep to skate, `stepSki` switches to climbing (herringbone): ~1.3 m/s on gentle grades, down to 0.35 m/s on steep ones, never stuck. Releasing W lets you slide back.
- Flips: `[` / `]` lean forward / back. On the snow that's a visible stance lean (`Stance.foreAft`) and a subtle physics effect: forward bites into turns a little sooner, back floats in powder. In the air, holding one builds pitch rate (`SKI.flipRate`, ramping at `flipAccel`); let go and the rotation eases off while you spot the landing, turning the skis toward the slope below at up to `spotRate`. `SkiState.pitch` is unwrapped, so `(pitch - takeoffPitch) / 2π` counts rotations. Touchdown compares the skis' pitch to the slope: within `landClean` (15°) you ski on, up to `landTolerance` (35°) costs speed, beyond that you crash (`SkiState.crash`: slide to a stop over ~1.8 s, swing round to face downhill, then stand up; no controls meanwhile). `SkiState.landing` reports `{ flips, error, outcome }` for the step you land in (no on-screen text: flips and crashes speak for themselves).
- The skier model turns about its centre of mass (`COM_HEIGHT` above the feet) during a flip. The balance line (`bodyUp`) is measured against the slope-aligned frame without the flip, so the whole body rotates. In first person the camera swings round the same point and pitches with the flip; on landing it's back to the mouse look. `e2e/flips.spec.ts` launches the skier off the frozen lake (`ski.place` with an upward velocity), freezes it in-page on the exact frame for mid-flip screenshots, and releases keys in-page too (Playwright round trips take 50°+ of rotation).
- **Guide marker:** on the map (M), left click drops a marker (click it again to remove) and right click teleports. The marker is saved per resort (`nav/waypoint.ts`, pure and tested: storage and `placeOnScreen`, which pins off-screen points to the screen edge in their direction). In the world it's a light beam that stays a few pixels wide at any distance, plus a pin with distance and height difference (`ui/waypoint-marker.ts`), and an orange dot on the minimap (on its edge when out of range). Shift+M drops it where you are. J teleports to it; while one is set, a panel under the display toggles shows its distance and the J hint.
- Map teleports always land you on the ground (`groundedPose`, eye height above the DEM), aimed at the summit for peak destinations. You're placed at once (so terrain loads there), while the camera does a GTA V-style switch (`nav/sky-transition.ts`, `skyPose` is pure and tested): three jump-cuts up to ~2.4 km looking straight down, a pan across, three cuts down, then a swoop into your view. Desaturated, with a flash and whoosh per cut, HUD hidden; controls are frozen until it lands.

### Ski setup

G (or the menu's "Ski setup" button) opens the Ski setup tab of the options hub (`ui/ski-setup-menu.ts`) with presets (Slalom race, Giant slalom, All-mountain, Freeride / powder, Park) and real ski properties: length, waist, sidecut radius, flex, camber/rocker profile, wax, edge tune and binding mount. Persisted as `ski-sim.ski-setup`.
- `controls/ski-setup.ts` (pure, unit-tested) turns a setup into `SkiHandling`: friction, powder float, carve rate, hard-snow grip, skid deceleration, stable speed (chatter above it), speed cap, and multipliers for A/D turning, S-pivots and edge-to-edge speed. `stepSki` takes the handling as an argument; there are no globals.
- The All-mountain preset is the reference: it maps onto the base physics (handling multipliers of 1; only the chatter above ~100 km/h is new), so tuning `BASE_HANDLING` moves every ski together. Keep extremes playable: `ski-setup.test.ts` checks the speed cap, minimum carving and turn rates at both ends of every slider.
- The model's skis follow the setup (`skiDimensions`): length, waist, tip/tail widths from the sidecut radius, rocker rise, and the mount point (~3.5% of the length behind centre). The default 178 cm ski is about chin height on the 1.83 m skier.
### Options hub

Every menu is a tab of one native `<dialog>` (`#options`, `ui/options-hub.ts`): Camera (O), Display, Controls, Ski setup (G), Time of day (T) and Data & credits (Multiplayer is its own menu screen). Each menu class extends `OptionsTab`, whose panel is a `<section class="hub-panel" id="opt-…">`; `open()` shows the hub on that tab and `toggle()` (its hotkey) closes the hub if it's already there. Esc and backdrop clicks close it; ↑/↓ move between tabs. Time of day (`data-needs-map`) is disabled until a map is ready. While the hub is open, game keys other than G, T and O are ignored.
- **Display** (`ui/display-menu.ts`): switches for the world toggles (1–4, V, K; `data-toggle`), glass strength and interface size.
- **Quick toggles** (`DISPLAY_TOGGLES` in `ui/hud.ts`: H HUD, V first person, 1–4, K sound) are listed small down the right under the minimap (`#toggles`), lit when on and briefly highlighted when their key is pressed. V is hidden while flying (no body). H is full immersion: it hides everything that isn't the real world (HUD, world labels, crosshair, guide-marker beam, piste colours) and restores it all when shown again.
- **Data & credits** (`ui/credits.ts`): every dataset in the manifest's provenance with its licence and attribution. This is the only place the credits appear: none on the game screen or the menus.

### Camera settings

The Camera tab (`ui/settings-menu.ts`) has field of view, separately for first person (default 85° vertical) and third person (70°), speed widening (+10° at full speed skiing/sledding; 0 turns it off), mouse sensitivity, invert Y and third-person distance. `controls/camera-settings.ts` (unit-tested) holds the live `cameraSettings` every controller reads (`Look.apply`, each chase camera), clamps stored values and persists them as `ski-sim.camera`. Add new camera/view preferences there.

### Time of day

The time shows under the minimap (with the clock speed unless it's real time). T (or the menu's "Time" button) opens the Time of day tab (`ui/time-menu.ts`): a 00:00–24:00 slider, presets and the clock speed (paused, real time, ×10, ×60, ×600). Persisted as `ski-sim.time-of-day`.
- `env/time-of-day.ts` (pure, unit-tested) is the clock: advance by dt × rate, wrap at midnight. Times are local clock times on `SIM_DAY` (config: date and UTC offset); `simDate` turns them into an instant for `sunPosition`. The offset is the resort's: the pipeline writes `manifest.timezone` (zone name and its UTC offset on that day), and main.ts sets `SIM_DAY.utcOffsetHours` from it (UTC+1 for older builds without one).
- Presets come from the real sun for the resort (`dayPresets`): sunrise and sunset when it's 3° up, midday at its highest, morning and afternoon halfway, night at 22:00.
- `Environment.setTime` moves the sky's sun, the shadow-casting light and sets light levels (`daylight`, unit-tested). The light never comes from below 2°, and fades out by sunset. At night a blue hemisphere "moonlight" (0.5) keeps the slopes readable; the Preetham sky goes black.

### Multiplayer

Free peer-to-peer play with no server of ours. N (or Multiplayer on the title or pause screen) opens the Multiplayer screen (`ui/multiplayer-menu.ts`): name (`ski-sim.player-name`), Host (a 6-character code from an unambiguous alphabet, plus an invite link `?resort=<id>&join=CODE`), Join, the player list with "Go to", and Leave. `net/multiplayer.ts` ties the session, dialog and remote players to the sim. main.ts only feeds it the local avatar, the clocks and a teleport.
- **Transport** (`net/transport.ts`): Trystero over WebRTC data channels. It signals through public Nostr relays (Trystero's own maintained list, seeded by our appId) and Google's public STUN. There's no TURN, so strict networks can fail. It's imported dynamically on Host/Join, so the sim touches no network otherwise; the view tests fail on any console error. Rooms are global by code. The host's `hello` carries its resort, and a guest on another resort reloads there with the same `?join=`.
  - A dead relay logs a WebSocket error in the console while you're in a game; the other relays carry the connection.
  - `?net=loopback` swaps in a BroadcastChannel transport, so pages in one browser connect with no network. `e2e/multiplayer.spec.ts` uses it with a host page and a guest page.
  - Tested by hand over the real relays: the guest connected in ~5 s.
  - Why Trystero, not PeerJS: it needs no signalling server at all (PeerJS depends on its free cloud broker staying up) and spreads over several relays, so one going down doesn't stop a game.
- **Host relays** (`net/session.ts`, unit-tested with an in-memory hub). Trystero joins everyone mesh-style, but guests only talk to the host and ignore other peers. The host sends one batch of everyone's latest state (`encodeBatch`) about 12 times a second.
  - The host owns the roster (player numbers 1–15, max 16 players) and turns away the 17th.
  - Peers silent for 5 s are dropped. A guest that loses the host, or gets `end`, sees why in the dialog. A code nobody hosts gives up after 20 s.
  - Bump `NET_VERSION` when the wire format changes.
- **State** (`net/codec.ts`, 98 bytes; out of body, the state is the frozen skier with `Flag.Spirit` and the flying position in `SLOT.spirit`, so others see both, the flyer as a see-through `Pegman`): sender time, mode, flags, float32 position, then int16 velocity, the model root's quaternion, the body's balance line, the whole `Stance` (skis, crouch, lean, phases, sit, grip) and two extras (glider bank / sled steer, suspension).
  - `net/local-avatar.ts` reads these from whichever model the mode shows; `SkierModel` remembers its last `apply` for this. Remote skiers therefore carve, plough, flip, crash and sit on chairs exactly as the local one.
- **Interpolation** (`net/interpolation.ts`): 100 ms behind on the local clock. The per-player offset is the fastest delivery seen, relaxed slowly, so jitter doesn't show. After the newest sample it extrapolates along the velocity for up to 0.5 s. Mode changes and teleports jump; they never glide.
- **Remote players** (`net/remote-players.ts`): models are built per mode on first use (a `SkierModel`, `createGliderRig`, `createSnowmobile` with a seated rider, or a `Pegman`). There's a coloured name tag (terrain-occluded, one ray-march per frame round robin) and a minimap dot, pinned to the rim when off the map.
- **Shared world:** the host's time of day and lift clock (`SharedClock`). The host broadcasts it every second and on every time change; guests ping every 2 s and advance it by RTT/2.
  - The guest's time menu is locked with a hint, and its time isn't saved.
  - The lift clock slews toward the host's (snaps if over 2 s off), so chairs line up. Lift fast-forward (`RideControls.fastForward`) is off in a game, because the lift clock is shared.

### Pistes

`pipeline/pistes.py` turns OSM piste ways into:
- centrelines buffered to a default width per difficulty or type (OSM has no widths here), plus area polygons where mapped;
- `pistes-overlay.png`: RGBA on the near terrain grid, premultiplied piste colour plus coverage of every kept run, sampled by the terrain shader. Unprepared routes (freeride, touring, walking) are drawn too, dashed like on the map (`DASH`/`DASH_GAP`; a mapped unprepared area is a light wash). Their RGB must sit under a non-zero alpha: browsers decode PNGs premultiplied, so colour under alpha 0 is lost;
- `pistes-ungroomed.png`: greyscale on the same grid, the unprepared share of that coverage. The shader takes groomed = overlay A − this (smooth, brighter corduroy only on groomed snow). Optional in the manifest: older builds' overlay only covered groomed runs;
- `pistes-lookup.png`: an 8 m grid where R,G = piste index and B = difficulty (low nibble, 0 none) | type code << 4 (`RUN_TYPES`; downhill is 0, so its B is just the difficulty). Used for the HUD "RUN" row and groomed-vs-powder physics; `PisteLookup.codeAt` decodes it;
- `pistes.json`: run records (type, top, start heading, length, ref, oneway, lit, lines/areas/tunnels), edge-marker poles, park layouts and floodlight masts.

Difficulty codes are 1 green (novice), 2 blue (easy), 3 red (intermediate), 4/5 black, 6 freeride. Freeride itineraries (and `piste:grooming=backcountry`) count as off-piste: dashed on the snow, no markers, powder physics.
- **Run types** (`RUN_TYPES`, first known value of a multi-valued `piste:type`): `downhill`, `snow_park` (orange), `sled`, `nordic` (thin), `playground`, `skitour` and `hike` (unprepared: dashed on the snow and the minimap, powder physics), `connection` (grey, or its difficulty colour). Other types default to no difficulty. Edge markers line only downhill runs and connections. The HUD row shows `runLabel`: ref + name, plus the type for non-downhill runs (and "one-way").
- **Bridges and tunnels** (`bridge`/`tunnel` other than `no`; a bare `layer` > 0 is a bridge, < 0 a tunnel): kept out of a piste's `lines` (in `bridges`/`tunnels`), so they're never graded. Tunnels are also left out of the overlay and lookup (the snow above isn't the run) and drawn dashed on the minimap.
- **Floodlit runs** (`lit`/`piste:lit` other than `no`, only `FLOODLIT_TYPES`; a lit street or footpath has street lamps): masts every 40 m alternating sides, 3 m outside the edge, and `pistes-lit.png`, a glow mask on its own 4 m grid (manifest `pistes.lit`) with a pool round each mast's aim point, clipped to the run plus 8 m. The terrain shader adds it as warm emissive × `Environment.floodlights` (`daylight().floodlights`: on as the sun sets); lamp heads glow by the same uniform (`pistes/floodlights.ts`). No real lights.

### Snow parks

OSM maps where a park is, not what's in it, so `pipeline/parks.py` designs a layout per `snow_park` area or line, deterministically from its geometry, name, difficulty and the terrain, and marks it `synthetic` (manifest `pistes.parks`):
- **Spine:** the fall line through the area (or its long axis if that's much longer), or the mapped line, oriented downhill. Features keep 2 m inside the outline and clear of buildings, lift lines (`blocked`) and each other (`_Placer`, footprints include run-out to land). `footprint(f)` gives any feature's ground outline.
- **Halfpipe** (`_halfpipe`): one superpipe in parks 60 m+ wide that aren't family/kids: the longest of 170–100 m that fits down the fall line on a 13–20° stretch with the floor at most 2.5 m above the hill. 15 m flat bottom, circular transitions steepening to 85° over the top 0.4 m of 5.5 m walls, 4 m level decks, outer walls falling away. The walls grow out of the floor over the 24 m drop-in and sink over the last 10 m; the floor (a fitted plane, `profile`) blends into the hill 15 m either end.
- **Lines** (`_Line`, default style): each line meanders (a sine of 120–220 m wavelength, amplitude ~8% of the width) about its offset from the spine. Features are jittered ±2 m off it, turned to face the local fall line (within `MAX_TURN` 25° of the line) and spaced 18–32 m apart. Under 34 m wide, one mixed line; 34 m+, a jump line (kickers, step-downs) and a jib line (`RAILS`: rail, short rail, kinked down rail, wide flat box; and wall rides); 90 m+, a third line of small mixed features. Kicker sizes mix (`SIZES`: small 0.9 m lip at 20°, medium 1.5 m at 25°, large 2.3 m at 30°; difficulty picks the headline size, later ones sometimes a size down; family/kids parks are all small and get no step-downs, down rails or walls). `kicker_profile`: run-in curving from the hill to the take-off angle, level table, rounded knuckle, landing at 26–34° (at least hill + 12°) easing back into the hill. Only on 4–22° grades. Wall rides are steep banks (2.4 m) beside the line along a 40 m-radius arc. Everything random is seeded from the park's name and outline (`_seed`), so builds are reproducible.
- **Course** (name matches `CROSS_NAMES`: cross, BX, snake, bumpy...): berms (banked walls outside 9 m-radius arcs, alternating sides) every 36 m with rollers between.
- **Rails** (`box` features: rails 7–12 m long, 0.9–1.3 m off the snow, down rails kinking 0.8 m lower, and 1 m-wide flat boxes 0.5 m up, each with a snow ramp up): a steel slab on legs. Unlike snow features they don't sink at their ends. Sliding one (`SnowParks.rail`, `slideRail` in `ski-physics.ts`) is nearly frictionless whichever way the skis point, so a hockey stop on a rail (S + A/D) is a boardslide that carries you to the end, and a damped spring pulls you onto the centreline. On the rail the physics uses the rail's own top (`RailContact.grade`, level across), never the sampled snow normal: samples near its end or edge straddle the 1.3 m drop and read as a wall, which stopped you dead at the end and kicked you sideways off a corner. No spray or snow scrape on steel; instead a clank as you get on and a steel grind (`railSound`: louder and higher with speed, grittier in a boardslide).
- **Sim** (`parks/park-shapes.ts`, pure, unit-tested): features are absolute surfaces; the snow is a smooth max of terrain and features (`SnowParks.height`), with finely sampled normals on them. Ski, fly, glide and snow FX use this `snowHeight`; lifts, labels and placement keep the plain ground. Halfpipes (`halfpipeHeight`, `halfpipeSection`, `halfpipeGrowth`) are a floor profile plus a cross-section. `parks/park-meshes.ts` draws them all in one vertex-coloured mesh (blue dye on the lips and the pipe's vert and coping; rails grey-topped with red sides, flat boxes black on yellow, wall rides with a plywood face), 5 cm below the physics surface so where they meet the snow the terrain wins.

### Snow effects and sound

`fx/intensity.ts` (pure, unit-tested) turns the ski contact (speed, sideslip, edge, groomed) into a skid amount and a carve amount, and from those the spray rate, track width and sound levels. Spray, trails and sound all share it so they stay consistent: a hockey stop gives a big spray, a wide smear and a loud scrape; a gentle turn gives almost no spray, a thin groove and a soft hiss.
- `fx/snow-trails.ts`: ring buffer of 8k instanced quads, uploading only new instances via `addUpdateRange`. Marks fade with camera distance.
- `fx/snow-spray.ts`: pool of 1.4k instanced particles on the CPU.
- `audio/sound.ts`: all procedural Web Audio (filtered noise, no audio files): wind, glide hiss, skid scrape, landing thumps. It starts from the "Click to play" gesture; K mutes (persisted).
- Measured at a steady 60 fps during a full hockey-stop spray.

### Paraglider

P deploys a paraglider from fly or ski mode, keeping your velocity; P again drops the wing (ski mode, falling), and touching down switches to ski mode automatically.
- `controls/glider-physics.ts` (pure, unit-tested) uses real intermediate-wing numbers: trim ~38 km/h at 1.1 m/s sink, speed bar (W), brakes (S), bank to turn (A/D) at g·tan(bank)/v with extra sink. Speed changes trade height by energy balance, so a fast launch zooms up and a slow one dives.
- `controls/glider-controls.ts` builds the canopy (vertex-coloured cells), the lines and a seated pilot (a second `SkierModel`).

### Snowmobile

B gets on a snowmobile from fly or ski mode, keeping your momentum (mid-air, it falls and lands). B again steps you off to its left onto your skis, keeping up to 90 km/h of its speed. The sled stays parked there: B within 15 m climbs back on, anywhere else brings one to you. Mode `sled` (HUD: SNOWMOBILE) is remembered across reloads.
- **Keys:** W throttle, S brake (held at a standstill it reverses, ~10 km/h), A/D steer, Shift + A/D hang off (tighter turns at speed, holds a side-hill traverse). Mouse looks; the view turns with the sled. V works.
- **Physics:** `controls/snowmobile-physics.ts` (pure, unit-tested) models a ~150 hp sled with a studded track and carbide runners, 305 kg with rider. Drive is power / speed through the CVT, limited by track grip (0.7 g groomed, 0.6 in powder). Top speed is ~123 km/h on a groomed flat (gearing) and ~91 km/h in powder.
  - Climbing: ~25° from a standstill on a piste. A spinning track slides back off anything much steeper, and momentum carries you higher.
  - Powder (off-piste, from the piste lookup): the sled sinks in and bogs when slow, planes when fast, and throws extra drag.
  - Steering: v·tan(steer)/wheelbase (25° lock, ~3.5 m radius at walking pace), capped by the carbides' bite: ~0.85 g on a piste, ~0.75 g in powder, more leaning in. Turning hard scrubs speed (`turnScrub`), so it bites rather than glides like skis.
  - Lateral grip (1 g groomed, 0.85 g powder) is above the steering limit, so the sled goes where it points instead of drifting. Only very steep traverses slip down the fall line (~45° piste, ~40° powder).
  - Contact: the sled rests on a plane fitted under its skis and track, so it bridges dips. Contact only pushes, so it launches off crests. In the air, throttle lifts the nose and the brake drops it, and it always lands (no crashes). A sprung-mass suspension soaks up landings.
- **Model:** `controls/snowmobile-model.ts` is a lofted hood, tunnel, running boards, seat, tall riser and bars, A-arms and spindles, steering skis, a track with scrolling paddles, a windshield and head/tail lights. The body is one vertex-coloured draw call; the rider is a seated `SkierModel` with skis stowed and `Stance.grip` holding the bars.
- **Collisions** (`controls/snowmobile-controls.ts`): three circles along the sled, checked every 1/120 s, against buildings and terminals (`ObstacleIndex`) plus lift towers (`LiftSystem.towerObstacles()`). The skier doesn't hit towers.
- **Sound** (`audio/levels.ts` `engineSound`): a twin two-stroke firing twice per rev (~53 Hz at idle, ~270 Hz near the 8,300 rpm limiter), with an idle warble and exhaust rasp.
- **Snow marks:** a darker trench behind the track plus a thin groove per ski (`SnowTrails` tracks `sled`, `sledLeftSki`, `sledRightSki`). Each point is sampled on the snow surface, not at the sled's height. The track throws roost when it spins.
- **Lights:** the lamp lenses glow while you ride (the tail light brightens when braking) and go dark when parked. The headlight beam fades in with `daylight().dark` (from 4° sun elevation; full at -3°).
  - The beam is a `SpotLight` that always stays in the scene and is switched by intensity: adding or removing a light recompiles every lit material.
  - It has no distance falloff: inverse-square burnt out the snow just ahead and left the rest dark. Instead it lights evenly to 90 m and fades there.
- `e2e/snowmobile.spec.ts` drives on the frozen lake (off-piste, so powder physics) and checks the headlight at 22:00. The `snowmobile` and `snowmobile-night` views in `views.spec.ts` park it on a green piste below the village. Don't aim a test at heading ~300° there: you drive straight into an apartment block.

### Lift terminals, operation and riding

**Pipeline (`terminals.py`).** Generated from the lift line alone, so it works for any resort:
- **Kind and size:** chair (detachable or fixed), gondola, cable car or drag, sized from gauge and type. Detachable means published speed over 3.2 m/s, any gondola, or 6+ seats.
- **Pads:** a flat pad under each terminal, with nearby terminals sharing one height. Chair and drag tops also get a ski-off ramp that drops 2.4 m from the unload point, so the chair passes overhead. Ramps never carve another terminal's pad.
- **Ordering:** pads are flattened *before* buildings and lifts are placed, so everything sits on the final ground.
- **Approach (`approach.py`):** OSM towers know nothing about our stations. Towers inside a station or within `MIN_GAP` of its exit are dropped. Walking outward from each exit, tower tops are adjusted so the rope leaves at most `MAX_EXIT_ANGLE` from level (18° chairs/gondolas, 35° cable cars) and bends at most 14° per tower, within buildable tower heights. Only the approach is walked (`APPROACH`, 500–800 m from the exit): further out a ridge tower can bend the rope far more, and pinning it to the station's angles buried long cable car spans. Clearance towers are then re-inserted. Changed towers get `adjusted: true`, and the build logs any steep exits left (the terrain can force one).
- **Entrances:** `choose_entrances` picks each bottom station's way in (and top's way out): a side door at the (un)loading point, or the back wall beside the uphill track, whichever is less built-up. Chair and drag tops use the ramp. A walkway (6 m wide, 4.5 m headroom, 5–25 m long until it reaches open snow) is guaranteed in front of it.
- **Building cuts are 3D volumes** (`cut_volumes`, `cut_buildings`): the hall up to its roof, the walkway up to its headroom, and the rope corridor between the carriers' lowest point and the rope. The rope corridor is cut in 4 m pieces that follow the rope's height, so a climbing rope doesn't slice a wedge out of everything it passes over. Halls and the rope corridor have no ceiling: they leave a clean notch through a building, never an archway with storeys over the station or a tunnel the cabins vanish into (`NO_CEILING`). Only a walkway can pass under a building, whose storeys above stay as a `raised` piece (rendered with an underside). Pieces left narrower than 2.5 m are dropped. A building is replaced as *being* the station only if it's mostly inside the hall and not much taller than its roof (`station_halls`). A small building mostly inside a hall *is* the station and is replaced. Corners are mitred (10 cm margin), holes are split, and collinear vertices dropped.
- **Check:** `conflicts()` must report nothing (logged as an ERROR otherwise, and recorded in `manifest.validation.liftClearance`).

**Sim.**
- `lifts/loop.ts`: each loop lift is one continuous path: up track, round the top bullwheel, down track, round the bottom one. Carriers are spaced in *time*, so detachables crawl through stations (chairs 1 m/s, gondolas 0.35 m/s) and bunch there. Jig-back cable cars use two docked tracks.
- `lifts/operation.ts`: line speed, headway and capacity.
- `lifts/terminals.ts`: station meshes, merged into one draw call, plus their collision obstacles. Detachable chair: one moulded hood (`TerminalBuilder.hood`, an extruded plan rounded round the bullwheel and tapering at the front, with bevelled edges) over the bullwheel and slow section, on columns between the tracks, grip rails, a loading carpet and gate, and an operator's cabin (4.6 m, a long window facing the lift, end windows, a decorative door and step at the back). Fixed-grip chair: the spoked bullwheel in the open on one column under a small drive housing. Gondola/cable car: a glazed hall on a concrete plinth under a rounded roof overhanging the open end, a steel portal there, the drive housing over the bullwheel, and its door on the pipeline's chosen entrance. Drag: post, hut and a name arch. Colours come from `livery(lift id)`, so a resort's stations vary but both ends of a lift match. `views.spec.ts` has `station-*` close-ups. Towers (`carriers.ts`, instanced): a tapered column with ladder rails on a concrete footing, a crossarm with a grated catwalk and handrail (`crossArmGeometry`, stretched to the gauge), and six-wheel sheave trains hung under its ends; `tower-*` views. Column plinths reach down to the real ground, so footings never float. Each terminal also returns `SignMount`s: the name board goes over the entrance (bottom) or on the line end (top), sized to fit inside the walkway, and `signs.ts` draws them.
- **No face on the snow:** pads are flattened to exactly the station's y = 0, so `TerminalBuilder.box` moves any face within `GROUND_GAP` (6 cm) of it up or down; `terminals.test.ts` checks every vertex. Use the same rule (a visible step, never a coincident plane) for anything placed on generated ground.
- `lifts/lift-system.ts`: carriers, statics, and the load and unload points with "has a carrier just passed?" timing (`nextToLoad`, `passed`).
- `LiftSystem.check()` (console error, so the e2e tests fail): continuous paths, and loading/unloading points on their pads.

**Boarding** (`lifts/ride.ts`):
- **Manual:** stand in the loading zone and the next carrier scoops you up (`LiftSystem.scoop`).
- **E:** you're put straight on the loading point (beside the track for cabins), facing up the line, and wait.
- **Both ways:** gondolas and cable cars (some just cross a valley) also board at the top station (`LiftLine.down`: the down track's loading point, loop times, and cabin 1 for jig-backs). E there rides you down, and you're let off on the bottom platform, heading out the way in.
- **Seat:** a 0.5 s blend into the seat. On a chair you really sit (`Stance.sit`): hips on the cushion against the backrest, feet forward over the footrest, upright, poles hanging beside the skis; first person shows your legs.
- **Top:** released at the unload point, moving: onto the ramp for chairs and drags, out of the side door for halls.
- **Skip:** S skips to the end (top, or bottom riding down) from any phase; W fast-forwards (×8).
- **Cabins** (gondolas, cable cars): you step in through the door and sit on the back bench facing uphill (gondola) or stand at the front window (cable car), with skis and poles stowed. The instanced cabins are the outside only (`carriers.ts`, `cabinParts`), with opaque tinted windows. The one you ride in is left out of the instances (`LiftSystem.hidden`) and drawn by `lifts/cabin-view.ts` with its interior (benches, linings, ceiling, rails) and see-through glass. The camera near plane is 5 cm everywhere (`CAMERA.near`; reversed-Z keeps far precision), so close cabin walls and your own poles in first person don't clip.

**Collisions** (`features/obstacles.ts`): the skier is pushed out of buildings and terminal walls, with the into-wall velocity removed.

### Piste grading

`grading.py` benches pistes into the terrain the way they're built, before terminals are flattened (so station pads win) and before anything is placed on the ground:
- **Across:** the cross-slope is limited by difficulty (`MAX_CROSS`: 4° green to 14° black). The bench narrows on steep sides (down to 8 m, like a real cat track) so its edges stay within 4 m of the slope, and it's raised so it's mostly packed-snow fill, not a cut into rock. Banks bridge the edge back to the natural slope.
- **Along:** the centreline profile is fitted (pool-adjacent-violators) so it never climbs, preferring a 5% gliding grade, within 5 m of fill and 3 m of cut. A run that really climbs more than that keeps climbing.
- A piste's segments are merged and then split at significant high/low points (`_legs`), so two legs meeting at a junction are each graded downhill. Where the run is also mapped as an area, the bench takes the area's width; areas wider than 50 m are open slopes and left alone. The first 30 m of a run are never dug down (a summit start would become a pit you can't skate out of).
- Skipped: freeride runs and cliffs (cross-slope over ~60°, usually a loosely drawn line), bridges and tunnels (not in `lines`), and types outside `GRADED_TYPES` (downhill, connection as an easy cat track, sled, park lines): cross-country and walking routes climb as they please.
- The build logs and records (`manifest.validation.pisteGrading`) how much climbing the run centrelines had before and after.
- The near terrain is also despiked first (`grid.despike`): the IGN lidar has rings of 100–500 m deep pits in a few places.

### Lifts and buildings

Both come from OSM through Overpass (`sources/osm.py`). The response is cached under `data/raw/osm/`; delete the cache to refresh.
- **Lifts:** stations sit at the way's ends and intermediate nodes become towers. `features.place_supports` adds `synthetic-tower`s wherever the straight cable would drop below the type's minimum clearance or a span is too long. Per-type dimensions live in `LIFT_PROFILES`.
- **Buildings:** gable roofs are computed in the pipeline (`gable_roof`): the ridge runs along the long axis of the footprint's oriented bounding box, and the footprint is split along the ridge into planar faces. Large industrial buildings keep flat roofs. Facades (windows, floors, balconies, stone plinth; timber, render, stone or metal) are procedural in `createBuildingMaterial` from a per-vertex `facade` attribute, so it stays one mesh and one draw call, fading to an average colour beyond ~150 m to avoid aliasing. Near-duplicate OSM footprints are merged (`dedupe_buildings`) because coincident walls z-fight. OSM height tags are used when present; otherwise height is estimated from footprint area (`heightSource: "estimate"`, about 98% of Val Thorens). Ruins and roofs are skipped. Lift-station footprints replace the sim's placeholder station boxes.
- Lifts that leave the near terrain extent are skipped (logged), e.g. links into neighbouring valleys, and so are ways under 40 m (a station's turn mapped as its own lift).
- **Names** (`features.display_name`): OSM `name`, or `name:en` when `name` isn't in Latin script (Himalayan peaks carry Chinese, Tibetan and Nepali in one `name`).
- **Peaks:** named `natural=peak` nodes, snapped to the highest DEM sample within 30 m. Every peak in the near extent is kept. Beyond it, only peaks of at least 3500 m (`FAR_PEAK_MIN_ELE`), so the horizon shows the big names.

### Borders

`pipeline/borders.py` adds national borders to `features.json` (`borders`: line in local metres, plus the country `left` and `right` of it walking from its first point). The ways of `admin_level=2` boundary relations crossing the map are chained, clipped to the near extent and simplified (5 m). The country on each side comes from one Overpass `is_in` request at points 300 m either side of each line's middle. Areas inside one country get none, and no second query.
- Drawn only on the 2D maps, not in the world: a purple dash-dot line on the minimap and world map (`drawBorders` in `ui/map-icons.ts`), with the country names either side on the world map (`onScreenMiddle`).
- The line is OSM's. Where countries disagree (Mont Blanc's summit), it's one version.
- Current: Everest (China / Nepal along the summit ridge), Arlberg (Austria / Germany at Warth). Les 3 Vallées and Paradiski have none on their maps.

### Mountain restaurants

`pipeline/restaurants.py` picks OSM restaurants, bars, pubs, cafés, fast food and alpine huts (all shown as "restaurants") that are out on the ski area: within 150 m of a piste and either 60 m+ above the nearest start village, or within 30 m of a piste outside a village centre (under 30 buildings within 100 m). Village places are deliberately left out to avoid clutter. Each is attached to its OSM building (or the nearest footprint within 12 m) and written to `features.json` as `restaurants`.
- The building is restyled as a hut (`use: "restaurant"`): its site is levelled into the slope like a real cut platform (`level_site`, skipped next to lift towers; station pads are protected), neighbours are re-seated, the estimated height is hut-sized (`HUT_HEIGHTS`), the roof is 22° with 1.3 m eaves, and any remaining downhill drop is a stone `footing`.
- Terrace: the OSM `leisure=outdoor_seating` area if mapped, else a deck on the sunny/downhill side clear of pistes and buildings (`source: "synthetic"`); `outdoor_seating=no` means none. A name board goes on the real wall facing the terrace or piste.
- Sim: `features/buildings.ts` draws huts in larch boards with painted shutters, a stone footing (height carried in the `facade` attribute's w), soffit and fascia under the eaves. `features/restaurants.ts` builds decks (stone wall below, railing), parasol tables and loungers (`layoutTerrace`, pure) and the boards (canvas atlas): two static meshes for the whole resort. Decks are collision solids.
- Labels show within 2.2 km and yield to lifts and local peaks. Restaurants are on the world map (names when zoomed in) and in the teleport list.

### Land cover and trees

`landcover.py` averages ESA WorldCover classes onto an 8 m grid over the near extent (`landcover-near.png`) and onto the far grid (`landcover-far.png`, from the 40 m overview). Rationale: ADR 0003.
- **Encoding:** RGB coverage fractions: R tree, G bare rock, B 128 + 127·ice − 128·water. There's no alpha: browsers premultiply it on decode, which zeroes RGB wherever alpha is 0.
- **Clearings:** tree cover is cut from groomed pistes, lift corridors, terminals and buildings, from slopes over 55°, and from more than 120 m above the tree line (99th percentile of forest elevation, `manifest.landCover.trees.treeLine`). The minimap is tinted green by the same cover.
- **Terrain shader:** bare rock lowers the snow-holding slope threshold by ~7° (patchy), and forest raises it. Glaciers get bluer snow and blue ice where steep, lakes flat frozen ice. Forest beyond the drawn trees is shaded as dark crowns with snow (`canopyFade`), and the far layer always shades it.
- **Trees (`landcover/`):** `tree-placement.ts` (pure, unit-tested) scatters trees in 80 m tiles: one candidate per 5 m cell, kept with probability cover × clumping noise, seeded per cell so every visit sees the same forest. Heights run from 26 m (valley) to 7 m (tree line), with bare larches mixed in near the tree line. All of that is synthetic; only the cover is data.
- **Detail levels match:** coarse shapes have fewer, steeper tiers that would hold less snow, so they read 25-30% darker and the level changes showed as bands. Snow-by-slope is baked into the geometry and each `TreeShape` carries a `snow` load (simple 1.4, minimal 2) calibrated in the real renderer against the detailed tree (which also shades its neighbours). `e2e/forest.spec.ts` draws one forest at each level (`Forest.showOnly`) and checks colours within 10%; `tree-geometry.test.ts` checks their on-screen size.
- **Drawing (`forest.ts`):** tiles are generated around the camera (60 per frame, nearest first, LRU-cached). Each tile's trees go into one of three instanced LODs by distance (detailed 136-tri spruce with shadows < 250 m, simple < 700 m, minimal < 1.5 km), and only tiles in the view frustum are included. The instance buffer is a vec4 per tree (east, ground, north, height + 1000·species) and the vertex shader turns and scales each tree. Rebuilding on movement or turning costs ~0.5 ms.
- **Collisions:** `Forest.resolve` pushes the skier out of trunks (0.45 m), or out of the crown at waist height for small trees (up to 1.4 m), using the same tiles as its spatial index.
- **Cost:** ~2 ms GPU in the densest Méribel views. `pnpm perf` has a `meribel-forest` pose.

### Labels

Each tag has a small white line icon at its left (`LabelSpec.icon` → `data-icon`, SVG masks in `style.css`): peak, knife and fork, and per lift type (`liftIcon`): chairlift, gondola (and mixed), cable car, drag (T-bar, platter, rope tow…).

`sim/src/ui/labels.ts` draws HTML tags projected from world anchors (1 toggles lift names, 2 peak names, 4 restaurant names; 3 is piste colours). All start off for a new player; the choice persists in localStorage. Playwright's config seeds first person with everything on, which is what the tests and screenshot views were written for; `menu.spec.ts` checks the real defaults with clean storage.
- Labels are hidden when terrain occludes them. A ray-march against the heightmap runs on a rolling budget, so not every label is checked every frame.
- Labels are also hidden beyond a per-kind distance, or when they'd overlap a higher-priority tag. Lifts and local peaks win; distant peaks are ranked by elevation.

### Performance notes

Measure with `pnpm perf` before and after any rendering change. In dev builds, `window.__sim` exposes `scene`, `renderer`, `camera`, `labels` and `minimap` for profiling scripts.
- **Use reversed-Z, not a logarithmic depth buffer.** Log depth writes depth from the fragment shader, which disables early-Z. With terrain overdraw that cost ~2.5× frame time (23 → 56 fps in the village view). Reversed-Z gives the same far-range precision. Anything that projects to NDC must not assume z ∈ [-1, 1] or z > 1 = behind; cull in view space instead (see `ui/labels.ts`).
- Avoid `Math.hypot` in per-sample hot loops; it's far slower than `Math.sqrt` in V8 (normal textures went from 750 ms to 177 ms).
- The terrain is GPU-bound. Shadows cost ~20%, and the far terrain about a quarter of the frame. CPU submission is ~1 ms.

Known limits:
- 4 m data looks soft at ground level, though a tiling procedural snow-detail normal map (`terrain/snow-detail.ts`) adds texture within ~400 m. Skiing will need finer tiles streamed near the camera.
- There's no texture/imagery drape yet. Snow vs rock is decided by slope, adjusted by land cover.
- Where the near terrain is Copernicus (outside France), the DSM includes the canopy, so trees stand ~20 m high under forest.
- Pistes use default widths, so edges are approximate where OSM has no area polygon.
- Snow park features are generated, not surveyed; there are no bridge decks (a bridge's run is skied on the ground beneath it).
- Lift cables are straight with no sag. Terminals are a few generic designs per lift type, not the real station architecture. Building roofs are flat, and multipolygon buildings (courtyards) are skipped.

Large binaries (DEMs, imagery, meshes) are never committed directly. Generate them through the pipeline. If shared assets ever have to live in the repo, use Git LFS.

## Open decisions

These need to be settled with the user before implementation starts. Record each one in `docs/decisions/` (numbered ADRs) once made.

- Scope of simulation (free-roam skiing physics, lift operations, snow/weather, crowds)

## Working in this repo

- Ask before adding a major dependency or making a stack-level choice.
- Keep resort-specific values out of code. They belong in `data/resorts/<resort>/`.
- When you add a data source, update the table above and `docs/` with its URL, license, resolution and coverage.
