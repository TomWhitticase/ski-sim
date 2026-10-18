import { Vector3 } from 'three/webgpu';

/**
 * The haul rope's path for a lift with terminals: up the uphill track (side +1), round
 * the top bullwheel, down the downhill track, round the bottom bullwheel. Carriers
 * follow it continuously, so they never jump between tracks. Detachable lifts slow to a
 * crawl through stations (carriers bunch up there and spread out on the line, as they
 * do in reality), because carriers are spaced evenly in *time*, not distance.
 */

export interface PathPoint {
  position: Vector3;
  inStation: boolean;
}

/** Resampled every SAMPLE metres for constant-time lookups. */
const SAMPLE = 0.5;
/** Distance over which a detached carrier accelerates to line speed (m). */
const ACCEL_DISTANCE = 8;
const ARC_SEGMENTS = 16;

export class LoopPath {
  readonly points: Vector3[] = [];
  readonly inStation: boolean[] = [];
  /** Cumulative distance at each resampled point. */
  readonly distance: number[] = [];
  /** Cumulative time at each resampled point. */
  readonly time: number[] = [];
  readonly length: number;
  readonly period: number;

  constructor(
    /** The polyline the loop is built from (also what the rope is drawn along). */
    readonly corners: PathPoint[],
    readonly lineSpeed: number,
    readonly stationSpeed: number,
  ) {
    // Resample the closed polyline evenly.
    const closed = [...corners, corners[0]!];
    let carry = 0;
    for (let i = 0; i < closed.length - 1; i++) {
      const a = closed[i]!;
      const b = closed[i + 1]!;
      const span = a.position.distanceTo(b.position);
      let d = carry;
      while (d < span) {
        this.points.push(a.position.clone().lerp(b.position, d / span));
        this.inStation.push(a.inStation && b.inStation);
        d += SAMPLE;
      }
      carry = d - span;
    }
    const n = this.points.length;
    this.length = n * SAMPLE;

    // Distance into a station from its nearest exit (0 on the line), for the speed ramp:
    // a forward then a backward sweep round the loop (twice each, to wrap).
    const depth = this.inStation.map((s) => (s ? Infinity : 0));
    for (let k = 1; k < 2 * n; k++) {
      const i = k % n;
      depth[i] = Math.min(depth[i]!, depth[(i - 1 + n) % n]! + SAMPLE);
    }
    for (let k = 2 * n - 2; k >= 0; k--) {
      const i = k % n;
      depth[i] = Math.min(depth[i]!, depth[(i + 1) % n]! + SAMPLE);
    }
    let t = 0;
    for (let i = 0; i < n; i++) {
      this.distance.push(i * SAMPLE);
      this.time.push(t);
      t += SAMPLE / this.speedAt(Math.min(depth[i]!, 1e9));
    }
    this.period = t;
  }

  private speedAt(depthIntoStation: number): number {
    const k = Math.min(depthIntoStation / ACCEL_DISTANCE, 1);
    return this.lineSpeed + (this.stationSpeed - this.lineSpeed) * k;
  }

  /** Index of the resampled point nearest a world position (first match within a range). */
  nearestIndex(p: Vector3, from = 0, to = this.points.length): number {
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < to; i++) {
      const d = this.points[i]!.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Position and travel direction at loop time `tau` (wrapped into one period). */
  at(tau: number, outPos: Vector3, outDir: Vector3): { index: number; inStation: boolean } {
    const t = ((tau % this.period) + this.period) % this.period;
    let lo = 0;
    let hi = this.time.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.time[mid]! <= t) lo = mid;
      else hi = mid;
    }
    const n = this.points.length;
    const a = this.points[lo]!;
    const b = this.points[(lo + 1) % n]!;
    const t1 = lo + 1 < n ? this.time[lo + 1]! : this.period;
    const f = Math.min(Math.max((t - this.time[lo]!) / (t1 - this.time[lo]!), 0), 1);
    outPos.copy(a).lerp(b, f);
    outDir.copy(b).sub(a).normalize();
    return { index: lo, inStation: this.inStation[lo]! };
  }

  /** Loop time at which a carrier is at resampled point `index`. */
  timeAt(index: number): number {
    return this.time[index]!;
  }
}

export interface TerminalFrame {
  /** Bullwheel centre at rail height (world). */
  wheel: Vector3;
  /** Horizontal unit vector into the line (world). */
  dir: Vector3;
  /** Station straight length in front of the bullwheel (m). */
  length: number;
}

/**
 * Corner points of the loop: `across` is the lift's right-hand vector (uphill track side),
 * `towers` the line supports between the stations (world, cable height).
 */
export function loopCorners(
  bottom: TerminalFrame,
  top: TerminalFrame,
  towers: Vector3[],
  across: Vector3,
  gauge: number,
): PathPoint[] {
  const r = gauge / 2;
  const off = (p: Vector3, side: number) => p.clone().addScaledVector(across, side * r);
  const pts: PathPoint[] = [];
  const add = (position: Vector3, inStation: boolean) => pts.push({ position, inStation });

  // Up: bottom station straight, the line, top station straight.
  add(off(bottom.wheel, 1), true);
  add(off(bottom.wheel, 1).addScaledVector(bottom.dir, bottom.length), true);
  for (const t of towers) add(off(t, 1), false);
  add(off(top.wheel, 1).addScaledVector(top.dir, top.length), true);
  add(off(top.wheel, 1), true);
  // Round the top bullwheel, behind it (away from the line).
  for (let k = 1; k < ARC_SEGMENTS; k++) {
    const th = (Math.PI * k) / ARC_SEGMENTS;
    add(
      top.wheel
        .clone()
        .addScaledVector(across, Math.cos(th) * r)
        .addScaledVector(top.dir, -Math.sin(th) * r),
      true,
    );
  }
  // Down.
  add(off(top.wheel, -1), true);
  add(off(top.wheel, -1).addScaledVector(top.dir, top.length), true);
  for (let i = towers.length - 1; i >= 0; i--) add(off(towers[i]!, -1), false);
  add(off(bottom.wheel, -1).addScaledVector(bottom.dir, bottom.length), true);
  add(off(bottom.wheel, -1), true);
  for (let k = 1; k < ARC_SEGMENTS; k++) {
    const th = (Math.PI * k) / ARC_SEGMENTS;
    add(
      bottom.wheel
        .clone()
        .addScaledVector(across, -Math.cos(th) * r)
        .addScaledVector(bottom.dir, -Math.sin(th) * r),
      true,
    );
  }
  return pts;
}

/** Largest jump between consecutive path points (m): a continuity check. */
export function maxStep(path: LoopPath): number {
  let worst = 0;
  const n = path.points.length;
  for (let i = 0; i < n; i++) {
    worst = Math.max(worst, path.points[i]!.distanceTo(path.points[(i + 1) % n]!));
  }
  return worst;
}
