# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**ski-sim** is a 3D immersive simulation of real ski resorts. The goal is fidelity: a resort in the sim should match its real-world counterpart as closely as public geospatial data allows. Terrain, pistes, lifts, buildings and tree lines all come from real data, not hand-authored approximations.

Status: **playable multi-valley map.** Val Thorens (France) renders from real lidar terrain, with basic lifts and buildings from OSM, fly mode, HUD, minimap and a bluebird sky. The long-term goal is the whole Three Valleys (Val Thorens, Les Menuires, Méribel, Courchevel). Grow extents and add resorts through config.

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
uv run ski-sim build <id>          # fetch sources (cached in data/raw), write data/processed/<id>
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
- **Failing** means a static check in `sim/scripts/station-checks.mjs` failed (a tower inside the hall, or an exit rope steeper than 18° to the next support), or a `LiftSystem.check()` problem or console error names the lift. Add new checks to `CHECKS` in that module.
- **Selection:** by default it renders every failing terminal plus `--sample N` (8) passing ones. `--lift "<regex>"` renders all matching terminals; `--all`, `--failing-only` and `--limit N` are also available. Other options: `--resort <id>`, `--out <dir>`.
- **Speed:** ~0.8 s a shot. One page loads the sim once, then teleports the camera by hooking the dev-exposed camera, and falls back to a reload if the hook stops working. `--reload` forces a reload for every shot.
- **Occlusion:** side and behind views try mirrored, further-out and higher candidates and keep the one buildings hide least. Captions show how much of each view is still hidden.

When something renders wrong, isolate it before guessing. Tinting each terrain layer a flat colour (near vs far) quickly shows which layer, or which gap, is at fault.

## Deployment

GitHub Pages, all free. `ci.yml` runs lint/typecheck/unit tests (sim) and ruff/pytest (pipeline); e2e needs a GPU, so it stays local. `deploy.yml` (push to `main`, or manual) downloads `resorts.tar.gz` from the `data` release into `data/processed`, builds with `SIM_BASE=/<repo>/` and publishes `sim/dist` to Pages.
- Resort data is built locally and published with `scripts/publish-data.sh [ids]` (default: every resort with a committed `resort.json`), which also writes a `resorts.json` listing only those and triggers a deploy.
- Asset URLs must go through `resortUrl` / `DATA_URL` (`resort/manifest.ts`), never a leading `/`: the site lives under `/<repo>/`. `VITE_DATA_URL` at build time can point the data at other storage (e.g. Cloudflare R2) if Pages' 1 GB site limit or bandwidth becomes a problem.

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
- terrain sources by country (FR: IGN LiDAR HD then RGE ALTI; elsewhere: Copernicus, so any resort builds);
- cell size, coarsened automatically to keep the grid within 8000 px for GPU texture limits;
- spawn height (150 m above the DEM);
- summit validation against every OSM peak with an `ele` tag.

Lifts, stations, signs, buildings, mountain restaurants, pistes, peaks and sounds all come from OSM with no per-resort code.
- **Neighbours are left out** (`territory.py`): the near terrain reaches past `bounds`, and a padded box often clips the next resort along. OSM `landuse=winter_sports` outlines centred inside our bounds are ours, the rest are neighbours. Lifts need a station on our ground, pistes need most of their points on it, and start villages and restaurants must be on it. Optional overrides: `origin`, `spawn` (lat/lon/heading/altitude), `terrain.near/far`, `minimap`, `landmarks`. Then open `?resort=<id>`, or set `DEFAULT_RESORT` in `sim/src/config.ts`.

Current resorts:
- `les-3-vallees`: Val Thorens, Orelle, Les Menuires, Saint-Martin, Méribel incl. Mont Vallon, Courchevel.
- `arlberg`: St. Anton, St. Christoph, Stuben, Zürs, Lech, Warth, Schröcken, plus Sonnenkopf. Copernicus terrain until an Austrian lidar source exists.
- `paradiski`: La Plagne (incl. Montalbert, Champagny, Montchavin–Les Coches) and Les Arcs (incl. Peisey-Vallandry, Villaroger), linked by the Vanoise Express. Tignes and La Rosière next door are excluded.

### Main menu

The overlay (`ui/main-menu.ts`) is the main menu and also the pause menu (it shows whenever the mouse is released).
- **Ski area:** listed from `data/processed/resorts.json`, which the pipeline rewrites after every build. Choosing another area reloads with `?resort=`. The last area played is remembered.
- **Start at:** the resort's `bases`, which the pipeline finds automatically (`bases.py`). A base is an OSM town or village with lift bottom stations within 700 m, ranked villages first. Each start point is placed 9–32 m from its main lift's bottom station, clear of buildings, facing up the lift, so the E prompt is live on arrival.
- **"Where you left off" / "Continue where you are":** resumes the saved pose.

Scaling notes for big areas (learned on the 3 Vallées):
- Anything turned into a texture must stay under 8192 px a side. The terrain cell size auto-coarsens for this, and the lift-sign atlas is a square grid. The view tests fail on any console error, so they catch a GPU validation error.
- Lift carriers are drawn only within 3.5 km of the camera, packed into the instance buffer each frame. Tiny parts (sheaves, bullwheels) cast no shadows: thousands of instances × 3 shadow cascades was the biggest cost.
- Label priority: lifts beyond 3 km yield to peaks; 4000 m+ horizon peaks always win.

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

**IGN gotcha:** fetch from the WMS-R service (`data.geopf.fr/wms-r`) using the native Lambert-93 layers in `pipeline/src/ski_sim_pipeline/sources/ign.py`. The generic `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES` layer is nearest-neighbour resampled from a ~1.5" geographic grid. It returns runs of duplicated heights and produces visible stair-step artefacts.

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
pipeline/src/ski_sim_pipeline/
  build.py            Orchestrates a resort build
  sources/            One module per data provider (ign, copernicus, osm)
  features.py         Lifts (stations, towers, clearance-driven synthetic towers) and buildings
  pistes.py, parks.py Runs of every type, overlay/lookup/lit rasters, floodlights; generated snow park layouts
  frame.py, grid.py   Local projection; grid resampling, sampling and near/far stitching
  export.py, minimap.py
sim/src/
  main.ts             Bootstrap and frame loop
  config.ts           Sim-wide tunables (simulated day, fly speeds, LOD, minimap zoom)
  terrain/            Chunked LOD terrain, normal-map texture, TSL snow/rock material
  features/           Extruded buildings
  lifts/              Lift operation model, carriers, lift system (statics + moving carriers), riding
  env/                Sky, sun position, time-of-day clock, lights, cascaded shadows, fog
  parks/              Snow park surfaces (height, normals) and their meshes
  render/             Adaptive resolution (render scale follows frame time)
  controls/           Shared input + mouse look; fly mode; ski mode (ski-physics.ts and ski-setup.ts are pure and unit-tested);
                      paraglider and snowmobile (glider-physics.ts, snowmobile-physics.ts likewise)
  nav/                Saved pose (localStorage, per resort) and teleport destinations
  net/                Multiplayer: state codec, interpolation, host/guest session, transports, remote players
  ui/                 HUD, minimap, fullscreen world map (M), world-anchored name labels
                      (HUD: mode/position/speed top left; the time of day above the minimap; the run
                      underfoot and the 1/2/3 display toggles under it. Key help lives only in the controls modal.)
sim/e2e/              Playwright view screenshots and control tests (parks.spec.ts: kicker air, park and night views)
```

### Terrain rendering

There are two layers. **Near** is lidar at 4 m covering the ski area. **Far** is Copernicus at 50 m out to ~60 km, so Mont Blanc is on the horizon.
- Far terrain discards fragments inside the near extent, and dips its vertices along that boundary so the near layer's skirts cover the join.
- The pipeline overwrites far samples inside the near extent with near data so the two surfaces agree.
- Each layer is split into chunks whose LOD is chosen by camera distance. Lighting comes from a full-resolution normal texture, so coarse LODs still shade with 4 m detail.

### Ski mode

`controls/ski-physics.ts` treats the skier as a point mass on the heightmap surface: gravity along the slope, snow friction, v² drag (lower when tucked), carving toward the ski direction, skid deceleration proportional to sideways slip, and airborne when the ground falls away.
- It's intentionally forgiving: the only falls are botched flip landings, there's a speed cap (`SKI.maxSpeed`), and no collisions with buildings or towers.
- Tune feel in the `SKI` constants and add unit tests against synthetic slopes; `e2e/ski.spec.ts` runs it on a real 21° slope above the village.
- The mode (fly/ski) is remembered in localStorage.
- Switching fly → ski drops you onto the ground below, standing still (no flying momentum). Other switches (glide → ski, sled → ski) keep your momentum. Ski poses track the feet (`EYE_HEIGHT` below the camera).
- Ski keys: W skate, Ctrl toggle tuck (W or Shift stands you up), Shift snowplough, A/D or mouse steer, Space jump, [ / ] lean forward / back (flips in the air), V camera. Holding S locks the upper body/view and makes A/D swing only the skis (pivots, hockey stops). Grip scales with cos²(slip angle), so sideways skis skid instead of steering.
- `controls/ski-stance.ts` (pure, unit-tested) turns what the skier is doing into a pose: carve edge angle from speed × path turn rate (atan(a/g), capped at 60°), plough wedge, alternating V-skate strides, tuck crouch. `controls/ski-model.ts` builds the skier (sidecut/rocker ski geometry, bindings, boots, poles; shell jacket, helmet, mirrored goggles) and applies the pose. Legs and arms use two-bone IK (`solveJoint`): ankles are pinned inside the boots so legs follow the skis in every stance, and hands follow the torso and carry the poles.
- First person hides the body (`body`) but keeps skis, boots and poles visible below the camera.
- Balance: the body aligns with gravity plus the skier's smoothed acceleration (the force the snow pushes back with), not the slope normal. That gives upright shoulders on a traverse, leaning into carves, and leaning uphill in a hockey stop. The ski edge angle is that balance line's tilt across the skis relative to the slope (`balanceEdge`).
- V (first/third person) works in both modes and is remembered. Fly mode tracks `FlyControls.position` (the eye); in third person the camera orbits behind it and you're the yellow Street View figure (`controls/pegman.ts`), leaning and dangling as you fly. Fly mode is silent (no wind). The set fly speed (default 60 m/s, mouse wheel to change, Ctrl sprints ×3) is shown at the bottom of the screen.
- e2e tests use a frozen lake at 45.28856, 6.5752 (under 15 cm of relief over 100 m) as flat ground.
- Off-piste (per the piste lookup grid) uses higher friction and drag than groomed runs.
- Take-off: you leave the snow when your ballistic path `SKI.liftLook` (0.06 s) ahead is more than `liftGap` (15 cm) above the snow there (a kicker's lip), or a step drops more than `airThreshold`. Snapping to the snow each step alone only ever lets go at cliffs. `SkiTerrain.normal` (optional) supplies a finer normal than the default 2 m finite difference; snow parks use it.
- W by speed: below ~16 km/h it skates (or walks or climbs, with footstep sounds under 9 km/h); above that it double-poles (`ski-stance` pole cycle plus `SKI.poleAccel`, up to ~32 km/h) with pole-plant sounds. Stance animation emits `step`/`plant` events and the controller exposes them as `footstep`/`polePlant` for audio.
- Skating (W below skating speed) holds your edges: sideways slip is cancelled, so you can skate along a traverse instead of being pinned by the side slope.
- Walking uphill: with W held and the skis pointing up a slope too steep to skate, `stepSki` switches to climbing (herringbone): ~1.3 m/s on gentle grades, down to 0.35 m/s on steep ones, never stuck. Releasing W lets you slide back.
- Flips: `[` / `]` lean forward / back. On the snow that's a visible stance lean (`Stance.foreAft`) and a subtle physics effect: forward bites into turns a little sooner, back floats in powder. In the air, holding one builds pitch rate (`SKI.flipRate`, ramping at `flipAccel`); let go and the rotation eases off while you spot the landing, turning the skis toward the slope below at up to `spotRate`. `SkiState.pitch` is unwrapped, so `(pitch - takeoffPitch) / 2π` counts rotations. Touchdown compares the skis' pitch to the slope: within `landClean` (15°) you ski on, up to `landTolerance` (35°) costs speed, beyond that you crash (`SkiState.crash`: slide to a stop over ~1.8 s, swing round to face downhill, then stand up; no controls meanwhile). `SkiState.landing` reports `{ flips, error, outcome }` for the step you land in (no on-screen text: flips and crashes speak for themselves).
- The skier model turns about its centre of mass (`COM_HEIGHT` above the feet) during a flip. The balance line (`bodyUp`) is measured against the slope-aligned frame without the flip, so the whole body rotates. In first person the camera swings round the same point and pitches with the flip; on landing it's back to the mouse look. `e2e/flips.spec.ts` launches the skier off the frozen lake (`ski.place` with an upward velocity), freezes it in-page on the exact frame for mid-flip screenshots, and releases keys in-page too (Playwright round trips take 50°+ of rotation).
- **Guide marker:** on the map (M), left click drops a marker (click it again to remove) and right click teleports. The marker is saved per resort (`nav/waypoint.ts`, pure and tested: storage and `placeOnScreen`, which pins off-screen points to the screen edge in their direction). In the world it's a light beam that stays a few pixels wide at any distance, plus a pin with distance and height difference (`ui/waypoint-marker.ts`), and an orange dot on the minimap (on its edge when out of range). Shift+M drops it where you are. J teleports to it; while one is set, a panel under the display toggles shows its distance and the J hint.
- Map teleports always land you on the ground (`groundedPose`, eye height above the DEM), aimed at the summit for peak destinations. You're placed at once (so terrain loads there), while the camera does a GTA V-style switch (`nav/sky-transition.ts`, `skyPose` is pure and tested): three jump-cuts up to ~2.4 km looking straight down, a pan across, three cuts down, then a swoop into your view. Desaturated, with a flash and whoosh per cut, HUD hidden; controls are frozen until it lands.

### Ski setup

G (or the main/pause menu's "Ski setup" button) opens a modal (`ui/ski-setup-menu.ts`) with presets (Slalom race, Giant slalom, All-mountain, Freeride / powder, Park) and real ski properties: length, waist, sidecut radius, flex, camber/rocker profile, wax, edge tune and binding mount. Persisted as `ski-sim.ski-setup`.
- `controls/ski-setup.ts` (pure, unit-tested) turns a setup into `SkiHandling`: friction, powder float, carve rate, hard-snow grip, skid deceleration, stable speed (chatter above it), speed cap, and multipliers for A/D turning, S-pivots and edge-to-edge speed. `stepSki` takes the handling as an argument; there are no globals.
- The All-mountain preset is the reference: it maps onto the base physics (handling multipliers of 1; only the chatter above ~100 km/h is new), so tuning `BASE_HANDLING` moves every ski together. Keep extremes playable: `ski-setup.test.ts` checks the speed cap, minimum carving and turn rates at both ends of every slider.
- The model's skis follow the setup (`skiDimensions`): length, waist, tip/tail widths from the sidecut radius, rocker rise, and the mount point (~3.5% of the length behind centre). The default 178 cm ski is about chin height on the 1.83 m skier.
- The controls list is also a modal (`#controls-modal`). Both use `ui/modal.ts`, a native `<dialog>` (Esc and backdrop clicks close it). While a dialog is open, game keys other than G, T and O are ignored.

### Settings

O (or the menu's "Settings" button) opens `ui/settings-menu.ts`: field of view, separately for first person (default 85° vertical) and third person (70°), speed widening (+10° at full speed skiing/sledding; 0 turns it off), mouse sensitivity, invert Y and third-person distance. `controls/camera-settings.ts` (unit-tested) holds the live `cameraSettings` every controller reads (`Look.apply`, each chase camera), clamps stored values and persists them as `ski-sim.camera`. Add new camera/view preferences there.

### Time of day

The time shows above the minimap (with the clock speed unless it's real time). T (or the menu's "Time of day" button) opens `ui/time-menu.ts`: a 00:00–24:00 slider, presets and the clock speed (paused, real time, ×10, ×60, ×600). Persisted as `ski-sim.time-of-day`.
- `env/time-of-day.ts` (pure, unit-tested) is the clock: advance by dt × rate, wrap at midnight. Times are local clock times on `SIM_DAY` (config: date and UTC offset); `simDate` turns them into an instant for `sunPosition`.
- Presets come from the real sun for the resort (`dayPresets`): sunrise and sunset when it's 3° up, midday at its highest, morning and afternoon halfway, night at 22:00.
- `Environment.setTime` moves the sky's sun, the shadow-casting light and sets light levels (`daylight`, unit-tested). The light never comes from below 2°, and fades out by sunset. At night a blue hemisphere "moonlight" (0.5) keeps the slopes readable; the Preetham sky goes black.

### Multiplayer

Free peer-to-peer play with no server of ours. N (or the menu's "Multiplayer" button) opens `ui/multiplayer-menu.ts`: name (`ski-sim.player-name`), Host (a 6-character code from an unambiguous alphabet, plus an invite link `?resort=<id>&join=CODE`), Join, the player list with "Go to", and Leave. `net/multiplayer.ts` ties the session, dialog and remote players to the sim. main.ts only feeds it the local avatar, the clocks and a teleport.
- **Transport** (`net/transport.ts`): Trystero over WebRTC data channels. It signals through public Nostr relays (Trystero's own maintained list, seeded by our appId) and Google's public STUN. There's no TURN, so strict networks can fail. It's imported dynamically on Host/Join, so the sim touches no network otherwise; the view tests fail on any console error. Rooms are global by code. The host's `hello` carries its resort, and a guest on another resort reloads there with the same `?join=`.
  - A dead relay logs a WebSocket error in the console while you're in a game; the other relays carry the connection.
  - `?net=loopback` swaps in a BroadcastChannel transport, so pages in one browser connect with no network. `e2e/multiplayer.spec.ts` uses it with a host page and a guest page.
  - Tested by hand over the real relays: the guest connected in ~5 s.
  - Why Trystero, not PeerJS: it needs no signalling server at all (PeerJS depends on its free cloud broker staying up) and spreads over several relays, so one going down doesn't stop a game.
- **Host relays** (`net/session.ts`, unit-tested with an in-memory hub). Trystero joins everyone mesh-style, but guests only talk to the host and ignore other peers. The host sends one batch of everyone's latest state (`encodeBatch`) about 12 times a second.
  - The host owns the roster (player numbers 1–15, max 16 players) and turns away the 17th.
  - Peers silent for 5 s are dropped. A guest that loses the host, or gets `end`, sees why in the dialog. A code nobody hosts gives up after 20 s.
  - Bump `NET_VERSION` when the wire format changes.
- **State** (`net/codec.ts`, 90 bytes): sender time, mode, flags, float32 position, then int16 velocity, the model root's quaternion, the body's balance line, the whole `Stance` (skis, crouch, lean, phases, sit, grip) and two extras (glider bank / sled steer, suspension).
  - `net/local-avatar.ts` reads these from whichever model the mode shows; `SkierModel` remembers its last `apply` for this. Remote skiers therefore carve, plough, flip, crash and sit on chairs exactly as the local one.
- **Interpolation** (`net/interpolation.ts`): 100 ms behind on the local clock. The per-player offset is the fastest delivery seen, relaxed slowly, so jitter doesn't show. After the newest sample it extrapolates along the velocity for up to 0.5 s. Mode changes and teleports jump; they never glide.
- **Remote players** (`net/remote-players.ts`): models are built per mode on first use (a `SkierModel`, `createGliderRig`, `createSnowmobile` with a seated rider, or a `Pegman`). There's a coloured name tag (terrain-occluded, one ray-march per frame round robin) and a minimap dot, pinned to the rim when off the map.
- **Shared world:** the host's time of day and lift clock (`SharedClock`). The host broadcasts it every second and on every time change; guests ping every 2 s and advance it by RTT/2.
  - The guest's time menu is locked with a hint, and its time isn't saved.
  - The lift clock slews toward the host's (snaps if over 2 s off), so chairs line up. Lift fast-forward (`RideControls.fastForward`) is off in a game, because the lift clock is shared.

### Pistes

`pipeline/pistes.py` turns OSM piste ways into:
- centrelines buffered to a default width per difficulty or type (OSM has no widths here), plus area polygons where mapped;
- `pistes-overlay.png`: RGBA on the near terrain grid, premultiplied piste colour plus coverage, sampled by the terrain shader;
- `pistes-lookup.png`: an 8 m grid where R,G = piste index and B = difficulty (low nibble, 0 none) | type code << 4 (`RUN_TYPES`; downhill is 0, so its B is just the difficulty). Used for the HUD "RUN" row and groomed-vs-powder physics; `PisteLookup.codeAt` decodes it;
- `pistes.json`: run records (type, top, start heading, length, ref, oneway, lit, lines/areas/tunnels), edge-marker poles, park layouts and floodlight masts.

Difficulty codes are 1 green (novice), 2 blue (easy), 3 red (intermediate), 4/5 black, 6 freeride. Freeride itineraries (and `piste:grooming=backcountry`) count as off-piste: no overlay and no markers.
- **Run types** (`RUN_TYPES`, first known value of a multi-valued `piste:type`): `downhill`, `snow_park` (orange), `sled`, `nordic` (thin), `playground`, `skitour` and `hike` (unprepared: no overlay, powder physics, dashed on the minimap), `connection` (grey, or its difficulty colour). Other types default to no difficulty. Edge markers line only downhill runs and connections. The HUD row shows `runLabel`: ref + name, plus the type for non-downhill runs (and "one-way").
- **Bridges and tunnels** (`bridge`/`tunnel` other than `no`; a bare `layer` > 0 is a bridge, < 0 a tunnel): kept out of a piste's `lines` (in `bridges`/`tunnels`), so they're never graded. Tunnels are also left out of the overlay and lookup (the snow above isn't the run) and drawn dashed on the minimap.
- **Floodlit runs** (`lit`/`piste:lit` other than `no`, only `FLOODLIT_TYPES`; a lit street or footpath has street lamps): masts every 40 m alternating sides, 3 m outside the edge, and `pistes-lit.png`, a glow mask on its own 4 m grid (manifest `pistes.lit`) with a pool round each mast's aim point, clipped to the run plus 8 m. The terrain shader adds it as warm emissive × `Environment.floodlights` (`daylight().floodlights`: on as the sun sets); lamp heads glow by the same uniform (`pistes/floodlights.ts`). No real lights.

### Snow parks

OSM maps where a park is, not what's in it, so `pipeline/parks.py` designs a layout per `snow_park` area or line, deterministically from its geometry, name, difficulty and the terrain, and marks it `synthetic` (manifest `pistes.parks`):
- **Spine:** the fall line through the area (or its long axis if that's much longer), or the mapped line, oriented downhill. Features keep 2 m inside the outline and clear of buildings and lift lines (`blocked`), with 25 m run-outs between them.
- **Jumps** (default): kickers down the spine, sized by difficulty (`SIZES`: small 0.9 m lip at 20°, medium 1.5 m at 25°, large 2.3 m at 30°; family/kids names are small), alternating with boxes (snow ramp + 0.5 m flat box). Parks 34 m+ wide get a separate jib line of boxes. `kicker_profile`: run-in curving from the hill to the take-off angle, level table, rounded knuckle, landing at 26–34° (at least hill + 12°) easing back into the hill. Only on 4–22° grades.
- **Course** (name matches `CROSS_NAMES`: cross, BX, snake, bumpy...): berms (banked walls outside 9 m-radius arcs, alternating sides) every 36 m with rollers between.
- **Sim** (`parks/park-shapes.ts`, pure, unit-tested): features are absolute surfaces; the snow is a smooth max of terrain and features (`SnowParks.height`), with finely sampled normals on them. Ski, fly, glide and snow FX use this `snowHeight`; lifts, labels and placement keep the plain ground. `parks/park-meshes.ts` draws them all in one vertex-coloured mesh (blue dye on the lips; boxes grey-topped with red sides), 5 cm below the physics surface so where they meet the snow the terrain wins.

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
- **Approach (`approach.py`):** OSM towers know nothing about our stations. Towers inside a station or within `MIN_GAP` of its exit are dropped. Walking outward from each exit, tower tops are adjusted so the rope leaves at most `MAX_EXIT_ANGLE` from level (18° chairs/gondolas, 35° cable cars) and bends at most 14° per tower, within buildable tower heights. Clearance towers are then re-inserted. Changed towers get `adjusted: true`, and the build logs any steep exits left (the terrain can force one).
- **Entrances:** `choose_entrances` picks each bottom station's way in (and top's way out): a side door at the (un)loading point, or the back wall beside the uphill track, whichever is less built-up. Chair and drag tops use the ramp. A walkway (6 m wide, 4.5 m headroom, 5–25 m long until it reaches open snow) is guaranteed in front of it.
- **Building cuts are 3D volumes** (`cut_volumes`, `cut_buildings`): the hall up to its roof, the walkway up to its headroom, and the rope corridor between the carriers' lowest point and the rope. The rope corridor is cut in 4 m pieces that follow the rope's height, so a climbing rope doesn't slice a wedge out of everything it passes over. What's above a cut stays as a `raised` piece (rendered with an underside), so a station sits in a building's ground floor roofed by the rest of it. A small building mostly inside a hall *is* the station and is replaced. Corners are mitred (10 cm margin), holes are split, and collinear vertices dropped.
- **Check:** `conflicts()` must report nothing (logged as an ERROR otherwise, and recorded in `manifest.validation.liftClearance`).

**Sim.**
- `lifts/loop.ts`: each loop lift is one continuous path: up track, round the top bullwheel, down track, round the bottom one. Carriers are spaced in *time*, so detachables crawl through stations (chairs 1 m/s, gondolas 0.35 m/s) and bunch there. Jig-back cable cars use two docked tracks.
- `lifts/operation.ts`: line speed, headway and capacity.
- `lifts/terminals.ts`: station meshes (chair: bullwheel housing always below the canopy, hut, loading gate; gondola/cable car: enclosed hall with its door on the pipeline's chosen entrance; drag: post, hut and a name arch), merged into one draw call, plus their collision obstacles. Column plinths reach down to the real ground, so footings never float. Each terminal also returns `SignMount`s: the name board goes over the entrance (bottom) or on the line end (top), sized to fit inside the walkway, and `signs.ts` draws them.
- **No face on the snow:** pads are flattened to exactly the station's y = 0, so `TerminalBuilder.box` moves any face within `GROUND_GAP` (6 cm) of it up or down; `terminals.test.ts` checks every vertex. Use the same rule (a visible step, never a coincident plane) for anything placed on generated ground.
- `lifts/lift-system.ts`: carriers, statics, and the load and unload points with "has a carrier just passed?" timing (`nextToLoad`, `passed`).
- `LiftSystem.check()` (console error, so the e2e tests fail): continuous paths, and loading/unloading points on their pads.

**Boarding** (`lifts/ride.ts`):
- **Manual:** stand in the loading zone and the next carrier scoops you up (`LiftSystem.scoop`).
- **E:** you're put straight on the loading point (beside the track for cabins), facing up the line, and wait.
- **Both ways:** gondolas and cable cars (some just cross a valley) also board at the top station (`LiftLine.down`: the down track's loading point, loop times, and cabin 1 for jig-backs). E there rides you down, and you're let off on the bottom platform, heading out the way in.
- **Seat:** a 0.5 s blend into the seat.
- **Top:** released at the unload point, moving: onto the ramp for chairs and drags, out of the side door for halls.
- **Skip:** S skips to the end (top, or bottom riding down) from any phase; W fast-forwards (×8).
- **Cabins** (gondolas, cable cars): you step in through the door and sit on the back bench facing uphill (gondola) or stand at the front window (cable car), with skis and poles stowed. The instanced cabins are the outside only (`carriers.ts`, `cabinParts`), with opaque tinted windows. The one you ride in is left out of the instances (`LiftSystem.hidden`) and drawn by `lifts/cabin-view.ts` with its interior (benches, linings, ceiling, rails) and see-through glass. The camera near plane drops to 5 cm inside, so close walls don't clip.

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
- **Peaks:** named `natural=peak` nodes, snapped to the highest DEM sample within 30 m. Every peak in the near extent is kept. Beyond it, only peaks of at least 3500 m (`FAR_PEAK_MIN_ELE`), so the horizon shows the big names.

### Mountain restaurants

`pipeline/restaurants.py` picks OSM restaurants, bars, pubs, cafés, fast food and alpine huts (all shown as "restaurants") that are out on the ski area: within 150 m of a piste and either 60 m+ above the nearest start village, or within 30 m of a piste outside a village centre (under 30 buildings within 100 m). Village places are deliberately left out to avoid clutter. Each is attached to its OSM building (or the nearest footprint within 12 m) and written to `features.json` as `restaurants`.
- The building is restyled as a hut (`use: "restaurant"`): its site is levelled into the slope like a real cut platform (`level_site`, skipped next to lift towers; station pads are protected), neighbours are re-seated, the estimated height is hut-sized (`HUT_HEIGHTS`), the roof is 22° with 1.3 m eaves, and any remaining downhill drop is a stone `footing`.
- Terrace: the OSM `leisure=outdoor_seating` area if mapped, else a deck on the sunny/downhill side clear of pistes and buildings (`source: "synthetic"`); `outdoor_seating=no` means none. A name board goes on the real wall facing the terrace or piste.
- Sim: `features/buildings.ts` draws huts in larch boards with painted shutters, a stone footing (height carried in the `facade` attribute's w), soffit and fascia under the eaves. `features/restaurants.ts` builds decks (stone wall below, railing), parasol tables and loungers (`layoutTerrace`, pure) and the boards (canvas atlas): two static meshes for the whole resort. Decks are collision solids.
- Labels show within 2.2 km and yield to lifts and local peaks. Restaurants are on the world map (names when zoomed in) and in the teleport list.

### Labels

`sim/src/ui/labels.ts` draws HTML tags projected from world anchors (1 toggles lift names, 2 peak names, 4 restaurant names; the choice persists in localStorage).
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
- Snow park features are generated, not surveyed; there are no rails, halfpipes or bridge decks (a bridge's run is skied on the ground beneath it).
- Lift cables are straight with no sag. Terminals are a few generic designs per lift type, not the real station architecture. Building roofs are flat, and multipolygon buildings (courtyards) are skipped.

Large binaries (DEMs, imagery, meshes) are never committed directly. Generate them through the pipeline. If shared assets ever have to live in the repo, use Git LFS.

## Open decisions

These need to be settled with the user before implementation starts. Record each one in `docs/decisions/` (numbered ADRs) once made.

- Scope of simulation (free-roam skiing physics, lift operations, snow/weather, crowds)

## Working in this repo

- Ask before adding a major dependency or making a stack-level choice.
- Keep resort-specific values out of code. They belong in `data/resorts/<resort>/`.
- When you add a data source, update the table above and `docs/` with its URL, license, resolution and coverage.
