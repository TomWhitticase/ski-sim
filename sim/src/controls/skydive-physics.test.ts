import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import {
  createSkydiveState,
  inflation,
  openCanopy,
  SKYDIVE,
  type SkydiveInput,
  type SkydiveState,
  stepSkydive,
} from './skydive-physics';

const DT = 1 / 60;
const NONE: SkydiveInput = { turn: 0, track: false, flare: false, headDown: 0 };
/** Flat ground at 0 m (so altitude is height above it). */
const flat = () => 0;

function fall(at: number, input: SkydiveInput, seconds: number, s = createSkydiveState()) {
  if (s.position.y === 0) s.position.set(0, at, 0);
  for (let i = 0; i < seconds * 60; i++) stepSkydive(s, input, DT, flat);
  return s;
}
const kmh = (s: SkydiveState) => s.velocity.length() * 3.6;
const ground = (s: SkydiveState) => Math.hypot(s.velocity.x, s.velocity.z);

describe('freefall', () => {
  it('reaches ~195 km/h belly to earth near sea level, faster high up', () => {
    // A low "sea level" sky: 3,000 m of fall over ground at -3,000 m.
    const s = createSkydiveState();
    s.position.set(0, 600, 0);
    for (let i = 0; i < 20 * 60; i++) stepSkydive(s, NONE, DT, () => -5000);
    expect(kmh(s)).toBeGreaterThan(185);
    expect(kmh(s)).toBeLessThan(205);
    const high = fall(4500, NONE, 15);
    expect(kmh(high)).toBeGreaterThan(kmh(s) + 10);
  });

  it('goes ~290 km/h head down, slower flared', () => {
    const below = () => -5000;
    const go = (input: SkydiveInput) => {
      const s = createSkydiveState();
      s.position.set(0, 600, 0);
      for (let i = 0; i < 25 * 60; i++) stepSkydive(s, input, DT, below);
      return kmh(s);
    };
    expect(go({ ...NONE, headDown: 1 })).toBeGreaterThan(270);
    expect(go({ ...NONE, headDown: 1 })).toBeLessThan(305);
    expect(go({ ...NONE, flare: true })).toBeLessThan(180);
  });

  it('tracks forward about as fast as it falls (1:1)', () => {
    const s = createSkydiveState();
    s.position.set(0, 600, 0);
    for (let i = 0; i < 20 * 60; i++) stepSkydive(s, { ...NONE, track: true }, DT, () => -5000);
    const down = -s.velocity.y;
    expect(ground(s) / down).toBeGreaterThan(0.8);
    expect(ground(s) / down).toBeLessThan(1.25);
    expect(-s.velocity.z).toBeGreaterThan(30); // heading north
  });

  it('turns with A/D, and drifts with the wind', () => {
    const s = fall(4000, { ...NONE, turn: 1 }, 1);
    expect(s.heading).toBeGreaterThan(1.5);
    const w = createSkydiveState();
    w.position.set(0, 6000, 0);
    for (let i = 0; i < 20 * 60; i++) stepSkydive(w, NONE, DT, flat, new Vector3(10, 0, 0));
    expect(w.velocity.x).toBeGreaterThan(8); // most of the 10 m/s wind
  });

  it('opens automatically at 300 m, and hitting the ground without a canopy is a crash', () => {
    const s = createSkydiveState();
    s.position.set(0, 1000, 0);
    let opened = NaN;
    for (let i = 0; i < 60 * 60 && !s.landed; i++) {
      stepSkydive(s, NONE, DT, flat);
      if (s.canopy && Number.isNaN(opened)) opened = s.position.y;
    }
    expect(s.aad).toBe(true);
    expect(opened).toBeGreaterThan(280);
    expect(opened).toBeLessThan(300);
    expect(s.landed?.crash).toBe(false);

    // Too low for the canopy to open: a crash.
    const low = createSkydiveState();
    low.position.set(0, 40, 0);
    low.velocity.set(0, -50, 0);
    for (let i = 0; i < 600 && !low.landed; i++) stepSkydive(low, NONE, DT, flat);
    expect(low.landed?.crash).toBe(true);
  });
});

describe('the canopy', () => {
  function opened(at = 2000) {
    const s = createSkydiveState();
    s.position.set(0, at, 0);
    s.velocity.set(0, -54, 0);
    openCanopy(s);
    return s;
  }

  it('opens over ~3 s with a shock of a few g, down to canopy speeds', () => {
    expect(inflation(0.3)).toBe(0);
    expect(inflation(SKYDIVE.canopy.openTime)).toBe(1);
    const s = opened();
    let peak = 0;
    for (let i = 0; i < 3 * 60; i++) {
      stepSkydive(s, NONE, DT, flat);
      peak = Math.max(peak, s.g);
    }
    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThan(6);
    expect(-s.velocity.y).toBeLessThan(15);
  });

  it('flies ~40 km/h forward at ~5 m/s sink, and flares to ~2.5 m/s', () => {
    const s = opened();
    run(s, NONE, 15);
    expect(ground(s) * 3.6).toBeGreaterThan(35);
    expect(ground(s) * 3.6).toBeLessThan(45);
    expect(-s.velocity.y).toBeCloseTo(5, 0);
    run(s, { ...NONE, flare: true }, 4);
    expect(-s.velocity.y).toBeLessThan(3);
    expect(ground(s) * 3.6).toBeLessThan(28);
  });

  it('turns with a toggle, and lands softly flared', () => {
    const s = opened(200);
    run(s, NONE, 6);
    const h0 = s.heading;
    run(s, { ...NONE, turn: 1 }, 3);
    expect(s.heading - h0).toBeGreaterThan(0.6);
    // Flare near the ground and land.
    for (let i = 0; i < 120 * 60 && !s.landed; i++) {
      const flare = s.position.y < 15;
      stepSkydive(s, { ...NONE, flare }, DT, flat);
    }
    expect(s.landed?.crash).toBe(false);
    expect(s.landed!.sink).toBeLessThan(4);
  });

  function run(s: SkydiveState, input: SkydiveInput, seconds: number) {
    for (let i = 0; i < seconds * 60; i++) stepSkydive(s, input, DT, flat);
  }
});
