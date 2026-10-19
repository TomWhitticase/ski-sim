import { Vector3 } from 'three/webgpu';

import type { SkiTerrain } from './ski-physics';

/**
 * A mountain snowmobile as a point mass riding a plane fitted under its footprint (front
 * skis to the back of the track), so it bridges dips and sits on crests. Real numbers for
 * a ~150 hp, 155" track mountain sled (~220 kg) with an 85 kg rider:
 * - drive: engine power through a CVT, so the push is power / speed, limited by the
 *   track's grip on the snow (≈ 0.55 g groomed, 0.6 g with paddles in powder); the CVT runs
 *   out of ratio around 125 km/h. Holding the throttle with the track spinning sends roost
 *   flying and slides you back down a slope that's too steep
 * - rolling resistance from the track and suspension, v² air drag (CdA ~1 m², thin air)
 * - powder: the sled sinks in when slow (bogs down) and planes up on top when fast
 * - steering: the skis turn the sled like a bicycle (rate v·tan(steer) / wheelbase), but
 *   only as hard as the front skis can grip, so turns widen with speed. Leaning in adds
 *   grip; leaning uphill holds a side-hill traverse
 * - lateral grip: the track and ski keels resist sliding sideways up to ~0.5 g, so a
 *   steep traverse slips down the fall line
 * - brake: a disc on the drive shaft locks the track; S at a standstill reverses slowly
 * Forgiving like ski mode: no rollovers or crashes. Off a crest you fly; throttle in the
 * air lifts the nose (the spinning track), the brake drops it, and you always land.
 */
export const SLED = {
  gravity: 9.81,
  /** Sled + rider (kg). */
  mass: 305,
  /** Power reaching the snow (W): ~150 hp at the crank less clutch and track losses. */
  power: 70_000,
  /** The CVT is fully shifted out at the rev limiter (m/s, ~125 km/h). */
  gearSpeed: 35,
  /** Hard cap downhill (m/s, ~160 km/h). */
  maxSpeed: 45,
  /** Track grip (fraction of the normal load) on groomed snow and in powder. */
  tractionGroomed: 0.55,
  tractionPowder: 0.6,
  /** A spinning (slipping) track grips less than one that's hooked up. */
  spinTraction: 0.8,
  /** Rolling resistance on groomed snow; a parked sled (off the throttle) holds a bit more. */
  rolling: 0.035,
  rollingStatic: 0.1,
  /** Track drivetrain losses that grow with speed (1/s). */
  trackLoss: 0.015,
  /** Air drag 0.5·ρ·CdA / m (1/m): ρ ≈ 0.9 kg/m³ at 2,400 m, CdA ≈ 1 m². */
  drag: 0.00148,
  /** Powder: how deep a stopped sled sinks (m), and the speed it planes up at (m/s). */
  sinkDepth: 0.35,
  planeSpeed: 8,
  /** Powder resistance: base plus the bow wave of a sunk sled (fraction of load). */
  powderResist: 0.05,
  powderSinkResist: 0.12,
  /** Snow thrown aside by the hood, skis and track in powder (1/m). */
  powderDrag: 0.006,
  /** Sideways grip of the track and ski keels (fraction of load). */
  lateralGroomed: 0.5,
  lateralPowder: 0.65,
  /** Front skis: distance to the track's contact centre (m), and their steering lock (rad). */
  wheelbase: 1.6,
  maxSteer: (22 * Math.PI) / 180,
  /** How fast the bars swing (rad/s). */
  steerRate: 2.5,
  /** Front ski grip (fraction of load); leaning in adds up to `leanGrip` of it. */
  frontGroomed: 0.45,
  frontPowder: 0.35,
  leanGrip: 0.35,
  /** Weight on the uphill running board: extra side-hill grip at full lean. */
  sidehillGrip: 0.4,
  /** Locked-track braking (m/s²), never more than the snow can take. */
  brakeDecel: 6,
  /** Reverse: full power, but geared down to a walking pace (m/s, m/s² before grip). */
  reverseSpeed: 3,
  reverseAccel: 4,
  /** Height above the snow before it counts as airborne (m). */
  airThreshold: 0.3,
  /** In the air: throttle lifts the nose, the brake drops it (rad/s²); damping (1/s). */
  airThrottlePitch: 1.4,
  airBrakePitch: 2.2,
  airLevel: 1.5,
  airDamping: 1.2,
  /** Most the nose can point off the flight path in the air, and off level (rad). */
  maxAirOffPath: 0.6,
  maxAirPitch: 0.8,
  /** Below this horizontal speed a falling sled stays level rather than nosing down (m/s). */
  aimSpeed: 12,
  /** Suspension: natural frequency (Hz), damping ratio, travel (m). */
  suspensionHz: 1.8,
  suspensionDamping: 0.45,
  suspensionTravel: 0.22,
  /** Engine: idle, clutch engagement, peak power and rev limiter (rpm). */
  idleRpm: 1600,
  engageRpm: 4200,
  peakRpm: 8000,
  limiterRpm: 8300,
  maxStep: 1 / 120,
};

export interface SledState {
  /** Centre of the track's contact patch, world coordinates. */
  position: Vector3;
  velocity: Vector3;
  /** Direction the sled points (Look.yaw convention: 0 = north, + = left). */
  yaw: number;
  /** Bar angle (rad, > 0 = steering left). */
  steer: number;
  airborne: boolean;
  /** Nose above the horizontal (rad). On the snow it follows the slope. */
  pitch: number;
  pitchRate: number;
  /** How deep the sled sits in the snow (m). */
  sink: number;
  /** Suspension compression (m, > 0 = compressed) and its rate (m/s). */
  suspension: number;
  suspensionRate: number;
  rpm: number;
  /** How much the track is spinning on the snow (0..1): roost. */
  slip: number;
  /** Vertical impact speed (m/s) on the step you land in, else 0. */
  impact: number;
}

export interface SledInput {
  /** 0..1 */
  throttle: number;
  brake: boolean;
  /** Reverse gear engaged (S held at a standstill). */
  reverse?: boolean;
  /** -1..1, > 0 steers left. */
  steer: number;
  /** Rider's weight shift, -1..1, > 0 = to the left. */
  lean?: number;
}

export function createSledState(position = new Vector3(), yaw = 0): SledState {
  return {
    position: position.clone(),
    velocity: new Vector3(),
    yaw,
    steer: 0,
    airborne: false,
    pitch: 0,
    pitchRate: 0,
    sink: 0,
    suspension: 0,
    suspensionRate: 0,
    rpm: SLED.idleRpm,
    slip: 0,
    impact: 0,
  };
}

/** Footprint: skis this far ahead of the track's contact centre, track this far behind. */
const FRONT = 1.2;
const BACK = 1.3;
const FRONT_HALF_WIDTH = 0.45;
const BACK_HALF_WIDTH = 0.25;

const n = new Vector3();
const fwd = new Vector3();
const right = new Vector3();
const flat = new Vector3();
const flatRight = new Vector3();
const along = new Vector3();
const across = new Vector3();
const gravityAlong = new Vector3();

/** Horizontal unit vector the sled points along (yaw 0 = north = -z). */
export function heading(yaw: number, out: Vector3): Vector3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/**
 * The plane the sled rests on at (x, z) facing `yaw`, fitted to the snow under the skis
 * and the track: writes its upward normal to `out` and returns the height under the
 * contact centre (the higher of the plane and the snow right there, so it sits on crests).
 */
export function sledSurface(
  t: SkiTerrain,
  x: number,
  z: number,
  yaw: number,
  out: Vector3,
): number {
  heading(yaw, flat);
  flatRight.set(-flat.z, 0, flat.x);
  const h = (a: number, s: number) =>
    t.height(x + flat.x * a + flatRight.x * s, z + flat.z * a + flatRight.z * s);
  const fl = h(FRONT, -FRONT_HALF_WIDTH);
  const fr = h(FRONT, FRONT_HALF_WIDTH);
  const bl = h(-BACK, -BACK_HALF_WIDTH);
  const br = h(-BACK, BACK_HALF_WIDTH);
  const front = (fl + fr) / 2;
  const back = (bl + br) / 2;
  along
    .copy(flat)
    .multiplyScalar(FRONT + BACK)
    .setY(front - back);
  // Average the two axles' widths for the cross slope.
  const width = FRONT_HALF_WIDTH + BACK_HALF_WIDTH;
  across
    .copy(flatRight)
    .multiplyScalar(width)
    .setY((fr + br - fl - bl) / 2);
  out.crossVectors(across, along).normalize();
  // Height of the plane at the contact centre (the plane passes through the mean sample).
  const mean = (fl + fr + bl + br) / 4;
  const planeAtCentre = mean + ((back - front) / (FRONT + BACK)) * ((FRONT - BACK) / 2);
  return Math.max(planeAtCentre, t.height(x, z));
}

/** Track grip available (m/s²) on this snow, on a surface with normal `normal`. */
function traction(groomed: boolean, normal: Vector3): number {
  return (groomed ? SLED.tractionGroomed : SLED.tractionPowder) * SLED.gravity * normal.y;
}

/** Push the engine can put through the track at this speed (m/s², before grip). */
export function drivePush(speed: number): number {
  return SLED.power / (SLED.mass * Math.max(Math.abs(speed), 2));
}

/** Advance the sled by `dt` seconds. */
export function stepSled(state: SledState, input: SledInput, dt: number, terrain: SkiTerrain) {
  let remaining = dt;
  state.impact = 0;
  while (remaining > 1e-6) {
    const h = Math.min(remaining, SLED.maxStep);
    substep(state, input, h, terrain);
    remaining -= h;
  }
}

function substep(state: SledState, input: SledInput, h: number, terrain: SkiTerrain): void {
  const p = state.position;
  const v = state.velocity;
  const throttle = Math.max(0, Math.min(1, input.throttle));
  const lean = Math.max(-1, Math.min(1, input.lean ?? 0));

  // The bars swing toward where you point them.
  const wantSteer = Math.max(-1, Math.min(1, input.steer)) * SLED.maxSteer;
  const dSteer = wantSteer - state.steer;
  state.steer += Math.sign(dSteer) * Math.min(Math.abs(dSteer), SLED.steerRate * h);
  const vyBefore = v.y;

  if (state.airborne) {
    v.y -= SLED.gravity * h;
    v.multiplyScalar(1 - SLED.drag * v.length() * h);
    // Throttle spins the track up and its momentum lifts the nose; the brake stops it
    // and the nose drops. Otherwise the sled settles toward its flight path.
    const path = flightAim(v);
    const torque =
      throttle * SLED.airThrottlePitch -
      (input.brake ? SLED.airBrakePitch : 0) -
      SLED.airLevel * (state.pitch - path) -
      SLED.airDamping * state.pitchRate;
    state.pitchRate += torque * h;
    state.pitch += state.pitchRate * h;
    // Never further round than a rider could ride out.
    const lo = Math.max(path - SLED.maxAirOffPath, -SLED.maxAirPitch);
    const hi = Math.min(path + SLED.maxAirOffPath, SLED.maxAirPitch);
    if (state.pitch < lo || state.pitch > hi) {
      state.pitch = Math.max(lo, Math.min(hi, state.pitch));
      state.pitchRate = 0;
    }
    state.rpm = approachRpm(state.rpm, throttle > 0 ? SLED.limiterRpm : SLED.idleRpm, h);
    state.slip = throttle;
    p.addScaledVector(v, h);
    const ground = sledSurface(terrain, p.x, p.z, state.yaw, n);
    if (p.y <= ground) {
      // Touchdown: keep the motion along the snow, the suspension soaks up the rest.
      p.y = ground;
      const into = v.dot(n);
      if (into < 0) v.addScaledVector(n, -into);
      state.impact = Math.max(state.impact, -into);
      state.airborne = false;
      // Landing nose-high or nose-down scrubs some speed (but never throws you off).
      heading(state.yaw, fwd);
      fwd.addScaledVector(n, -fwd.dot(n)).normalize();
      const error = Math.abs(state.pitch - Math.asin(fwd.y));
      if (error > 0.35) v.multiplyScalar(1 - Math.min(0.25, (error - 0.35) * 0.6));
      state.pitch = Math.asin(fwd.y);
      state.pitchRate = 0;
      springKick(state, -into);
    }
    settleSuspension(state, h);
    return;
  }

  sledSurface(terrain, p.x, p.z, state.yaw, n);
  heading(state.yaw, fwd);
  fwd.addScaledVector(n, -fwd.dot(n)).normalize();
  right.crossVectors(fwd, n);
  state.pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
  const groomed = terrain.groomed?.(p.x, p.z) ?? true;
  const load = SLED.gravity * n.y;
  let vLong = v.dot(fwd);

  // Steering: the skis turn the sled like a bicycle's front wheel, but only as hard as
  // they can grip; leaning into the turn adds grip.
  const front =
    (groomed ? SLED.frontGroomed : SLED.frontPowder) * (1 + SLED.leanGrip * Math.abs(lean));
  const maxRate = (front * load) / Math.max(Math.abs(vLong), 1);
  const yawRate = (vLong * Math.tan(state.steer)) / SLED.wheelbase;
  state.yaw += Math.max(-maxRate, Math.min(maxRate, yawRate)) * h;

  // Powder: sunk in when slow, planing on top when fast. Groomed snow barely gives.
  const sinkTarget = groomed ? 0.03 : SLED.sinkDepth / (1 + (v.length() / SLED.planeSpeed) ** 2);
  state.sink += (sinkTarget - state.sink) * (1 - Math.exp(-3 * h));
  const sunk = groomed ? 0 : state.sink / SLED.sinkDepth;

  // Gravity: the snow only pushes back (below), so off a crest you keep going up.
  gravityAlong.set(0, -SLED.gravity, 0).addScaledVector(n, SLED.gravity * n.y);
  v.y -= SLED.gravity * h;

  // Drive: engine power through the CVT, limited by track grip. When the engine could
  // push harder than the snow holds, the track spins (roost).
  const grip = traction(groomed, n) * (vLong < -0.3 && throttle > 0 ? SLED.spinTraction : 1);
  let drive = 0;
  if (input.reverse && !input.brake) {
    if (vLong > -SLED.reverseSpeed) drive = -Math.min(SLED.reverseAccel, grip);
    state.slip = 0;
  } else if (throttle > 0) {
    const push = throttle * drivePush(vLong);
    const gearing = Math.max(0, Math.min(1, (SLED.gearSpeed - vLong) / 2));
    drive = Math.min(push, grip) * gearing;
    state.slip = throttle * Math.max(0, Math.min(1, 1 - grip / push));
  } else {
    state.slip = 0;
  }
  v.addScaledVector(fwd, drive * h);

  // Resistance along the track: rolling (more to break a parked sled free), powder, the
  // brake. It slows you to a stop but never pushes you backwards.
  vLong = v.dot(fwd);
  const parked = Math.abs(vLong) < 0.3 && throttle === 0 && !input.reverse;
  const rolling =
    (groomed
      ? parked
        ? SLED.rollingStatic
        : SLED.rolling
      : SLED.powderResist + SLED.powderSinkResist * sunk) * load;
  const brake = input.brake ? Math.min(SLED.brakeDecel, traction(groomed, n)) : 0;
  const resist = (rolling + brake + SLED.trackLoss * Math.abs(vLong)) * h;
  v.addScaledVector(fwd, -Math.sign(vLong) * Math.min(Math.abs(vLong), resist));

  // Sideways: the keels and track edges grip, up to a limit; beyond it the sled slides
  // (a steep traverse slips down the fall line). Weight on the uphill board holds it.
  const vLat = v.dot(right);
  const uphillLean = lean * gravityAlong.dot(right) < 0 ? 0 : Math.abs(lean);
  const lateral =
    (groomed ? SLED.lateralGroomed : SLED.lateralPowder) *
    (1 + SLED.sidehillGrip * uphillLean) *
    load *
    h;
  if (Math.abs(vLat) <= lateral) {
    // Fully hooked up: the turn swings the velocity round rather than scrubbing it.
    const speed = v.length();
    v.addScaledVector(right, -vLat);
    if (Math.abs(vLat) < 0.5 * Math.abs(v.dot(fwd)) && v.lengthSq() > 1e-8) v.setLength(speed);
  } else {
    v.addScaledVector(right, -Math.sign(vLat) * lateral);
  }

  // Air drag, and the snow powder throws aside.
  const speed = v.length();
  v.multiplyScalar(Math.max(0, 1 - (SLED.drag + (groomed ? 0 : SLED.powderDrag)) * speed * h));
  if (v.length() > SLED.maxSpeed) v.setLength(SLED.maxSpeed);

  // Engine: the CVT holds it near peak power under full throttle; it idles off it.
  const target =
    throttle > 0 || input.reverse
      ? SLED.engageRpm +
        (SLED.peakRpm - SLED.engageRpm) *
          Math.min(1, (input.reverse ? 0.3 : throttle) * (0.75 + 0.25 * Math.min(1, speed / 15)))
      : SLED.idleRpm;
  state.rpm = approachRpm(state.rpm, target, h);

  p.addScaledVector(v, h);
  const ground = sledSurface(terrain, p.x, p.z, state.yaw, n);
  if (p.y > ground + SLED.airThreshold) {
    // The snow fell away faster than we did: launch along the way we were going.
    state.airborne = true;
    state.pitch = flightAim(v);
    state.pitchRate = 0;
  } else if (p.y <= ground) {
    p.y = ground;
    const into = v.dot(n);
    if (into < 0) v.addScaledVector(n, -into);
    // The ground pushing the chassis up (a compression) or dropping away (rebound).
    springKick(state, v.y - vyBefore);
  }
  settleSuspension(state, h);
}

/**
 * Where the nose settles in the air: along the flight path when you're going somewhere,
 * level when dropping more or less straight down (no nose-diving off a standstill).
 */
function flightAim(v: Vector3): number {
  const horizontal = Math.hypot(v.x, v.z);
  const path = Math.atan2(v.y, horizontal) * Math.min(1, horizontal / SLED.aimSpeed);
  return Math.max(-SLED.maxAirOffPath, Math.min(SLED.maxAirOffPath, path));
}

function approachRpm(rpm: number, target: number, h: number): number {
  const d = target - rpm;
  // Revs up fast, falls a bit slower.
  return rpm + Math.max(-6000 * h, Math.min(9000 * h, d));
}

/** The ground's vertical velocity changed by `dv`: the sprung mass lags behind it. */
function springKick(state: SledState, dv: number): void {
  state.suspensionRate += dv;
}

function settleSuspension(state: SledState, h: number): void {
  const w = 2 * Math.PI * SLED.suspensionHz;
  const accel = -w * w * state.suspension - 2 * SLED.suspensionDamping * w * state.suspensionRate;
  state.suspensionRate += accel * h;
  state.suspension += state.suspensionRate * h;
  // Bottomed out or fully extended: the stops take it.
  const min = -0.4 * SLED.suspensionTravel;
  if (state.suspension > SLED.suspensionTravel || state.suspension < min) {
    state.suspension = Math.max(min, Math.min(SLED.suspensionTravel, state.suspension));
    state.suspensionRate = 0;
  }
}
