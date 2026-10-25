import { Vector3 } from 'three/webgpu';

import { airDensity, RHO0 } from './aircraft-types';

/**
 * A skydiver as a point mass, with a body position that sets the drag, and a ram-air
 * canopy that opens over a few seconds. Real numbers:
 * - belly to earth: terminal ~195 km/h at sea level (faster in thin air: drag goes with
 *   density); head down ~290 km/h; flaring (S, arms and legs spread) ~170 km/h
 * - tracking (W): arms back, legs straight; the body flies like a poor wing, gliding
 *   about 1:1 (as fast forward as down), at ~210 km/h overall
 * - A/D turn on the spot (~100°/s); wind carries you with it
 * - the canopy: a 170 ft² sport canopy, ~40 km/h forward and ~5 m/s down at trim; toggles
 *   (A/D) turn it, both down (S) slow it to ~22 km/h and ~2.5 m/s (a flare, for landing).
 *   Opening takes ~3 s: snivel, then the shock as it bites (peaking at ~3–4 g)
 * Forgiving: an AAD-style automatic opening at 300 m above the ground if you haven't.
 * World axes: x east, y up, z south; `heading` in Look terms (0 north, + left).
 */
export const SKYDIVE = {
  gravity: 9.81,
  /** Terminal speeds at sea level (m/s): belly, head down, flared. */
  bellySpeed: 195 / 3.6,
  headDownSpeed: 290 / 3.6,
  flareSpeed: 170 / 3.6,
  /** Tracking: total speed (m/s) and glide (forward over down). */
  trackSpeed: 210 / 3.6,
  trackGlide: 1,
  turnRate: 1.75,
  /** How fast the body changes position (1/s). */
  postureRate: 2.5,
  canopy: {
    /** Snivel and inflation (s). */
    openTime: 3,
    trimSpeed: 40 / 3.6,
    trimSink: 5,
    brakeSpeed: 22 / 3.6,
    brakeSink: 2.5,
    maxBank: 0.6,
    rollRate: 1.6,
    /** How fast speed and sink settle to their targets once flying (1/s). */
    settle: 1.4,
  },
  /** Automatic opening height above the ground (m). */
  aadHeight: 300,
  /** Landing under canopy faster than this down (m/s) is a crash; freefall always is. */
  maxLandingSink: 8,
  maxStep: 1 / 120,
};

export interface SkydiveInput {
  /** -1..1: + turns left (A). */
  turn: number;
  /** W: track (or, under canopy, nothing: the canopy flies at trim). */
  track: boolean;
  /** S: flare (freefall: spread out and slow; canopy: both toggles down). */
  flare: boolean;
  /** -1..1: head down (+) or back to belly; held. */
  headDown: number;
}

export interface SkydiveState {
  position: Vector3;
  velocity: Vector3;
  heading: number;
  /** Body position blends, 0..1: head down, tracking, flared. */
  headDown: number;
  track: number;
  flare: number;
  /** Canopy: null in freefall; otherwise seconds since the pull and the bank (rad). */
  canopy: { time: number; bank: number } | null;
  /** The opening was automatic. */
  aad: boolean;
  /** Set in the step it touched the ground: how fast down (m/s), and whether that's a crash. */
  landed: { sink: number; crash: boolean } | null;
  /** Deceleration this step (g), for the opening shock. */
  g: number;
}

export function createSkydiveState(): SkydiveState {
  return {
    position: new Vector3(),
    velocity: new Vector3(),
    heading: 0,
    headDown: 0,
    track: 0,
    flare: 0,
    canopy: null,
    aad: false,
    landed: null,
    g: 0,
  };
}

/** Canopy inflation 0..1 (an S curve over the opening time; nothing for the first 0.6 s). */
export function inflation(time: number): number {
  const t = Math.max(0, Math.min(1, (time - 0.6) / (SKYDIVE.canopy.openTime - 0.6)));
  return t * t * (3 - 2 * t);
}

/** Drag constant (1/m, at sea level) for a terminal speed: g / v². */
const k = (terminal: number) => SKYDIVE.gravity / (terminal * terminal);

const AIR = new Vector3();
const FORWARD = new Vector3();
const LIFT = new Vector3();
const STILL = new Vector3();

/** Pull: start opening the canopy (nothing if it's already out). */
export function openCanopy(s: SkydiveState, automatic = false): void {
  if (s.canopy) return;
  s.canopy = { time: 0, bank: 0 };
  s.aad = automatic;
}

/**
 * Advance the skydiver. `groundHeight(x, z)`; `wind` the air's motion (world m/s);
 * `temperature` (°C) or null for the standard atmosphere.
 */
export function stepSkydive(
  s: SkydiveState,
  input: SkydiveInput,
  dt: number,
  groundHeight: (x: number, z: number) => number,
  wind: Vector3 = STILL,
  temperature: number | null = null,
): void {
  s.landed = null;
  let left = dt;
  while (left > 1e-6 && !s.landed) {
    const h = Math.min(left, SKYDIVE.maxStep);
    stepOnce(s, input, h, groundHeight, wind, temperature);
    left -= h;
  }
}

function stepOnce(
  s: SkydiveState,
  input: SkydiveInput,
  h: number,
  groundHeight: (x: number, z: number) => number,
  wind: Vector3,
  temperature: number | null,
): void {
  const p = s.position;
  const v = s.velocity;
  const g = SKYDIVE.gravity;
  const sigma = airDensity(p.y, temperature) / RHO0;
  const before = v.clone();
  FORWARD.set(-Math.sin(s.heading), 0, -Math.cos(s.heading));
  AIR.copy(v).sub(wind);

  if (!s.canopy) {
    if (p.y - groundHeight(p.x, p.z) < SKYDIVE.aadHeight) openCanopy(s, true);
  }
  if (!s.canopy) {
    // Body position follows the input.
    const rate = Math.min(1, SKYDIVE.postureRate * h);
    s.headDown += ((input.headDown > 0 ? 1 : 0) - s.headDown) * rate;
    s.track += ((input.track ? 1 : 0) - s.track) * rate;
    s.flare += ((input.flare ? 1 : 0) - s.flare) * rate;
    s.heading += input.turn * SKYDIVE.turnRate * (1 - 0.6 * s.headDown) * h;
    // Drag from the blend of positions; tracking adds lift forward.
    const belly = k(SKYDIVE.bellySpeed);
    const terminalTrack = k(SKYDIVE.trackSpeed) / Math.SQRT2;
    let drag = belly;
    drag += (k(SKYDIVE.flareSpeed) - belly) * s.flare * (1 - s.headDown);
    drag += (terminalTrack - drag) * s.track * (1 - s.headDown);
    drag += (k(SKYDIVE.headDownSpeed) - drag) * s.headDown;
    const speed = AIR.length();
    v.addScaledVector(AIR, -drag * sigma * speed * h);
    // Lift square to the airflow, in the vertical plane of the heading: up and forward.
    if (speed > 1 && s.track > 0.01) {
      const dir = AIR.clone().divideScalar(speed);
      LIFT.copy(FORWARD).addScaledVector(dir, -FORWARD.dot(dir)).normalize();
      // Up-forward side of the airflow (the body's belly faces down).
      if (LIFT.y < 0) LIFT.negate();
      const lift = drag * SKYDIVE.trackGlide * s.track * (1 - s.headDown);
      v.addScaledVector(LIFT, lift * sigma * speed * speed * h);
    }
    v.y -= g * h;
  } else {
    const c = SKYDIVE.canopy;
    s.canopy.time += h;
    const open = inflation(s.canopy.time);
    // Toggles bank the canopy; both down flare it.
    const flare = input.flare ? 1 : 0;
    const bankTarget = input.turn * c.maxBank * (1 - 0.5 * flare);
    s.canopy.bank += Math.max(
      -c.rollRate * h,
      Math.min(c.rollRate * h, bankTarget - s.canopy.bank),
    );
    s.flare += (flare - s.flare) * Math.min(1, 3 * h);
    const speedTarget = c.trimSpeed + (c.brakeSpeed - c.trimSpeed) * s.flare;
    const sinkTarget = c.trimSink + (c.brakeSink - c.trimSink) * s.flare;
    // The body swings back upright under the canopy.
    s.headDown *= 1 - Math.min(1, 3 * h);
    s.track *= 1 - Math.min(1, 3 * h);
    if (open < 1) {
      // Opening: drag grows with the inflating canopy, peaking as it bites.
      const dragOpen = k(SKYDIVE.bellySpeed) + open * open * 0.12;
      const speed = AIR.length();
      v.addScaledVector(AIR, -dragOpen * Math.sqrt(sigma) * speed * h);
      v.y -= g * h;
      // The canopy starts flying forward as it fills.
      const along = AIR.dot(FORWARD);
      v.addScaledVector(FORWARD, (speedTarget - along) * open * 1.5 * h);
    } else {
      const speed = Math.max(Math.hypot(AIR.x, AIR.z), 1);
      s.heading += ((g * Math.tan(s.canopy.bank)) / Math.max(speed, 4)) * h;
      FORWARD.set(-Math.sin(s.heading), 0, -Math.cos(s.heading));
      const rate = Math.min(1, c.settle * h);
      // Airspeed along the heading and the sink, relaxing to the targets (a turn sinks more).
      const sink = sinkTarget / Math.cos(s.canopy.bank) ** 2;
      const air = AIR.clone();
      const horizontal = new Vector3(air.x, 0, air.z);
      const forward = horizontal.dot(FORWARD);
      horizontal.addScaledVector(FORWARD, -forward).multiplyScalar(1 - rate);
      const nextForward = forward + (speedTarget - forward) * rate;
      const nextUp = air.y + (-sink - air.y) * Math.min(1, 2.5 * h);
      v.copy(horizontal).addScaledVector(FORWARD, nextForward).add(wind);
      v.y = nextUp;
    }
  }
  s.g = before.sub(v).length() / h / g;
  p.addScaledVector(v, h);
  const ground = groundHeight(p.x, p.z);
  if (p.y <= ground) {
    const sink = Math.max(0, -v.y);
    const flying = !!s.canopy && inflation(s.canopy.time) > 0.7;
    s.landed = { sink, crash: !flying || sink > SKYDIVE.maxLandingSink };
    p.y = ground;
  }
}
