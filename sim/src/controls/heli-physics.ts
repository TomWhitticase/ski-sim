import { Euler, Quaternion, Vector3 } from 'three/webgpu';

import { airDensity, type HeliType, RHO0 } from './aircraft-types';
import { type AirConditions, type AirTerrain, STILL_AIR } from './plane-physics';

/**
 * A light single-engine helicopter, simplified but grounded in its numbers
 * (`aircraft-types.ts`), with the stability augmentation a casual pilot needs:
 * - rotor thrust along the rotor's axis, limited by power: momentum theory's induced
 *   power (Glauert's, so it falls with forward speed: translational lift), profile power,
 *   fuselage drag, climb power and the tail rotor's share, against the engine's power at
 *   the air's density (and the gearbox limit). Ground effect cuts the induced power
 *   within about a rotor diameter of the snow (Cheeseman–Bennett)
 * - collective is a vertical-speed command: W climbs, S descends (slowing to a gentle
 *   touchdown near the snow), hands off holds the height, as far as the power allows
 * - cyclic tilts the disc toward an attitude (up to ~20° nose down, ~25° bank); hands
 *   off levels it and gently brakes to a hover. Pedals yaw; with speed the fin
 *   weathervanes and banked turns coordinate themselves
 * - skids rest on slopes up to ~12°; steeper they slide, and past ~20° it rolls over
 * - crashes: a hard or fast touchdown, landing tilted, a rotor or the tail in the snow
 *
 * `position` is the middle of the skids, on the snow when landed. World axes x east,
 * y up, z south; body -z forward. `yaw` follows Look (0 north, + left).
 */

export interface HeliInput {
  /** -1..1: + climb, - descend, 0 hold the height. */
  collective: number;
  /** Cyclic, -1..1: + right, + forward. */
  cyclicX: number;
  cyclicY: number;
  /** Pedals, -1..1: + yaw right. */
  pedal: number;
}

export interface HeliState {
  position: Vector3;
  velocity: Vector3;
  yaw: number;
  /** Nose up (+), and right side down (+) (rad). */
  pitch: number;
  bank: number;
  yawRate: number;
  /** Rotor thrust (N). */
  thrust: number;
  /** Rotor revs as a share of governed (spins up from 0 when started). */
  rotor: number;
  /** Power used, as a share of what's available. */
  power: number;
  onGround: boolean;
  crash: number;
  crashed: string | null;
  impact: number;
  airspeed: number;
  mass: number;
}

export const HELI_CRASH_TIME = 2.5;
const MAX_STEP = 1 / 120;
const G = 9.81;
/** Spool-up from a standstill to flying revs (s). */
const SPOOL_TIME = 4;
/** Climb and descent rates the collective asks for (m/s). */
const CLIMB = 8;
const DESCEND = 6;

const E = new Euler(0, 0, 0, 'YXZ');
const Q = new Quaternion();
const U = new Vector3();
const VA = new Vector3();
const FORCE = new Vector3();
const FH = new Vector3();
const RH = new Vector3();
const TMP = new Vector3();
const N = new Vector3();

export function createHeliState(type: HeliType): HeliState {
  return {
    position: new Vector3(),
    velocity: new Vector3(),
    yaw: 0,
    pitch: 0,
    bank: 0,
    yawRate: 0,
    thrust: 0,
    rotor: 0,
    power: 0,
    onGround: true,
    crash: 0,
    crashed: null,
    impact: 0,
    airspeed: 0,
    mass: type.mass,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Engine power available (W): take-off power falling with density, capped by the gearbox. */
export function heliAvailablePower(type: HeliType, rho: number): number {
  return Math.min(type.engine.transmission, type.engine.takeoff * (rho / RHO0) ** 0.85);
}

/**
 * Power the rotors need (W) for `thrust` N at `speed` m/s through the air, climbing at
 * `climb` m/s, with the hub `height` m above the snow.
 */
export function powerRequired(
  type: HeliType,
  thrust: number,
  rho: number,
  speed: number,
  climb = 0,
  height = Infinity,
): number {
  const R = type.rotorRadius;
  const area = Math.PI * R * R;
  const vh2 = thrust / (2 * rho * area);
  const s2 = speed * speed;
  const vi = Math.sqrt((-s2 + Math.sqrt(s2 * s2 + 4 * vh2 * vh2)) / 2);
  // Ground effect: within a rotor diameter or so, the snow props the downwash up. It
  // fades as forward speed blows the wake behind.
  const z = Math.max(height, R / 3.5);
  const ge = 1 - (R / (4 * z)) ** 2 * Math.exp(-speed / 8);
  const induced = type.inducedFactor * thrust * vi * ge;
  const profile = type.profilePower * (rho / RHO0) * (1 + 3 * (speed / 215) ** 2);
  const parasite = 0.5 * rho * type.dragArea * speed * speed * speed;
  return (
    (induced + profile) * (1 + type.tailShare) +
    parasite +
    (thrust * Math.max(0, climb)) / type.climbEfficiency
  );
}

/** Most thrust (N) the power allows in these conditions. */
export function maxThrust(
  type: HeliType,
  rho: number,
  speed: number,
  climb: number,
  height: number,
  available: number,
): number {
  let lo = 0;
  let hi = 60_000;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (powerRequired(type, mid, rho, speed, climb, height) > available) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** Power to hover (W) at a mass, density and hub height. */
export function hoverPower(type: HeliType, mass: number, rho: number, height = Infinity): number {
  return powerRequired(type, mass * G, rho, 0, 0, height);
}

/** The heli's orientation (body -z forward, rotor axis +y). */
export function heliOrientation(s: HeliState, out: Quaternion): Quaternion {
  return out.setFromEuler(E.set(s.pitch, s.yaw, -s.bank, 'YXZ'));
}

/** A world point fixed to the heli (body coordinates from the skids' middle). */
export function heliPoint(s: HeliState, x: number, y: number, z: number, out: Vector3): Vector3 {
  return out.set(x, y, z).applyQuaternion(heliOrientation(s, Q)).add(s.position);
}

/**
 * The ground under the skids: a plane through the heights at their four ends. Returns
 * its normal in `out` and the height at the middle.
 */
export function skidGround(
  type: HeliType,
  terrain: AirTerrain,
  x: number,
  z: number,
  yaw: number,
  out: Vector3,
): number {
  const g = type.ground;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const at = (ahead: number, side: number) =>
    terrain.height(x + fx * ahead + rx * side, z + fz * ahead + rz * side);
  const fl = at(g.skidFront, -g.skidHalf);
  const fr = at(g.skidFront, g.skidHalf);
  const bl = at(-g.skidBack, -g.skidHalf);
  const br = at(-g.skidBack, g.skidHalf);
  const length = g.skidFront + g.skidBack;
  const rise = (fl + fr - bl - br) / 2 / length; // up per metre forward
  const tilt = (fr + br - fl - bl) / 2 / (2 * g.skidHalf); // up per metre right
  // Normal of a plane rising `rise` forward and `tilt` right.
  out.set(-(rx * tilt + fx * rise), 1, -(rz * tilt + fz * rise)).normalize();
  // The skids rest on the highest pair (they bridge a dip between).
  return Math.max((fl + fr + bl + br) / 4, terrain.height(x, z));
}

function startCrash(s: HeliState, why: string): void {
  s.crash = HELI_CRASH_TIME;
  s.crashed = why;
  s.yawRate = 0;
}

export function stepHeli(
  s: HeliState,
  input: HeliInput,
  dt: number,
  type: HeliType,
  terrain: AirTerrain,
  air: AirConditions = STILL_AIR,
): void {
  s.impact = 0;
  let left = dt;
  while (left > 1e-6) {
    const h = Math.min(left, MAX_STEP);
    stepOnce(s, input, h, type, terrain, air);
    left -= h;
  }
}

function stepOnce(
  s: HeliState,
  input: HeliInput,
  h: number,
  type: HeliType,
  terrain: AirTerrain,
  air: AirConditions,
): void {
  const p = s.position;
  const v = s.velocity;
  if (s.crash > 0) {
    s.crash = Math.max(0, s.crash - h);
    s.rotor = Math.max(0, s.rotor - 0.6 * h);
    s.thrust = 0;
    v.multiplyScalar(Math.exp(-3 * h));
    v.y -= G * h;
    p.addScaledVector(v, h);
    const ground = terrain.height(p.x, p.z);
    if (p.y <= ground) {
      p.y = ground;
      v.y = Math.max(0, v.y);
      v.multiplyScalar(Math.exp(-4 * h));
    }
    return;
  }
  s.rotor = Math.min(1, s.rotor + h / SPOOL_TIME);
  const rho = airDensity(p.y, air.temperature);
  VA.copy(v).sub(air.wind);
  FH.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
  RH.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
  const forward = VA.dot(FH);
  const sideways = VA.dot(RH);
  const horizontal = Math.sqrt(forward * forward + sideways * sideways);
  s.airspeed = VA.length();
  const ground = skidGround(type, terrain, p.x, p.z, s.yaw, N);
  const height = Math.max(0, p.y - ground);
  const g = type.ground;

  // Cyclic: an attitude; hands off it levels and brakes toward a hover.
  let targetPitch = -input.cyclicY * 0.35;
  let targetBank = input.cyclicX * 0.42;
  if (Math.abs(input.cyclicX) < 0.03 && Math.abs(input.cyclicY) < 0.03) {
    targetPitch = clamp(0.035 * v.dot(FH), -0.2, 0.2);
    targetBank = clamp(-0.035 * v.dot(RH), -0.2, 0.2);
  }
  // Pedals, the fin weathervaning and turn coordination as the speed builds.
  const flying = clamp((horizontal - 10) / 15, 0, 1);
  const slip = Math.atan2(sideways, Math.max(Math.abs(forward), 5));
  let yawTarget = -input.pedal * 1.0 - 2 * slip * flying;
  yawTarget -= ((G * Math.tan(s.bank)) / Math.max(horizontal, 12)) * flying;

  // Collective: a climb or descent rate (slowing to ~1 m/s near the snow), or hold.
  const descent = Math.min(DESCEND, 0.8 + 0.5 * height);
  const vsCmd =
    input.collective > 0
      ? CLIMB * input.collective
      : input.collective < 0
        ? descent * input.collective
        : 0;

  if (s.onGround) {
    groundStep(s, input, h, type, terrain, rho, vsCmd, ground, height);
    return;
  }
  const k = Math.min(1, 3 * h);
  s.pitch += clamp((targetPitch - s.pitch) * k, -0.9 * h, 0.9 * h);
  s.bank += clamp((targetBank - s.bank) * k, -1.0 * h, 1.0 * h);
  s.yawRate += (yawTarget - s.yawRate) * Math.min(1, 4 * h);
  s.yaw += s.yawRate * h;

  heliOrientation(s, Q);
  U.set(0, 1, 0).applyQuaternion(Q);
  const available = heliAvailablePower(type, rho) * s.rotor;
  const tmax = maxThrust(type, rho, horizontal, Math.max(0, v.y), height + g.hub, available);
  const want = (s.mass * (G + 2.5 * (vsCmd - v.y))) / Math.max(U.y, 0.5);
  const target = clamp(want, 0, tmax);
  s.thrust += (target - s.thrust) * Math.min(1, 5 * h);
  s.power =
    powerRequired(type, s.thrust, rho, horizontal, Math.max(0, v.y), height + g.hub) /
    Math.max(heliAvailablePower(type, rho), 1);

  FORCE.copy(U).multiplyScalar(s.thrust);
  FORCE.y -= s.mass * G;
  // Blowback: the disc flaps away from the airflow, so a hovering heli drifts with the wind
  // (and resists going faster).
  if (horizontal > 0.01) {
    const blow = (s.thrust * 0.012) / (1 + horizontal / 12);
    FORCE.x -= blow * (forward * FH.x + sideways * RH.x);
    FORCE.z -= blow * (forward * FH.z + sideways * RH.z);
  }
  const drag = 0.5 * rho * type.dragArea * s.airspeed;
  FORCE.addScaledVector(VA, -drag);
  FORCE.y -= 0.5 * rho * type.verticalDragArea * Math.abs(VA.y) * VA.y;
  v.addScaledVector(FORCE, h / s.mass);
  p.addScaledVector(v, h);
  touchdown(s, type, terrain);
}

/** Rotor and tail clear of the snow? Returns what hit, if anything. */
function strikes(s: HeliState, type: HeliType, terrain: AirTerrain): string | null {
  const R = type.rotorRadius;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    heliPoint(s, Math.cos(a) * R, type.ground.hub, Math.sin(a) * R, TMP);
    if (TMP.y < terrain.height(TMP.x, TMP.z)) return 'Rotor strike';
  }
  heliPoint(s, -0.35, 2.1, type.length - R - type.tailRadius, TMP);
  if (TMP.y < terrain.height(TMP.x, TMP.z)) return 'Tail rotor strike';
  return null;
}

function touchdown(s: HeliState, type: HeliType, terrain: AirTerrain): void {
  const p = s.position;
  const v = s.velocity;
  const g = type.ground;
  const ground = skidGround(type, terrain, p.x, p.z, s.yaw, N);
  const strike = strikes(s, type, terrain);
  if (p.y > ground) {
    if (strike) startCrash(s, strike);
    return;
  }
  heliOrientation(s, Q);
  U.set(0, 1, 0).applyQuaternion(Q);
  const sink = -v.y;
  const slide = Math.sqrt(v.x * v.x + v.z * v.z);
  const slope = Math.acos(clamp(N.y, -1, 1));
  if (sink > g.maxSink) return startCrash(s, 'Hard landing');
  if (slide > g.maxSlide) return startCrash(s, 'Skids caught');
  if (Math.acos(clamp(U.dot(N), -1, 1)) > 0.3 || slope > g.tipSlope) {
    return startCrash(s, 'Rolled over');
  }
  if (strike) return startCrash(s, strike);
  s.onGround = true;
  s.impact = Math.max(0, sink);
  p.y = ground;
  v.y = 0;
}

/** Sitting on the skids: the ground sets the attitude; lift off once the rotor carries it. */
function groundStep(
  s: HeliState,
  input: HeliInput,
  h: number,
  type: HeliType,
  terrain: AirTerrain,
  rho: number,
  vsCmd: number,
  ground: number,
  height: number,
): void {
  const p = s.position;
  const v = s.velocity;
  const g = type.ground;
  // The skids sit on the slope: attitude from the ground plane under them.
  FH.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
  RH.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
  const along = FH.addScaledVector(N, -FH.dot(N)).normalize();
  const across = RH.addScaledVector(N, -RH.dot(N)).normalize();
  const k = Math.min(1, 10 * h);
  s.pitch += (Math.asin(clamp(along.y, -1, 1)) - s.pitch) * k;
  s.bank += (-Math.asin(clamp(across.y, -1, 1)) - s.bank) * k;

  const available = heliAvailablePower(type, rho) * s.rotor;
  const tmax = maxThrust(type, rho, 0, 0, height + g.hub, available);
  // Flat pitch on the skids until the collective comes up.
  const want = vsCmd > 0 ? s.mass * (G + 2.5 * vsCmd) : 0.1 * s.mass * G;
  s.thrust += (Math.min(want, tmax) - s.thrust) * Math.min(1, 5 * h);
  s.power =
    powerRequired(type, s.thrust, rho, 0, 0, height + g.hub) /
    Math.max(heliAvailablePower(type, rho), 1);
  const light = s.thrust / (s.mass * G);
  // Light on the skids, the pedals turn it.
  s.yawRate = light > 0.6 ? -input.pedal * 0.8 * (light - 0.6) * 2.5 : 0;
  s.yaw += s.yawRate * h;

  const slope = Math.acos(clamp(N.y, -1, 1));
  if (slope > g.tipSlope) return startCrash(s, 'Rolled over');
  if (light > N.y && vsCmd > 0) {
    // Lifting off.
    s.onGround = false;
    v.y = Math.max(v.y, 0.1);
    p.y = ground + 0.02;
    return;
  }
  // Skids grip up to `maxSlope`; steeper, they slide down the fall line.
  const fall = TMP.set(N.x, 0, N.z);
  const weight = 1 - light;
  const speed = Math.sqrt(v.x * v.x + v.z * v.z);
  if (slope > g.maxSlope && fall.lengthSq() > 1e-9) {
    fall.normalize();
    const accel = G * weight * (Math.sin(slope) - 0.15 * Math.cos(slope));
    v.addScaledVector(fall, Math.max(0, accel) * h);
  } else if (speed > 0) {
    // Friction stops everything else.
    const stop = 0.5 * G * Math.max(weight, 0.1) * h;
    v.multiplyScalar(Math.max(0, speed - stop) / speed);
  }
  v.y = 0;
  p.x += v.x * h;
  p.z += v.z * h;
  p.y = skidGround(type, terrain, p.x, p.z, s.yaw, N);
}
