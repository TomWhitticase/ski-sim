// Sim-wide settings. Resort-specific values belong in data/resorts/<id>/resort.json.

export const DEFAULT_RESORT = 'val-thorens';

/** Bluebird mid-February morning; sun position is computed for the resort's location. */
export const SIM_TIME = new Date('2026-02-15T11:00:00+01:00');

export const CAMERA = {
  fov: 70,
  near: 0.5,
  far: 400_000,
};

export const FLY = {
  /** Default fly speed in m/s; adjusted with the mouse wheel. */
  speed: 25,
  minSpeed: 2,
  maxSpeed: 500,
  sprintMultiplier: 3,
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

export const MINIMAP = {
  /** Selectable map widths in metres; cycled with the - and = keys. */
  zoomLevels: [1000, 2000, 4000, 8000],
  defaultZoom: 1,
};
