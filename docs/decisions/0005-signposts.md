# 0005: On-mountain signposts

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

Real resorts sign the mountain: a board of the runs and lifts at every lift top, a fingerpost
of arrow blades at every fork and lift bottom, numbered poles along the edges. The sim had
none, so you kept opening the minimap. A design spike (`~/reports/ski-signposts`) researched
how real signage works, what our data supports, where signs should go, and prototyped a
"hybrid" set drawn in the engine. This ADR records the decisions made turning that spike into
the shipped feature, and answers the spike's open questions with defaults.

## Decision

- **Placement in the pipeline** (`pipeline/.../signposts.py`), not at runtime. It's
  reproducible and unit-testable, it can avoid buildings and lift terminals and cut a tree
  clearing round each post, and it keeps the sim simple — the "reproducible pipeline" core
  principle. `signposts.place(piste_records, lifts, places, ground, obstacles)` runs after the
  pistes and lifts in `build.py`, writes `signposts.json`, and records an optional
  `manifest.signposts` entry. Decision points come from the piste graph alone: where a run
  starts, where it branches off another, and where lifts load/unload; a node with two or more
  ways out, or any lift top, gets a sign. One blade per way out, sorted left-to-right then
  easiest-first, with an arrow relative to the skiers' approach and a destination (the lift or
  village at the run's bottom).

- **Geometry-based placement, no OSM query change.** The spike rebuilds junctions from the
  grouped run geometry (a run starting within 14 m of another's line is a branch). We keep
  that rather than refetching pistes with `out body geom` for exact node topology: it needs no
  new Overpass fetch, so a resort rebuilds from the existing source caches, and it has no
  network dependency. The cost is some unnamed "Blue run" blades where OSM splits a named run
  into unnamed ways. Fetching node topology to fix that is recorded as future work.

- **Hybrid rendering** (`sim/src/signposts/`), the default (`?signs=hybrid`): a blue
  French-style board at lift tops (where people stop), arm-blades at forks and lift bottoms
  (which read at speed because the arm points the way). `?signs=fingerpost|board|marker|off`
  switch the whole resort for comparison. The whole resort is three draw calls (posts,
  bodies, text faces) from one canvas atlas, as `lifts/signs.ts` does.

- **Blades carry the run's colour** (a change from the spike's yellow). Each fingerpost blade,
  board row and marker plate is drawn in its run's piste colour (green/blue/red/black, plus the
  off-piste and run-type colours), with the text and badge in the ink — near-white or
  near-black — that WCAG contrast picks for that colour (white on blue/red/black, dark on
  green and other light colours). Lift blades stay dark slate. `signposts/layout.ts` holds the
  pure helpers (`bladeColour`, `inkFor`, `bladeSide`, `naShape`…), unit-tested.

- **A HUD readout** (`#signpost-hint`, dark glass under the compass) lists the nearest sign
  ahead within 45 m, the same blades as text you can read on a phone. It's a Display option
  ("Sign readout", on by default); the 3-D signs are part of the world and hidden only by H
  (full immersion), like everything real.

### Open questions, answered

- **Country styles.** `?signstyle=eu|na` picks the difficulty symbols (EU colour squares with
  numbers, NA circle/square/diamond shapes), defaulting to `na` for US/CA resorts and `eu`
  elsewhere from `manifest.resort.country`. A full per-country system (panel colours, the
  language of "to"/"Lift", AT yellow vs FR blue) and a per-resort `resort.json` override are
  future work; the hook is the single `style` argument.

- **Real or readable size.** Blades are drawn at ~1.25× real (1.9 m) and boards at 2.8 m, so
  they read at game speed and field of view. We keep that; no "realistic size" setting for now.

- **How much to say.** A blade shows the run's number/name, its colour (and the difficulty
  symbol), and "to &lt;lift or village&gt;" at its bottom. No length or vertical — it crowds the
  blade and the numbers mean little mid-mountain. Lift names already appear where a run leads
  to one.

- **Numbered edge markers.** Deferred. The existing edge poles (`pistes/markers.ts`) could
  gain French-style count-down discs (name + number, orange right-edge tops), doubling as a
  "where am I" for multiplayer. Out of scope for this build-out.

- **Closures and warnings.** Deferred. There's no closures model, and synthetic "slow" /
  "danger" panels need one; recorded as future work.

- **Collisions.** The skier passes through posts (as through lift towers today). Snowmobile
  collision (posts as solids, like road snow poles) is deferred — the posts are thin and off
  the skiing line, and it would touch the snowmobile obstacle set; recorded as future work.

- **Manifest.** `signposts.json` is an optional `manifest.signposts` entry
  (`{file, count, synthetic}`), **no `MANIFEST_VERSION` bump**, exactly like `roads`.

### Deployment

Backward compatible, so **deploying the feature is a push to `main`** (no format break):

- New code + old data (no `signposts.json`, no `manifest.signposts`): the sim shows no signs,
  no error. Old deployed code + new data: the extra file is ignored.
- Signs appear on a resort only once it's **rebuilt** (`ski-sim build`) and its data is
  **published** to R2 (`scripts/publish-data.sh`). That's a per-resort data publish, done
  separately from the code deploy and at the operator's pace. The code deploy never breaks a
  live resort, so there's no broken-load window.

## Consequences

- Any resort gets signs from config alone once rebuilt: ~1 sign per km of run (25 at Romme
  Alpin, 144 at Les 2 Alpes in the spike).
- The feature ships as the spike's Phases 1–2 (pipeline placement + sim rendering, readout,
  Display toggle, views). Phase 3 (sign glyphs and a tap-to-read popover on the maps,
  highlighting the blade toward the guide marker) and Phase 4 (numbered edge discs, warning
  and closure panels, a per-resort signage style) are future work.
- Unnamed OSM run segments still fall back to "Blue run" blades; node topology (`out body
  geom`) would remove most of them.
- The atlas is the cost to watch at large resorts: streaming only the nearest ~40 signs'
  text (as the spike notes) is the next performance step before the 3 Vallées-scale builds.
