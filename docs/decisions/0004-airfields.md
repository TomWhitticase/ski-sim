# 0004: Airfields and helipads

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Several resorts have real airfields and helipads: the 3 Vallées has the Courchevel (LFLJ, 537 m at up to 18.6%) and Méribel (LFKX) altiports, the Val Thorens and L'Arpette altisurfaces and a dozen helipads. They were missing, apart from the odd hangar that came in with the buildings. Only the ground side is in scope: runways, taxiways, aprons, helipads, windsocks and hangars. There are no aircraft and no flying.

## Decision

- **Geometry: OpenStreetMap** (ODbL), through the existing Overpass fetch (`osm.fetch_airfields`: `nwr["aeroway"]`). It provides `aeroway=aerodrome/airstrip/heliport` (names, `icao`, `iata`, `ele`), `runway` (centrelines or areas, with `ref`, `surface`, `width`, `length`, `incline`), `taxiway`, `apron`, `helipad` (`location=roof`, `layer`), `windsock` and `hangar` (with `building`).
- **Cross-check and fill: OurAirports** (`https://ourairports.com/data/`, files from `https://davidmegginson.github.io/ourairports-data/airports.csv` and `runways.csv`). It's **public domain**, worldwide, and covers ~80,000 airports and heliports, but its runway figures are user-entered and patchy: LFLJ has its length, width, surface and one threshold, LFKX its length and width. `sources/ourairports.py` downloads both CSVs once (~17 MB) to `data/raw/ourairports/` and keeps them. They fill in a runway's width and surface where OSM has none, give threshold positions and elevations, name unnamed airfields and heliports, and add runways that OSM lacks (when both thresholds are known). A runway way mapped 2–15% shorter than its published length (OSM `length`, else OurAirports) is lengthened to that length at the end that isn't on a published threshold. Courchevel's way is 501 m against 537 m published, so it's lengthened at the 04 end. Both lengths are recorded.
- **Published figures for validation** go in the resort config (`runways`: ICAO code, ref, length, width, steepest slope, threshold elevations by designator or `low`/`high`), like `landmarks`. Each runway's length, steepest 100 m gradient, cross-slope and threshold heights are compared against them and recorded in `manifest.validation.runways`.
- **Built into the terrain like pistes** (after piste grading, before terminals and buildings). Runways and taxiways are level across but keep the ground's own longitudinal profile (a 10 m moving average of the median across the surface), so an altiport's slope and level top stay. Aprons are planes (at most 3%) and helipads are level pads. Banks run back to the natural ground at the grading module's fill and cut rates.
- **Winter state from `surface`:** paved surfaces are cleared, with ploughed snowbanks 3 m outside the edges in 50 m runs with 6 m gaps (they're solid, and the gaps let you ski across). Grass, ground, snow or unknown surfaces are groomed snow lined with edge marker cones every 30 m. An untagged taxiway, apron or helipad that joins a cleared surface is cleared too.
- **Markings are synthetic:** paint isn't mapped, so the sim draws it to ICAO Annex 14. On runways: threshold stripes (4–16 by width), designators (from the `ref`, ends ordered by the drawn line's heading), centreline, aiming points on runways long enough to fit them, and side stripes. On helipads: the H, the touchdown circle and the TLOF perimeter, with the H and circle in red dye on a snow pad. The manifest records them as synthetic.
- **Rooftop helipads** (`location=roof`, `layer` ≥ 1, or mapped inside a building's footprint) sit on that building's roof, and the roof is made flat.
- **Not pistes:** runways and helipads aren't in the piste overlay or lookup, and skiing or riding across them is allowed.

## Consequences

- Any resort gets its airfields from config alone. Altiports keep their real slope: Courchevel builds at 18.9% steepest over 100 m against 18.6% published, and Méribel's thresholds come within 0.5 m of the published 1,691 / 1,719 m.
- OurAirports data is user-maintained. Its threshold elevations are taken only where the config doesn't give the published ones.
- Real snow runways are rolled with markers, not painted, so a groomed runway is just snow and cones. That's accurate, but it's hard to see from far off.
