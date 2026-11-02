import type { Runway } from '../features/types';

/**
 * A glide-path cue for the plane on final: which runway end is ahead, how far, and where
 * you are against a steep STOL glide path to its aim point, as four PAPI-style lights.
 * Synthetic: the altiports' own approach aids aren't in the data, so every runway gets
 * the same `GLIDE_PATH` (a steep mountain approach; the e2e autopilot flies it too).
 */

/** Glide path to the aim point (°). */
export const GLIDE_PATH = 4.5;
/** Aim point past the threshold (m; at most a fifth of the runway). */
export const AIM_POINT = 60;
/** Mean grade past which a runway is landed uphill only (one-way, like Courchevel). */
export const ONE_WAY_GRADE = 0.02;
/** Shown from this far out (m, horizontally to the aim point). */
export const GUIDE_RANGE = 8000;
/** PAPI unit settings about the glide path (°), lowest first. */
const PAPI = [-0.5, -0.17, 0.17, 0.5];

/** One way to land on a runway: world (x east, y up, z south) metres. */
export interface LandingEnd {
  /** Designator of the end you land on ("22"). */
  name: string;
  /** Aim point on the runway, and the landing direction (unit, horizontal). */
  aimX: number;
  aimY: number;
  aimZ: number;
  dirX: number;
  dirZ: number;
}

/** Every end a runway can be landed on: both, unless it's steep (uphill only). */
export function landingEnds(runways: readonly Runway[]): LandingEnd[] {
  const out: LandingEnd[] = [];
  for (const r of runways) {
    const a = r.line[0]!;
    const b = r.line[r.line.length - 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 50) continue;
    const grade = (r.ends[1] - r.ends[0]) / len;
    const aim = Math.min(AIM_POINT, len / 5);
    const end = (from: 0 | 1) => {
      const [p, q] = from === 0 ? [a, b] : [b, a];
      const e = (q[0] - p[0]) / len;
      const n = (q[1] - p[1]) / len;
      const h = r.ends[from] + (r.ends[1 - from]! - r.ends[from]) * (aim / len);
      out.push({
        name: r.designators[from],
        aimX: p[0] + e * aim,
        aimY: h,
        aimZ: -(p[1] + n * aim),
        dirX: e,
        dirZ: -n,
      });
    };
    // Uphill from the low end; downhill only if it's nearly level.
    if (grade >= -ONE_WAY_GRADE) end(0);
    if (grade <= ONE_WAY_GRADE) end(1);
  }
  return out;
}

export interface ApproachCue {
  end: LandingEnd;
  /** Horizontal distance to the aim point (m). */
  distance: number;
  /** Your angle above the aim point (°), and how far above (+) or below the path. */
  angle: number;
  deviation: number;
  /** PAPI lights showing white (0 all red: far too low … 4 all white: far too high). */
  white: number;
}

/**
 * The runway end you're on final for, or null: ahead within `GUIDE_RANGE`, your track
 * within 30° of its direction, inside a 15° funnel off its centreline and above it.
 */
export function approachCue(
  ends: readonly LandingEnd[],
  x: number,
  y: number,
  z: number,
  vx: number,
  vz: number,
): ApproachCue | null {
  const speed = Math.hypot(vx, vz);
  if (speed < 10) return null;
  let best: ApproachCue | null = null;
  for (const end of ends) {
    const dx = end.aimX - x;
    const dz = end.aimZ - z;
    // Along the landing direction you're `-along` before the aim point.
    const along = -(dx * end.dirX + dz * end.dirZ);
    const before = -along;
    if (before < 30 || before > GUIDE_RANGE) continue;
    const cross = Math.abs(dx * end.dirZ - dz * end.dirX);
    if (cross > 100 + before * Math.tan((15 * Math.PI) / 180)) continue;
    if ((vx * end.dirX + vz * end.dirZ) / speed < Math.cos((30 * Math.PI) / 180)) continue;
    const distance = Math.hypot(dx, dz);
    if (y <= end.aimY || (best && distance > best.distance)) continue;
    const angle = (Math.atan2(y - end.aimY, distance) * 180) / Math.PI;
    best = {
      end,
      distance,
      angle,
      deviation: angle - GLIDE_PATH,
      white: PAPI.filter((p) => angle > GLIDE_PATH + p).length,
    };
  }
  return best;
}

/** How a touchdown felt, from its sink rate (m/s): the gear takes 4.5. */
export function touchdownRating(sink: number): 'smooth' | 'firm' | 'hard' {
  return sink < 1.5 ? 'smooth' : sink < 3 ? 'firm' : 'hard';
}
