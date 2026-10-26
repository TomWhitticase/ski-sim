import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';

import { airDensity, type PlaneType, RHO0 } from './aircraft-types';

/**
 * A light STOL plane as a rigid body with simplified flight controls, grounded in the
 * type's real numbers (`aircraft-types.ts`):
 * - lift and drag from airspeed and angle of attack through the air (wind subtracted),
 *   with flaps adding lift and drag; past the critical angle lift sags to ~70 % (a
 *   gentle, recoverable stall: the nose drops, let the stick go and it flies again)
 * - turboprop thrust: power over airspeed, capped by static thrust; the engine is
 *   flat-rated, so it keeps full power up to ~2,000 m and then loses it with density
 * - forgiving fly-by-wire style controls: the stick asks for an angle of attack (hands
 *   off is trim), the ailerons for a roll rate (hands off levels the wings), the rudder
 *   for yaw on top of the fin's weathervaning, so turns coordinate themselves
 * - ground roll on wheels (cleared tarmac: wheel brakes) or skis (snow: drag brakes,
 *   more rolling resistance, much more in powder); tailwheel steering; reverse thrust on
 *   the ground; gravity along a sloped runway (land uphill, take off downhill)
 * - crashes: a hard touchdown, the prop or a wingtip in the snow
 *
 * World axes as everywhere: x east, y up, z south. Body: -z forward, +y up, +x right.
 * `position` is the main gear's contact point (between the wheels, on the snow).
 */

export type Surface = 'paved' | 'groomed' | 'powder';

export interface AirTerrain {
  height(x: number, z: number): number;
  /** What's underfoot: a cleared runway, groomed snow or powder (default groomed). */
  surface?(x: number, z: number): Surface;
}

export interface AirConditions {
  /** The air's own motion (world m/s). */
  wind: Vector3;
  /** Air temperature where you are (°C), or null for the standard atmosphere's. */
  temperature: number | null;
}

export const STILL_AIR: AirConditions = { wind: new Vector3(), temperature: null };

export interface PlaneInput {
  /** Stick, -1..1: back (+) pulls the nose up. */
  pitch: number;
  /** Stick, -1..1: + rolls right. On the ground it steers the tailwheel too. */
  roll: number;
  /** Rudder pedals, -1..1: + yaws (and steers) right. */
  yaw: number;
  /** Power lever, 0..1 (below 0 is reverse, on the ground only). */
  throttle: number;
  brake: boolean;
  /** Flap setting asked for: 0 up, 1 take-off, 2 landing. */
  flaps: number;
}

export interface PlaneState {
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  /** Body rates (rad/s): x pitch up, y yaw left, z roll left. */
  rates: Vector3;
  /** Flap position (0..2, moves toward the setting). */
  flaps: number;
  onGround: boolean;
  /** On the ground: nose-up attitude above the ground (0 tail up … three-point). */
  groundPitch: number;
  /** Seconds left of a crash (0 when flying or rolling). */
  crash: number;
  /** Why it crashed, while it's crashing. */
  crashed: string | null;
  /** Touchdown sink rate (m/s) in the step it touched down, else 0. */
  impact: number;
  /** Air data this step. */
  alpha: number;
  airspeed: number;
  stall: boolean;
  stallWarning: boolean;
  /** Propeller revs as a share of governed (spins up from 0 when started). */
  rpm: number;
  /** Rate the flight path turns in the pitch plane (rad/s), feeding the pitch control. */
  pathRate: number;
  mass: number;
}

/** How long a crash lasts before you're put back upright (s). */
export const CRASH_TIME = 2.5;
/** Largest physics step (s). */
const MAX_STEP = 1 / 120;
/** Dynamic pressure for full control authority (Pa, ~30 m/s at sea level). */
const AUTHORITY_Q = 550;
const G = 9.81;

const F = new Vector3();
const U = new Vector3();
const R = new Vector3();
const VA = new Vector3();
const FORCE = new Vector3();
const LIFT_DIR = new Vector3();
const N = new Vector3();
const GF = new Vector3();
const GR = new Vector3();
const TMP = new Vector3();
const TMP2 = new Vector3();
const Q = new Quaternion();
const BASIS = new Matrix4();

export function createPlaneState(type: PlaneType): PlaneState {
  return {
    position: new Vector3(),
    velocity: new Vector3(),
    orientation: new Quaternion(),
    rates: new Vector3(),
    flaps: 0,
    onGround: true,
    groundPitch: type.ground.threePoint,
    crash: 0,
    crashed: null,
    impact: 0,
    alpha: 0,
    airspeed: 0,
    stall: false,
    stallWarning: false,
    rpm: 0,
    pathRate: 0,
    mass: type.mass,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Linear between a table's entries at a fractional index. */
function interp(table: readonly number[], at: number): number {
  const i = clamp(at, 0, table.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(table.length - 1, lo + 1);
  return table[lo]! + (table[hi]! - table[lo]!) * (i - lo);
}

/** Angle of attack where the wing stalls (rad) at a flap position. */
export function stallAlpha(type: PlaneType, flaps: number): number {
  const a = type.aero;
  return (interp(a.clMax, flaps) - a.cl0 - interp(a.flapLift, flaps)) / a.clAlpha;
}

/** Lift coefficient: linear to the stall, then sagging to `stallLift` of its maximum. */
export function liftCoefficient(type: PlaneType, alpha: number, flaps: number): number {
  const a = type.aero;
  const clMax = interp(a.clMax, flaps);
  const stall = stallAlpha(type, flaps);
  const base = a.cl0 + interp(a.flapLift, flaps);
  if (alpha <= stall) {
    // Inverted the wing stalls sooner (cambered aerofoil).
    return Math.max(base + a.clAlpha * alpha, -0.8 * clMax);
  }
  const past = (alpha - stall) / 0.12;
  let cl = clMax * (a.stallLift + (1 - a.stallLift) * Math.exp(-past * past));
  // Far past the stall it's a flat plate: lift goes to nothing at 90°.
  if (alpha > 0.7)
    cl *= Math.max(0, Math.cos(((alpha - 0.7) / (Math.PI / 2 - 0.7)) * (Math.PI / 2)));
  return cl;
}

export function dragCoefficient(type: PlaneType, alpha: number, flaps: number, cl: number): number {
  const a = type.aero;
  const stalled = alpha > stallAlpha(type, flaps);
  const s = Math.sin(alpha);
  return a.cd0 + interp(a.flapDrag, flaps) + a.k * cl * cl + (stalled ? 1.2 : 0.1) * s * s;
}

/** Engine power available (W) in air of density `rho`: flat-rated, then falling with density. */
export function availablePower(type: PlaneType, rho: number): number {
  const e = type.engine;
  return Math.min(e.rated, e.thermodynamic * (rho / RHO0));
}

/** Propeller thrust (N) at a lever setting (-1..1), true airspeed (m/s) and air density. */
export function planeThrust(type: PlaneType, lever: number, airspeed: number, rho: number): number {
  const e = type.engine;
  const sigma = rho / RHO0;
  if (lever < 0) return lever * e.reverse * e.staticThrust * sigma;
  const power = availablePower(type, rho);
  const share = e.idle + (1 - e.idle) * lever;
  // Static thrust from momentum theory goes as (ρ·P²)^(1/3).
  const staticThrust = e.staticThrust * Math.cbrt(sigma * ((power * share) / e.rated) ** 2);
  return Math.min(staticThrust, (e.propEfficiency * power * share) / Math.max(airspeed, 1));
}

/** Level-flight stall speed (m/s true airspeed) at a mass, density and flap setting. */
export function stallSpeed(type: PlaneType, mass: number, rho: number, flaps: number): number {
  return Math.sqrt((2 * mass * G) / (rho * type.wingArea * interp(type.aero.clMax, flaps)));
}

/**
 * Steady climb rate (m/s) at true airspeed `speed`, full power: excess power over weight.
 * The best over all speeds is the published maximum rate of climb.
 */
export function climbRate(
  type: PlaneType,
  mass: number,
  rho: number,
  speed: number,
  flaps = 0,
): number {
  const q = 0.5 * rho * speed * speed;
  const cl = (mass * G) / (q * type.wingArea);
  if (cl > interp(type.aero.clMax, flaps)) return -Infinity;
  const alpha = (cl - type.aero.cl0 - interp(type.aero.flapLift, flaps)) / type.aero.clAlpha;
  const drag = q * type.wingArea * dragCoefficient(type, alpha, flaps, cl);
  const thrust = planeThrust(type, 1, speed, rho);
  return ((thrust - drag) * speed) / (mass * G);
}

/** Body axes of an orientation: forward (-z), up (+y), right (+x). */
function axes(q: Quaternion): void {
  F.set(0, 0, -1).applyQuaternion(q);
  U.set(0, 1, 0).applyQuaternion(q);
  R.set(1, 0, 0).applyQuaternion(q);
}

/** Ground normal from heights 2 m either side (smooths the lidar's small creases). */
function groundNormal(terrain: AirTerrain, x: number, z: number, out: Vector3): Vector3 {
  const d = 2;
  const dx = terrain.height(x + d, z) - terrain.height(x - d, z);
  const dz = terrain.height(x, z + d) - terrain.height(x, z - d);
  return out.set(-dx / (2 * d), 1, -dz / (2 * d)).normalize();
}

/** Bank angle (rad, right wing down +) of the current axes. */
function bankAngle(): number {
  return Math.atan2(-R.y, U.y);
}

/**
 * The plane's orientation sitting on the ground: pointing along `yaw` (Look convention),
 * wings across the slope, the nose `pitch` above the ground.
 */
export function groundOrientation(yaw: number, normal: Vector3, pitch: number, out: Quaternion) {
  GF.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  GF.addScaledVector(normal, -GF.dot(normal)).normalize();
  GR.crossVectors(GF, normal);
  TMP.copy(GF).negate();
  BASIS.makeBasis(GR, normal, TMP);
  out.setFromRotationMatrix(BASIS);
  Q.setFromAxisAngle(TMP2.set(1, 0, 0), pitch);
  return out.multiply(Q);
}

/** Heading of the nose (Look convention: 0 north, + left). */
export function planeYaw(s: PlaneState): number {
  F.set(0, 0, -1).applyQuaternion(s.orientation);
  return Math.atan2(-F.x, -F.z);
}

/** A world point fixed to the plane (body coordinates, from the main gear's contact). */
export function bodyPoint(s: PlaneState, x: number, y: number, z: number, out: Vector3): Vector3 {
  return out.set(x, y, z).applyQuaternion(s.orientation).add(s.position);
}

function startCrash(s: PlaneState, why: string): void {
  s.crash = CRASH_TIME;
  s.crashed = why;
  s.rates.set(0, 0, 0);
  s.stall = false;
  s.stallWarning = false;
}

/** Points that mustn't touch the snow: prop tip (lowest), wingtips. */
function strikes(s: PlaneState, type: PlaneType, terrain: AirTerrain): string | null {
  const geo = type.geometry;
  bodyPoint(s, 0, geo.propHub[0] - type.engine.propDiameter / 2, geo.propHub[1], TMP);
  if (TMP.y < terrain.height(TMP.x, TMP.z) - 0.05) return 'Prop strike';
  for (const side of [-1, 1]) {
    bodyPoint(s, (side * type.span) / 2, geo.wingY, 0, TMP);
    if (TMP.y < terrain.height(TMP.x, TMP.z) - 0.05) return 'Wingtip in the snow';
  }
  return null;
}

/** Advance the plane by `dt` seconds. */
export function stepPlane(
  s: PlaneState,
  input: PlaneInput,
  dt: number,
  type: PlaneType,
  terrain: AirTerrain,
  air: AirConditions = STILL_AIR,
): void {
  s.impact = 0;
  let left = dt;
  while (left > 1e-6) {
    const h = Math.min(left, MAX_STEP);
    const crashing = s.crash > 0;
    stepOnce(s, input, h, type, terrain, air);
    left -= h;
    // A crash just ended: stop, so the controller puts you back on the ground first.
    if (crashing && s.crash === 0) break;
  }
}

function stepOnce(
  s: PlaneState,
  input: PlaneInput,
  h: number,
  type: PlaneType,
  terrain: AirTerrain,
  air: AirConditions,
): void {
  const p = s.position;
  const v = s.velocity;
  if (s.crash > 0) {
    // Crashing: everything grinds to a halt where it hit.
    s.crash = Math.max(0, s.crash - h);
    v.multiplyScalar(Math.exp(-3 * h));
    v.y -= G * h;
    p.addScaledVector(v, h);
    const ground = terrain.height(p.x, p.z);
    if (p.y <= ground) {
      p.y = ground;
      v.y = Math.max(0, v.y);
      v.multiplyScalar(Math.exp(-4 * h));
    }
    s.rpm = Math.max(0, s.rpm - 0.8 * h);
    return;
  }
  // Flaps run at about two seconds a notch; the prop governs to its revs.
  s.flaps += clamp(input.flaps - s.flaps, -0.5 * h, 0.5 * h);
  const rpmTarget = input.throttle < 0 ? 0.9 : 0.62 + 0.38 * input.throttle;
  s.rpm += clamp(rpmTarget - s.rpm, -0.5 * h, 0.35 * h);
  const lever = input.throttle < 0 && !s.onGround ? 0 : input.throttle;

  axes(s.orientation);
  const rho = airDensity(p.y, air.temperature);
  VA.copy(v).sub(air.wind);
  const V = VA.length();
  const along = VA.dot(F);
  const alpha = V > 2 ? Math.atan2(-VA.dot(U), along) : s.onGround ? s.groundPitch : 0;
  const beta = V > 2 ? Math.atan2(VA.dot(R), Math.max(Math.abs(along), 1)) : 0;
  const q = 0.5 * rho * V * V;
  const liftCoeff = liftCoefficient(type, alpha, s.flaps);
  const cd = dragCoefficient(type, alpha, s.flaps, liftCoeff);
  const aStall = stallAlpha(type, s.flaps);
  s.alpha = alpha;
  s.airspeed = V;

  // Forces: lift square to the airflow in the plane of symmetry, drag against it,
  // sideforce from sideslip, thrust along the nose, weight.
  FORCE.set(0, -s.mass * G, 0);
  if (V > 0.5) {
    TMP.copy(VA).divideScalar(V);
    LIFT_DIR.copy(U).addScaledVector(TMP, -U.dot(TMP)).normalize();
    FORCE.addScaledVector(LIFT_DIR, liftCoeff * q * type.wingArea);
    FORCE.addScaledVector(TMP, -cd * q * type.wingArea);
    if (!s.onGround)
      FORCE.addScaledVector(R, -beta * type.aero.sideForce * q * type.wingArea * 0.15);
  } else {
    LIFT_DIR.copy(U);
  }
  // At idle on the ground the prop's in beta (flat pitch): no thrust to creep on.
  const thrust =
    s.onGround && lever === 0
      ? 0
      : planeThrust(type, lever, Math.max(0, along), rho) * Math.min(1, s.rpm / 0.6);
  FORCE.addScaledVector(F, thrust);

  // Control authority grows with dynamic pressure; the prop's slipstream helps the tail.
  const authority = clamp(q / AUTHORITY_Q, 0, 1.3);
  const tail = Math.min(1.3, authority + 0.3 * Math.max(0, lever));
  const alphaCmd =
    input.pitch >= 0
      ? type.trimAlpha + input.pitch * (aStall + 0.06 - type.trimAlpha)
      : type.trimAlpha + input.pitch * (type.trimAlpha + 0.14);

  if (s.onGround) {
    groundStep(s, input, h, type, terrain, alphaCmd, tail);
  } else {
    // Pitch: hold the asked-for angle of attack, following the flight path round.
    const accelLift = FORCE.dot(LIFT_DIR) / s.mass;
    s.pathRate = V > 3 ? accelLift / V : 0;
    // The stick asks for the flight path to curve up (back) or down; hands off it levels
    // out. The angle of attack that takes is held short of the stall, unless the stick's
    // pulled right back.
    const gamma = V > 3 ? Math.asin(clamp(VA.y / V, -1, 1)) : 0;
    const wantRate = Math.abs(input.pitch) > 0.04 ? 0.45 * input.pitch : -0.25 * gamma;
    const lift = s.mass * (V * wantRate + G * Math.cos(gamma));
    const cl = lift / Math.max(q * type.wingArea, 1);
    const top = aStall - 0.03 + Math.max(0, input.pitch - 0.85) * 0.6;
    const flapLift = type.aero.cl0 + interp(type.aero.flapLift, s.flaps);
    const alphaWant = clamp((cl - flapLift) / type.aero.clAlpha, -0.15, top);
    let pitchCmd = s.pathRate + 3 * (alphaWant - alpha);
    if (alpha > aStall) pitchCmd -= 1.5 * (alpha - aStall); // the stalled nose drops
    pitchCmd = clamp(pitchCmd, -1.1 * tail, 1.1 * tail);
    // Roll: a rate from the stick; hands off, the wings come level.
    const bank = bankAngle();
    const rollCmd =
      (Math.abs(input.roll) > 0.02 ? 1.5 * input.roll : Math.abs(bank) < 1.3 ? -0.9 * bank : 0) *
      Math.min(1, authority);
    // Yaw: rudder, plus the fin turning the nose into the airflow.
    const yawCmd = clamp(input.yaw * 0.5 * tail + 3 * beta * Math.min(1, authority), -1, 1);
    const k = Math.min(1, 6 * h);
    s.rates.x += (pitchCmd - s.rates.x) * k;
    s.rates.y += (-yawCmd - s.rates.y) * k;
    s.rates.z += (-rollCmd - s.rates.z) * k;
    Q.setFromAxisAngle(TMP.copy(s.rates).normalize(), s.rates.length() * h);
    if (s.rates.lengthSq() > 0) s.orientation.multiply(Q).normalize();

    v.addScaledVector(FORCE, h / s.mass);
    p.addScaledVector(v, h);
    s.stall = alpha > aStall && V > 3;
    s.stallWarning = alpha > aStall - 0.07 && V > 3;
    touchdown(s, type, terrain);
  }
}

/** In the air: touching the snow lands it, unless it's too hard or the wrong way up. */
function touchdown(s: PlaneState, type: PlaneType, terrain: AirTerrain): void {
  const p = s.position;
  const v = s.velocity;
  const ground = terrain.height(p.x, p.z);
  axes(s.orientation);
  // Tail first (a three-point or tail-low landing): the nose comes down onto the mains.
  const geo = type.ground;
  const tailY = geo.tailArm * Math.tan(geo.threePoint);
  bodyPoint(s, 0, tailY, geo.tailArm, TMP2);
  const tailGround = terrain.height(TMP2.x, TMP2.z);
  if (TMP2.y < tailGround && p.y > ground) {
    const angle = Math.min(0.2, (tailGround - TMP2.y) / geo.tailArm);
    s.orientation.multiply(Q.setFromAxisAngle(TMP.set(1, 0, 0), -angle));
    s.rates.x = Math.min(s.rates.x, 0);
  }
  const strike = strikes(s, type, terrain);
  if (p.y > ground) {
    if (strike) startCrash(s, strike);
    return;
  }
  groundNormal(terrain, p.x, p.z, N);
  const sink = -v.dot(N);
  const nose = Math.asin(clamp(F.dot(N), -1, 1));
  if (sink > geo.maxSink) return startCrash(s, 'Hard landing');
  if (nose < -0.07) return startCrash(s, 'Prop strike');
  if (U.dot(N) < 0.8) return startCrash(s, 'Wingtip in the snow');
  if (strike) return startCrash(s, strike);
  s.onGround = true;
  s.impact = Math.max(0, sink);
  s.groundPitch = clamp(nose, 0, geo.threePoint);
  p.y = ground;
  v.addScaledVector(N, -v.dot(N));
  s.rates.set(0, 0, 0);
  s.stall = false;
  s.stallWarning = false;
}

/** Rolling on wheels or skis: steering, brakes, gravity along the slope, lift-off. */
function groundStep(
  s: PlaneState,
  input: PlaneInput,
  h: number,
  type: PlaneType,
  terrain: AirTerrain,
  alphaCmd: number,
  tail: number,
): void {
  const p = s.position;
  const v = s.velocity;
  const geo = type.ground;
  groundNormal(terrain, p.x, p.z, N);
  const yaw = Math.atan2(-F.x, -F.z);
  GF.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  GF.addScaledVector(N, -GF.dot(N)).normalize();
  GR.crossVectors(GF, N);
  const fn = FORCE.dot(N);
  const speed = v.dot(GF);
  // Lifted off: the wing carries more than the weight pressing it on the snow.
  if (fn > 0 && speed > 8) {
    s.onGround = false;
    s.pathRate = 0;
    s.rates.set(0, 0, 0);
    v.addScaledVector(FORCE, h / s.mass);
    p.addScaledVector(v, h);
    return;
  }
  const load = Math.max(0, -fn);
  const surface = terrain.surface?.(p.x, p.z) ?? 'groomed';
  const rolling =
    surface === 'paved'
      ? geo.rollingPaved
      : surface === 'powder'
        ? geo.rollingPowder
        : geo.rollingGroomed;
  const brake = input.brake ? (surface === 'paved' ? geo.brakePaved : geo.brakeSnow) : 0;
  const push = FORCE.dot(GF);
  let along = speed + (push / s.mass) * h;
  const friction = ((rolling + brake) * load) / s.mass;
  if (Math.abs(along) <= friction * h && Math.abs(speed) < 0.5)
    along = 0; // held still
  else along -= Math.sign(along) * Math.min(Math.abs(along), friction * h);
  // Sideways the wheels or skis grip (snow less than tarmac).
  const grip = (surface === 'paved' ? 0.6 : 0.35) * G * h;
  let side = v.dot(GR) + (FORCE.dot(GR) / s.mass) * h;
  side -= Math.sign(side) * Math.min(Math.abs(side), grip);
  v.copy(GF).multiplyScalar(along).addScaledVector(GR, side);

  // Tailwheel steering (sharp at taxi speed, a few degrees fast) and the rudder.
  const steer = clamp(input.yaw + input.roll, -1, 1);
  const lock = 0.08 + 0.45 * Math.exp(-Math.abs(along) / 6);
  let yawRate = (along * Math.tan(steer * lock)) / geo.tailArm + input.yaw * 0.25 * tail;
  yawRate = clamp(yawRate, -0.8, 0.8);
  const newYaw = yaw - yawRate * h;
  s.rates.set(0, -yawRate, 0);

  // Tail down when slow; with speed the elevator lifts it to the stick's attitude.
  const lift = clamp((Math.abs(along) - 10) / 12, 0, 1);
  const target = geo.threePoint * (1 - lift) + clamp(alphaCmd, 0, geo.threePoint) * lift;
  s.groundPitch += clamp(target - s.groundPitch, -0.4 * h, 0.4 * h);

  p.addScaledVector(v, h);
  p.y = terrain.height(p.x, p.z);
  groundNormal(terrain, p.x, p.z, N);
  groundOrientation(newYaw, N, s.groundPitch, s.orientation);
  s.stall = false;
  s.stallWarning = false;
  s.pathRate = 0;
  // Too steep across: a wingtip goes in.
  if (Math.abs(GR.y) > Math.sin(0.33)) startCrash(s, 'Wingtip in the snow');
}
