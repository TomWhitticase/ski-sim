// Sim-wide settings. Resort-specific values belong in data/resorts/<id>/resort.json.

export const DEFAULT_RESORT = 'les-3-vallees';

/** The bluebird default day (weather off). */
export const BLUEBIRD_DATE = '2026-02-15';

/**
 * The sim's day; the sun is placed for the resort's location. Clock times are local times
 * in the resort's zone: `utcOffsetHours` is set from the manifest's `timezone` when a
 * resort loads (UTC+1 for builds without one), and for the date when the weather (C)
 * picks one. The time of day itself comes from the time-of-day menu (T); `startTime` is
 * its default.
 */
export const SIM_DAY = {
  /** YYYY-MM-DD: `BLUEBIRD_DATE`, or the weather's day. */
  date: BLUEBIRD_DATE,
  utcOffsetHours: 1,
  /** Seconds after midnight. */
  startTime: 11 * 3600,
};

/** The instant for a time of day (seconds after local midnight) on `SIM_DAY`. */
export function simDate(seconds: number): Date {
  const midnight = Date.parse(`${SIM_DAY.date}T00:00:00Z`) - SIM_DAY.utcOffsetHours * 3_600_000;
  return new Date(midnight + seconds * 1000);
}

export const CAMERA = {
  fov: 70,
  // Close enough that your own poles and hands in first person aren't clipped. With the
  // reversed-Z depth buffer a near plane this small costs no precision far away.
  near: 0.05,
  far: 400_000,
};

export const FLY = {
  /** Default fly speed in m/s; adjusted with the mouse wheel. */
  speed: 60,
  minSpeed: 2,
  maxSpeed: 1500,
  mouseSensitivity: 0.0022,
  /** Velocity smoothing rate (1/s); higher is snappier. */
  responsiveness: 6,
  minHeightAboveGround: 2,
};

export const TERRAIN = {
  near: { chunkCells: 256, lodLevels: 6, lodDistance: 500 },
  far: { chunkCells: 128, lodLevels: 5, lodDistance: 4000 },
  /** Max time per frame spent building chunk geometry after the initial load (ms). */
  buildBudgetMs: 6,
};

/**
 * Close-up terrain detail (`terrain/terrain-material.ts`). The 4 m DEM is a flat white blob
 * underfoot, so near the camera we add purely procedural, zero-download shading: 3-D
 * world-space detail normals (crisp rock + a fine snow grain — sampled in 3-D, so they don't
 * smear at grazing angles the way the legacy 2-D tiling map does), micro-relief on off-piste
 * snow (fBm lumps + ridged sastrugi), a snow pack (sun sparkle, blue-tinted shade, groomed
 * corduroy) and a cheap curvature ambient occlusion. It is **visual only** — ski physics and
 * FX still sample the smooth 4 m grid, so there is no surface mismatch — and every effect
 * fades out before it could tile or cost frames at range.
 *
 * Strengths are the spike's recommended **combo**, eased so the effects add up rather than
 * fight (`strength` ≈ ¾, a touch subtler than each effect shown solo in the report). The
 * render quality tier (`render/quality.ts` `terrainDetail`) scales this per device: phones
 * get fewer fBm octaves, a shorter fade and less strength.
 *
 * Fades are `[near, far]` metres: full at `near`, gone past `far` (× the tier's `fadeScale`).
 */
export const TERRAIN_DETAIL = {
  /** Master ease on the detail-normal perturbations (rock, snow grain, relief, corduroy). */
  strength: 0.72,
  /** 3-D detail normals: a craggy breakup on rock faces plus a fine grain on snow. */
  rock: { coarse: 0.9, fine: 0.3, freq: [0.7, 3.1] as const, fade: [10, 600] as [number, number] },
  snowGrain: { strength: 0.12, freq: 4.3, fade: [4, 90] as [number, number] },
  /** Micro-relief on off-piste snow: two octaves of fBm lumps plus a ridged sastrugi term. */
  relief: {
    lump: 0.5,
    grain: 0.22,
    sastrugi: 0.3,
    freq: [0.55, 1.9, 0.9] as const,
    /** Off-piste gets the full amount; groomed pistes keep a flat 0.15 of it. */
    offPiste: 0.85,
    fade: [6, 220] as [number, number],
  },
  /** Groomed corduroy: shallow ridges across the fall line (~0.9 m spacing). */
  corduroy: { strength: 0.12, spacing: 7.0, fade: [10, 260] as [number, number] },
  /** Sun sparkle: sparse roughness dips → sharp specular glints; fades so it never aliases. */
  sparkle: { strength: 0.75, threshold: 0.82, freq: 9.0, fade: [4, 70] as [number, number] },
  /** Broad roughness variation so the snow glistens unevenly instead of reading as matte. */
  roughnessVary: { strength: 0.1, freq: 0.35 },
  /** Blue-tinted shade in the hollows (the subsurface / sky-fill look). */
  blueShade: {
    strength: 0.22,
    colour: [0.74, 0.82, 0.98] as const,
    fade: [20, 500] as [number, number],
  },
  /** Curvature ambient occlusion (Phase 2): darkens hollows near the camera, 1 = no AO. */
  ao: { darken: 0.4, freq: 0.08, fade: [10, 700] as [number, number] },
  /** Near-range aerial perspective (Phase 2): a faint sky tint over the mid-range so flat
   *  near snow lifts off a dead, depthless white. Kept subtle; set `strength` to 0 to drop. */
  aerial: {
    strength: 0.05,
    colour: [0.82, 0.88, 0.96] as const,
    fade: [60, 1200] as [number, number],
  },
};

/** Roads (`features/roads.ts`): asphalt meshes within `range` m (the terrain shades them
 *  beyond), snowbanks and snow poles within `detailRange`; both × the device's terrain LOD. */
export const ROADS = { range: 3000, detailRange: 1200 };

export const MINIMAP = {
  /** Selectable map widths in metres; cycled with the - and = keys. */
  zoomLevels: [1000, 2000, 4000, 8000],
  defaultZoom: 1,
};
