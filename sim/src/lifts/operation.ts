import type { Lift } from '../features/types';

export type CarrierKind = 'chair' | 'gondola' | 'cabin' | 'platter' | 'tbar';

/** Typical figures for lifts with no published specs. */
const DEFAULTS: Record<string, { speed: number; occupancy: number; capacity: number }> = {
  chair_lift: { speed: 5, occupancy: 4, capacity: 2400 },
  gondola: { speed: 6, occupancy: 10, capacity: 2800 },
  mixed_lift: { speed: 6, occupancy: 8, capacity: 2400 },
  cable_car: { speed: 10, occupancy: 120, capacity: 1200 },
  drag_lift: { speed: 3, occupancy: 1, capacity: 900 },
  platter: { speed: 3, occupancy: 1, capacity: 900 },
  't-bar': { speed: 3, occupancy: 2, capacity: 1200 },
  'j-bar': { speed: 3, occupancy: 1, capacity: 900 },
  rope_tow: { speed: 2, occupancy: 1, capacity: 600 },
};

export interface Operation {
  kind: CarrierKind;
  /** Line speed (m/s). */
  speed: number;
  /** Jig-back cable cars shuttle two cabins; everything else runs a continuous loop. */
  reversible: boolean;
  /** Distance between carriers on a loop (m). */
  spacing: number;
  /** Carriers on the loop (or 2 for a jig-back). */
  carriers: number;
  /** Seconds a jig-back cabin waits at each station. */
  dwell: number;
  /** Line length (m). */
  length: number;
  /** Carrier hangs this far below the cable (m) (drag lifts: down to the snow). */
  hang: number;
}

const MAX_CARRIERS = 140;

export function carrierKind(type: string): CarrierKind {
  if (type === 'cable_car') return 'cabin';
  if (type === 'gondola' || type === 'mixed_lift') return 'gondola';
  if (type === 't-bar') return 'tbar';
  if (type === 'drag_lift' || type === 'platter' || type === 'j-bar' || type === 'rope_tow')
    return 'platter';
  return 'chair';
}

export function lineLength(lift: Lift): number {
  let total = 0;
  for (let i = 1; i < lift.supports.length; i++) {
    const a = lift.supports[i - 1]!;
    const b = lift.supports[i]!;
    total += Math.hypot(b.east - a.east, b.north - a.north, b.top - a.top);
  }
  return total;
}

export function operation(lift: Lift): Operation {
  const d = DEFAULTS[lift.type] ?? DEFAULTS.chair_lift!;
  const kind = carrierKind(lift.type);
  const length = lineLength(lift);
  const reversible = kind === 'cabin';
  // Published ride time gives the real speed; clamp out obviously wrong tags.
  const published = lift.duration ? length / lift.duration : null;
  const speed = published && published > 0.8 && published < 13 ? published : d.speed;
  const occupancy = lift.occupancy ?? d.occupancy;
  const capacity = lift.capacity ?? d.capacity;
  // capacity [people/h] = speed [m/s] * 3600 / spacing [m] * occupancy
  let spacing = (speed * 3600 * occupancy) / capacity;
  let carriers = reversible ? 2 : Math.max(2, Math.round((2 * length) / spacing));
  if (carriers > MAX_CARRIERS) carriers = MAX_CARRIERS;
  if (!reversible) spacing = (2 * length) / carriers;
  const hang = kind === 'chair' ? 2.4 : kind === 'gondola' ? 3.2 : kind === 'cabin' ? 6 : 0;
  return { kind, speed, reversible, spacing, carriers, dwell: 45, length, hang };
}

export interface CarrierState {
  /** Distance from the bottom station along the line (m). */
  distance: number;
  /** +1 on the uphill track, -1 on the downhill track. */
  side: 1 | -1;
  /** Whether it's travelling (a jig-back cabin waits at stations). */
  moving: boolean;
}

/** Where carrier `i` is at time `t` (s). */
export function carrierAt(op: Operation, i: number, t: number): CarrierState {
  const L = op.length;
  if (op.reversible) {
    const travel = L / op.speed;
    const period = 2 * (travel + op.dwell);
    const phase = ((t % period) + period) % period;
    // Cabin 0 starts dwelling at the bottom; cabin 1 mirrors it from the top.
    let d: number;
    let moving = true;
    if (phase < op.dwell) {
      d = 0;
      moving = false;
    } else if (phase < op.dwell + travel) {
      d = (phase - op.dwell) * op.speed;
    } else if (phase < 2 * op.dwell + travel) {
      d = L;
      moving = false;
    } else {
      d = L - (phase - 2 * op.dwell - travel) * op.speed;
    }
    return i === 0 ? { distance: d, side: 1, moving } : { distance: L - d, side: -1, moving };
  }
  const loop = 2 * L;
  const s = (((i * op.spacing + op.speed * t) % loop) + loop) % loop;
  return s < L
    ? { distance: s, side: 1, moving: true }
    : { distance: loop - s, side: -1, moving: true };
}

/** Seconds until a jig-back's uphill cabin next leaves the bottom (0 if boarding now). */
export function nextDeparture(op: Operation, t: number): number {
  const period = 2 * (op.length / op.speed + op.dwell);
  const phase = ((t % period) + period) % period;
  return phase < op.dwell ? 0 : period - phase;
}
