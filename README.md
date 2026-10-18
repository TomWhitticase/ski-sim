# mountain-map

A 3D immersive simulation of real-world ski resorts, built from real geospatial data: lidar elevation models, aerial imagery, OpenStreetMap piste and lift data, buildings and vegetation. The aim is for each resort to match reality as closely as the available data allows.

**Status:** Val Thorens is flyable with real lidar terrain, a HUD, a minimap and a bluebird sky. See [CLAUDE.md](CLAUDE.md) for architecture, principles and data sources.

## Quick start

Requires [uv](https://docs.astral.sh/uv/), Node 22+ and pnpm.

```sh
# 1. Build the resort data (downloads ~400 MB of source data on first run)
cd pipeline && uv run mountain-pipeline build val-thorens

# 2. Run the sim
cd ../sim && pnpm install && pnpm dev
```

Open http://localhost:5173 and click **Click to fly**.

| Control | Action |
|---|---|
| WASD | Fly (double-tap W to sprint) |
| Space / Shift | Up / down |
| Mouse | Look |
| Scroll | Fly speed |
| - / = | Minimap zoom |
| F3 | Debug info |
| Esc | Release mouse |

## Data attribution

- Terrain: IGN – LiDAR HD and RGE ALTI® (Licence Ouverte / Etalab 2.0)
- © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved
- Summit reference elevations: © OpenStreetMap contributors (ODbL)
