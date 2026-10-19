# 0003: Land cover (forests, rock, glaciers, water)

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

Snow vs rock was decided by slope alone and there were no trees, the biggest visual gap. Whatever we use has to work for every resort without per-resort data.

## Decision

- **Source: ESA WorldCover 10 m 2021 v200** (global, CC BY 4.0), cloud-optimised GeoTIFFs on AWS: `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_<N45E006>_Map.tif` (3°×3° tiles named by their SW corner). `sources/worldcover.py` reads only the needed window over HTTP (the far extent from the 40 m overview) and caches it under `data/raw/worldcover/`.
- **Layers:** tree cover (10), bare / sparse vegetation (60), snow & ice (70) and water (80), each averaged to a coverage fraction on an 8 m grid over the near extent (`landcover-near.png`) and the 50 m far grid (`landcover-far.png`). The PNGs are RGB: R tree, G rock, B 128 + 127·ice − 128·water. Alpha isn't used because browsers premultiply it when decoding.
- **Clearings:** tree cover is cut from groomed pistes (+3 m), lift corridors (9 m half-width for chairs and gondolas, 5 m for drags and cable cars), terminals and buildings (+4 m). Freeride itineraries keep their trees. "Trees" more than 120 m above the resort's tree line (99th percentile of forest elevations) or on slopes over 55° are dropped, because WorldCover sometimes classes shadowed rock as forest.
- **Trees are generated in the sim, not shipped:** the 3 Vallées has ~150 km² of forest (millions of trees). The sim scatters them from the tree cover with seeded per-cell randomness: one candidate per 5 m cell, kept with probability cover × clumping noise. Heights run from 26 m in the valleys to 7 m at the tree line, with bare larches mixed in near it. Positions, heights and species are synthetic (recorded in the manifest), and the tree cover is data.
- **No canopy height dataset (yet):** Meta/WRI's 1 m canopy height is free (CC BY 4.0), but its tiles are 65536² strip-organised GeoTIFFs with no overviews (~375 MB per tile), so a windowed read still pulls most of a tile. Worth revisiting for real tree heights.
- **OSM `natural=wood` etc. not used:** WorldCover is consistent everywhere, and OSM forest outlines are patchy and older.

## Consequences

- Any resort on Earth gets forests, rock, glaciers and lakes with no config.
- WorldCover is a summer classification. In winter, gentle "bare" ground is snow-covered, so the terrain shader only lowers the rock slope threshold there (by ~7°, patchily) rather than painting it as rock.
- Where the near terrain is Copernicus (outside France), the DSM already includes the canopy, so trees stand on ground that is ~20 m too high under forest. A future step could estimate a DTM by lowering the DSM under tree cover.
