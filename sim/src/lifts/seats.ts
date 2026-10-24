// Where riders go on a carrier: a seat each on a chair, places along a gondola's back
// bench or a cable car's front window. Seat 0 is where a lone rider sits; the next ones
// fill in beside it, so friends sharing a carrier sit side by side.

import { Vector3 } from 'three/webgpu';

import { backBench, type CabinLayout, chairSeatX, floorBelowGrip } from './carriers';

/** From the feet (on a chair's footrest) back to the hips over the seat (m). */
const CHAIR_FEET_AHEAD = 0.3;
/** On a gondola bench: the feet this far ahead of the bench's centre (m). */
export const SEAT_REACH = 0.42;
/** Room a rider takes across a bench or window, and kept clear of each wall (m). */
const PLACE_WIDTH = 0.6;
const WALL_GAP = 0.35;

export interface Carrier {
  kind: string;
  seats: number;
  hang: number;
  /** Gondolas and cable cars. */
  cabin: CabinLayout | null;
}

/** How many riders get a place of their own. */
export function seatCount(c: Carrier): number {
  if (c.kind === 'chair') return Math.max(1, c.seats);
  if (!c.cabin) return 1; // drags: one rider per hanger
  const span = c.cabin.w - 2 * WALL_GAP;
  if (c.cabin.bench) return Math.max(1, Math.min(Math.floor(c.seats / 2), Math.floor(span / 0.5)));
  return Math.max(1, Math.floor(span / PLACE_WIDTH));
}

/**
 * The feet of the rider in seat `seat`, in the carrier's grip frame (x across the line,
 * -z the way it travels). Chairs fill from the +x end, cabins from the far side of the
 * door. Drags have no seats: their rider is placed from the platter (`LiftSystem`).
 */
export function seatSpot(c: Carrier, seat: number, out = new Vector3()): Vector3 {
  const n = seatCount(c);
  const k = Math.min(Math.max(seat, 0), n - 1);
  if (c.kind === 'chair') {
    return out.set(
      chairSeatX(c.seats, c.seats - 1 - k),
      -floorBelowGrip(c.kind, c.seats, c.hang),
      -0.12 - CHAIR_FEET_AHEAD,
    );
  }
  if (!c.cabin) return out.set(0, 0, 0);
  const cabin = c.cabin;
  const span = n > 1 ? cabin.w - 2 * WALL_GAP : 0;
  const x = -span / 2 + (n > 1 ? (span * k) / (n - 1) : 0);
  const bench = backBench(cabin);
  return bench
    ? out.set(x, cabin.floor, bench.z - SEAT_REACH)
    : out.set(x, cabin.floor, -cabin.d / 2 + 0.8);
}

/**
 * A seat for a new rider when `taken` are already sat on: the lowest free one, or, with
 * the carrier full, the least crowded (so a fifth friend at least shares with one).
 */
export function chooseSeat(count: number, taken: readonly number[]): number {
  let best = 0;
  let fewest = Infinity;
  for (let s = 0; s < count; s++) {
    let n = 0;
    for (const t of taken) if (t === s) n++;
    if (n < fewest) {
      fewest = n;
      best = s;
    }
    if (n === 0) break;
  }
  return best;
}
