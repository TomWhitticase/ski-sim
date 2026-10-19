import { blendPose, type PlayerState, POSE_LENGTH, SLOT } from './codec';

/** Remote players are drawn this far in the past, so there's usually a sample either side (ms). */
export const INTERP_DELAY = 100;
/** Past the newest sample, keep moving along its velocity for at most this long (ms). */
export const MAX_EXTRAPOLATION = 500;
/** Samples kept per player (~2.5 s at 12 Hz). */
const CAPACITY = 32;
/**
 * The clock-offset estimate (fastest delivery seen) creeps up by this fraction of
 * elapsed time, so one lucky fast packet or clock drift doesn't skew it for good.
 */
const OFFSET_RELAX = 0.002;
/** Further than this between samples (beyond their speed) is a teleport: jump, don't glide (m). */
const TELEPORT = 40;

/**
 * Buffers one remote player's states and resamples them at a fixed delay. Senders stamp
 * states with their own clock, so the receiver tracks `offset` (its clock minus theirs,
 * plus the fastest delivery seen) to place each sample on the local timeline.
 */
export class Interpolator {
  private readonly samples: PlayerState[] = [];
  private offset: number | null = null;
  private lastArrival = 0;
  /** Local time (ms) anything was last heard from this player (states or messages). */
  heardAt = 0;

  heard(now: number): void {
    this.heardAt = Math.max(this.heardAt, now);
  }

  get latest(): PlayerState | undefined {
    return this.samples[this.samples.length - 1];
  }

  /** Add a state received at local time `now` (ms). Stale or repeated states are ignored. */
  push(state: PlayerState, now: number): boolean {
    const last = this.latest;
    if (last && state.time <= last.time) return false;
    const seen = now - state.time;
    this.offset =
      this.offset === null
        ? seen
        : Math.min(seen, this.offset + (now - this.lastArrival) * OFFSET_RELAX);
    this.lastArrival = now;
    this.heard(now);
    this.samples.push(state);
    if (this.samples.length > CAPACITY) this.samples.shift();
    return true;
  }

  /** The state to draw at local time `now` (ms). False until the first state arrives. */
  sample(now: number, out: PlayerState): boolean {
    const n = this.samples.length;
    if (n === 0 || this.offset === null) return false;
    // Render time, on the sender's clock.
    const t = now - INTERP_DELAY - this.offset;
    const first = this.samples[0]!;
    const last = this.samples[n - 1]!;
    if (t <= first.time) {
      copyState(first, out);
      return true;
    }
    if (t >= last.time) {
      // Late packet (or the player stopped sending): carry on along their velocity.
      copyState(last, out);
      const ahead = Math.min(t - last.time, MAX_EXTRAPOLATION) / 1000;
      for (let k = 0; k < 3; k++)
        out.pose[k] = last.pose[k]! + last.pose[SLOT.velocity + k]! * ahead;
      out.time = t;
      return true;
    }
    let i = n - 2;
    while (i > 0 && this.samples[i]!.time > t) i--;
    const a = this.samples[i]!;
    const b = this.samples[i + 1]!;
    const f = (t - a.time) / (b.time - a.time);
    if (a.mode !== b.mode || jumped(a, b)) {
      // Switching mode or teleporting: show one or the other, never a blend.
      copyState(f < 0.5 ? a : b, out);
    } else {
      blendPose(a.pose, b.pose, f, out.pose);
      out.mode = b.mode;
      out.flags = f < 0.5 ? a.flags : b.flags;
    }
    out.time = t;
    return true;
  }
}

function jumped(a: PlayerState, b: PlayerState): boolean {
  const dt = (b.time - a.time) / 1000;
  let d2 = 0;
  let v2 = 0;
  for (let k = 0; k < 3; k++) {
    d2 += (b.pose[k]! - a.pose[k]!) ** 2;
    v2 += Math.max(Math.abs(a.pose[SLOT.velocity + k]!), Math.abs(b.pose[SLOT.velocity + k]!)) ** 2;
  }
  return Math.sqrt(d2) > TELEPORT + 2 * Math.sqrt(v2) * dt;
}

export function copyState(from: PlayerState, to: PlayerState): PlayerState {
  to.time = from.time;
  to.mode = from.mode;
  to.flags = from.flags;
  to.pose.set(from.pose.subarray(0, POSE_LENGTH));
  return to;
}
