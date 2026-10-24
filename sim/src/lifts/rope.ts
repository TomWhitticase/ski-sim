import { Vector3 } from 'three/webgpu';

/**
 * The haul rope's sag between supports, mirroring the pipeline's `rope.py` exactly (the
 * same numbers are checked in both unit tests), so ropes and carriers hang on the curve
 * the pipeline's clearances, crossings and building cuts were worked out for.
 *
 * A parabola (within centimetres of the catenary at these ratios): a span of plan length
 * L hangs L² / (8 · catenary) below its chord mid-span. `catenary` (tension over weight
 * per metre, m) comes from the pipeline per lift; older builds have none, and their
 * ropes stay straight, as their clearances assumed.
 */

/** How far (m) the rope hangs below the chord at fraction `t` of a span `span` m long. */
export function sag(catenary: number | null | undefined, span: number, t: number): number {
  if (!catenary || span <= 0) return 0;
  return ((span * span) / (2 * catenary)) * t * (1 - t);
}

/** Rope height at fraction `t` of a free span from height `a` to `b`. */
export function ropeHeight(
  a: number,
  b: number,
  catenary: number | null | undefined,
  span: number,
  t: number,
): number {
  return a + (b - a) * t - sag(catenary, span, t);
}

/** The drawn rope and carrier paths may stray this far (m) from the true curve. */
const TOLERANCE = 0.05;
/** Never more pieces per span than this. */
const MAX_PIECES = 48;

/**
 * Points strictly between `a` and `b` (world, y up) along the sagging rope, enough that
 * straight pieces between them stay within TOLERANCE of the curve (a parabola cut into n
 * equal pieces strays mid-sag / n²). None when it doesn't sag.
 */
export function hangPoints(a: Vector3, b: Vector3, catenary: number | null | undefined): Vector3[] {
  const span = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
  const mid = sag(catenary, span, 0.5);
  if (mid <= TOLERANCE) return [];
  const n = Math.min(MAX_PIECES, Math.ceil(Math.sqrt(mid / TOLERANCE)));
  const out: Vector3[] = [];
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const p = a.clone().lerp(b, t);
    p.y = ropeHeight(a.y, b.y, catenary, span, t);
    out.push(p);
  }
  return out;
}
