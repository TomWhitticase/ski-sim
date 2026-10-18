# 0002: Pilot resort and terrain sources

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

The long-term goal is the full Three Valleys (Val Thorens, Les Menuires, Méribel, Courchevel). We need a first slice to prove the pipeline and renderer.

## Decision

- **Pilot resort: Val Thorens**, including the Orelle sector. Config: `data/resorts/val-thorens/resort.json`, with the local frame origin at the village centre (45.2981 N, 6.5803 E).
- **Near terrain (10.5 × 15 km at 4 m):** IGN LiDAR HD MNT, with RGE ALTI as gap fill. LiDAR HD covered 100% of the extent at build time.
- **Far terrain (120 × 125 km at 50 m):** Copernicus GLO-30, reaching Mont Blanc ~60 km north.
- **Validation:** six OSM summit nodes with published elevations. All are within 7 m, most within 1 m.

## Consequences

- Expanding to the Three Valleys means growing the near extent (or adding near tiles) in config. 4 m over ~25 × 20 km is ~31 M samples, so the sim will need tiled streaming rather than one heightmap before then.
- Copernicus is a surface model, so far forests read a few metres high. That's invisible at horizon distances.
