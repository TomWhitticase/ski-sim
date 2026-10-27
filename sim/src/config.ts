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

/** Roads (`features/roads.ts`): asphalt meshes within `range` m (the terrain shades them
 *  beyond), snowbanks and snow poles within `detailRange`; both × the device's terrain LOD. */
export const ROADS = { range: 3000, detailRange: 1200 };

export const MINIMAP = {
  /** Selectable map widths in metres; cycled with the - and = keys. */
  zoomLevels: [1000, 2000, 4000, 8000],
  defaultZoom: 1,
};
