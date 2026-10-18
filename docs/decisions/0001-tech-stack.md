# 0001: Tech stack

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

The project is built almost entirely by Claude Code. The stack has to be operable through text files and the command line alone: no editor GUIs, binary scene/asset formats, or menu-driven configuration. Claude also needs to verify visual output itself.

Engines considered:

- **Unreal Engine 5.** Best visual ceiling and Cesium integration, but binary `.uasset` files, Blueprints and editor-driven workflows. Rejected.
- **Unity.** Same editor dependence. Rejected.
- **Godot 4.** Text scenes and a headless CLI, but less training data and clunkier automated visual checks. Runner-up.
- **Three.js (web).** All text, huge ecosystem, headless browser screenshots for verification. Chosen.

## Decision

**Simulation (`sim/`), TypeScript:**

| Concern | Choice |
|---|---|
| Language | TypeScript (strict mode) |
| Rendering | Three.js, `WebGPURenderer` with automatic WebGL 2 fallback; shaders in TSL (Three Shading Language) |
| Build / dev server | Vite |
| Physics | Rapier (`@dimforge/rapier3d`, WASM) for collisions; custom ski/snow dynamics on top |
| Heavy compute | Web Workers for terrain tile decoding / mesh generation; Rust → WASM only if profiling shows a need |
| Unit tests | Vitest |
| Visual / e2e tests | Playwright (headless Chromium, screenshots) |
| Lint / format | ESLint + Prettier |
| Package manager | pnpm |

**Data pipeline (`pipeline/`), Python:**

| Concern | Choice |
|---|---|
| Language | Python 3.12+ |
| Env / deps | uv (`pyproject.toml` + `uv.lock`) |
| Raster (DEM, imagery) | rasterio (bundles GDAL), numpy |
| Vector (OSM, boundaries) | geopandas, shapely, pyproj; pyosmium for `.osm.pbf` |
| Lidar (when needed) | PDAL or laspy |
| Tests | pytest |
| Lint / format | ruff |

**Asset formats (pipeline → sim):**

- Terrain: tiled heightmaps with LOD (16-bit PNG or raw Float32/Uint16 binary + JSON manifest), drape textures as KTX2/WebP
- Models (lifts, buildings): glTF 2.0 / GLB, meshopt compression
- Vectors (pistes, lift lines, boundaries): GeoJSON pre-projected into the resort's local ENU frame
- Per-resort manifest JSON describing origin, CRS, tiles and provenance

## Consequences

- Runs in the browser; sharing a resort is a URL.
- Visual fidelity ceiling is below UE5. Large forests and lighting need deliberate optimisation (instancing, impostors, LOD).
- Two languages (TS + Python), with a clean file-based contract between them via the asset formats above.
