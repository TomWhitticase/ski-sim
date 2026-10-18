/**
 * How hard the skis are working the snow, from what the skier is doing. Shared by the
 * snow spray, the trails and the sound so they always agree.
 */
export interface SnowContact {
  /** Speed over the snow (m/s). */
  speed: number;
  /** Sideways slide relative to the skis (m/s). */
  sideslip: number;
  /** Edge angle (rad). */
  edge: number;
  onSnow: boolean;
  groomed: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 0..1: scraping sideways. A full hockey stop is ~1; a gentle turn is near 0. */
export function skidAmount(c: SnowContact): number {
  if (!c.onSnow) return 0;
  // Carving slips a little too (under ~1 m/s); only beyond that is it a skid.
  return clamp01((Math.abs(c.sideslip) - 1) / 6.5) * clamp01(c.speed / 3);
}

/** 0..1: carving pressure (edge angle at speed). */
export function carveAmount(c: SnowContact): number {
  if (!c.onSnow) return 0;
  return clamp01(Math.abs(c.edge) / 0.9) * clamp01(c.speed / 15);
}

/** Snow particles thrown per second. */
export function sprayRate(c: SnowContact): number {
  const skid = skidAmount(c);
  const carve = carveAmount(c);
  // Skids throw far more than carves (skid² so a gentle smear stays subtle); powder more.
  const base = 650 * skid * skid + 60 * carve * carve;
  return base * (c.groomed ? 1 : 1.6);
}

/** Width of the track one ski leaves (m): a thin line carving, a wide smear skidding. */
export function trailWidth(c: SnowContact): number {
  return 0.08 + 0.75 * skidAmount(c);
}
