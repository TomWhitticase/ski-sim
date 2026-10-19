# ski-sim

A 3D immersive simulation of real-world ski resorts, built from real geospatial data: lidar elevation models, aerial imagery, OpenStreetMap piste and lift data, buildings and vegetation. The aim is for each resort to match reality as closely as the available data allows.

**Status:** Les 3 Vallées (Val Thorens, Les Menuires, Méribel, Courchevel) is flyable and skiable with real lidar terrain, basic lifts and buildings, a HUD, a minimap and a bluebird sky. See [CLAUDE.md](CLAUDE.md) for architecture, principles and data sources.

## Quick start

Requires [uv](https://docs.astral.sh/uv/), Node 22+ and pnpm.

```sh
# 1. Build the resort data (downloads ~1 GB of source data on first run)
cd pipeline && uv run ski-sim build les-3-vallees

# 2. Run the sim
cd ../sim && pnpm install && pnpm dev
```

Open http://localhost:5173, pick a ski area and where to start, then **Start skiing**. Esc brings the menu back; your position is remembered across reloads.

| Control | Action |
|---|---|
| F | Switch fly / ski mode |
| WASD | Fly |
| Ctrl | Sprint |
| Space / Shift | Up / down |
| Mouse | Look |
| L / N | Toggle lift / peak names |
| P | Paraglider: deploy / release (A/D bank, W speed bar, S brakes) |
| E | Ride a lift: walks you to the loading point (or just stand on it and get scooped up). Hold W to fast-forward, S to skip to the top |
| M | Map: search pistes/lifts/peaks, click to teleport |
| O | Piste colours on the snow |
| K | Sound on / off |
| G | Ski setup: presets (slalom, GS, all-mountain, freeride, park) and length, waist, sidecut, flex, profile, wax, tune and mount, which change how the skis handle |
| **Ski mode** | Mouse or A/D steer · W skate (or walk up steep slopes) · Ctrl tuck · Shift snowplough · hold S + A/D to pivot the skis (hockey stop) · Space jump · V camera |
| Scroll | Fly speed |
| - / = | Minimap zoom |
| F3 | Debug info |
| Esc | Release mouse |

## Adding another resort

```sh
cd pipeline
uv run ski-sim init --name "Tignes" --country FR --ski-area "Tignes"   # or --bbox S,W,N,E
uv run ski-sim build tignes
```

It then appears in the main menu's ski-area list. Terrain, lifts, signs, buildings, pistes and peaks are all generated from open data.

## Data attribution

- Terrain: IGN – LiDAR HD and RGE ALTI® (Licence Ouverte / Etalab 2.0)
- © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved
- Lifts, buildings and summit reference elevations: © OpenStreetMap contributors (ODbL)
