import { describe, expect, it } from 'vitest';

import { type AvatarMode, createState, SLOT } from './codec';
import { INTERP_DELAY, Interpolator, MAX_EXTRAPOLATION } from './interpolation';

/** A player moving east at `speed` m/s, sampled at sender time `t` (ms). */
function at(t: number, speed = 10, mode: AvatarMode = 'ski') {
  const s = createState();
  s.time = t;
  s.mode = mode;
  s.pose[0] = (speed * t) / 1000;
  s.pose[SLOT.velocity] = speed;
  s.pose[SLOT.rotation + 3] = 1;
  return s;
}

/** Sender clock runs this far behind ours; packets take 30 ms. */
const SKEW = 50_000;
const LAG = 30;

describe('Interpolator', () => {
  it('draws the player INTERP_DELAY behind, between samples', () => {
    const interp = new Interpolator();
    for (let t = 0; t <= 1000; t += 80) interp.push(at(t), t + SKEW + LAG);
    const out = createState();
    // Now (local) corresponds to sender time 1000 + LAG... minus the delay.
    const now = 1000 + SKEW + LAG;
    expect(interp.sample(now, out)).toBe(true);
    expect(out.pose[0]).toBeCloseTo((10 * (1000 - INTERP_DELAY)) / 1000, 3);
  });

  it('extrapolates by velocity when packets are late, but not forever', () => {
    const interp = new Interpolator();
    for (let t = 0; t <= 400; t += 80) interp.push(at(t), t + SKEW + LAG);
    const out = createState();
    // 300 ms after the last packet (400) should have arrived.
    interp.sample(400 + SKEW + LAG + INTERP_DELAY + 300, out);
    expect(out.pose[0]).toBeCloseTo(4 + 3, 3);
    // Silent for seconds: stops after MAX_EXTRAPOLATION.
    interp.sample(400 + SKEW + LAG + INTERP_DELAY + 5000, out);
    expect(out.pose[0]).toBeCloseTo(4 + (10 * MAX_EXTRAPOLATION) / 1000, 3);
  });

  it('absorbs jitter: the offset tracks the fastest delivery', () => {
    const interp = new Interpolator();
    const jitter = [0, 60, 10, 45, 5, 70, 20, 0, 55, 30, 15];
    jitter.forEach((j, i) => interp.push(at(i * 80), i * 80 + SKEW + LAG + j));
    const out = createState();
    const now = 800 + SKEW + LAG;
    interp.sample(now, out);
    // Sender time now - delay = 700 → 7 m, regardless of the jitter.
    expect(out.pose[0]).toBeCloseTo(7, 1);
  });

  it('ignores repeated and out-of-order states', () => {
    const interp = new Interpolator();
    expect(interp.push(at(100), 200)).toBe(true);
    expect(interp.push(at(100), 210)).toBe(false);
    expect(interp.push(at(50), 220)).toBe(false);
    expect(interp.latest!.time).toBe(100);
  });

  it('jumps rather than glides across a teleport or mode change', () => {
    const interp = new Interpolator();
    const a = at(0, 0);
    const b = at(100, 0);
    b.pose[0] = 5000; // map teleport
    interp.push(a, SKEW);
    interp.push(b, SKEW + 100);
    const out = createState();
    interp.sample(SKEW + INTERP_DELAY + 25, out);
    expect(out.pose[0]).toBe(0);
    interp.sample(SKEW + INTERP_DELAY + 75, out);
    expect(out.pose[0]).toBe(5000);

    const modes = new Interpolator();
    modes.push(at(0, 10, 'ski'), SKEW);
    modes.push(at(100, 10, 'glide'), SKEW + 100);
    modes.sample(SKEW + INTERP_DELAY + 75, out);
    expect(out.mode).toBe('glide');
    expect(out.pose[0]).toBeCloseTo(1, 5); // b's own position, not a blend
  });

  it('has nothing to draw before the first state', () => {
    expect(new Interpolator().sample(1000, createState())).toBe(false);
  });
});
