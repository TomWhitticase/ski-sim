import { Vector3 } from 'three/webgpu';

/**
 * A paraglider as a point mass hanging under a wing. Simplified but grounded in real
 * numbers for an intermediate (EN-B) wing:
 * - trim ~38 km/h with ~1.1 m/s sink (glide ~9.5:1); speed bar ~50 km/h at ~1.9 m/s;
 *   brakes ~28 km/h at ~1.4 m/s
 * - banking turns at rate g·tan(bank)/v, and costs height (sink / cos² bank)
 * - momentum carries over: extra speed bleeds off over a few seconds, converted to
 *   climb (a zoom), and a slow wing dives to pick speed back up
 */
export const GLIDER = {
  gravity: 9.81,
  trimSpeed: 10.5,
  trimSink: 1.1,
  barSpeed: 14,
  barSink: 1.9,
  brakeSpeed: 7.8,
  brakeSink: 1.4,
  maxBank: (40 * Math.PI) / 180,
  /** Bank angle per second while turning (rad/s). */
  rollRate: 1.2,
  /** How fast airspeed settles to the target (1/s). */
  speedRate: 0.6,
  /** How fast the flight path settles to the target sink (1/s). */
  sinkRate: 1.5,
  /** Share of surplus kinetic energy turned into climb while slowing. */
  zoomEfficiency: 0.7,
  maxStep: 1 / 60,
};

export interface GliderState {
  /** Pilot's feet, world coordinates. */
  position: Vector3;
  velocity: Vector3;
  /** Direction the wing flies (Look.yaw convention: 0 = north, + = left). */
  heading: number;
  /** Bank angle (rad, > 0 = banked left). */
  bank: number;
}

export interface GliderInput {
  /** -1..1, > 0 turns left. */
  turn: number;
  bar: boolean;
  brake: boolean;
}

const forward = new Vector3();

export function gliderTarget(input: GliderInput): { speed: number; sink: number } {
  if (input.bar) return { speed: GLIDER.barSpeed, sink: GLIDER.barSink };
  if (input.brake) return { speed: GLIDER.brakeSpeed, sink: GLIDER.brakeSink };
  return { speed: GLIDER.trimSpeed, sink: GLIDER.trimSink };
}

/** Advance the glider. Returns true if the pilot's feet reached the ground. */
export function stepGlider(
  state: GliderState,
  input: GliderInput,
  dt: number,
  groundHeight: (x: number, z: number) => number,
): boolean {
  let remaining = dt;
  while (remaining > 1e-6) {
    const h = Math.min(remaining, GLIDER.maxStep);
    if (substep(state, input, h, groundHeight)) return true;
    remaining -= h;
  }
  return false;
}

function substep(
  state: GliderState,
  input: GliderInput,
  h: number,
  groundHeight: (x: number, z: number) => number,
): boolean {
  const v = state.velocity;
  const target = gliderTarget(input);

  // Roll toward the commanded bank; the wing levels itself when you let go.
  const wantBank = Math.max(-1, Math.min(1, input.turn)) * GLIDER.maxBank;
  const dBank = wantBank - state.bank;
  state.bank += Math.sign(dBank) * Math.min(Math.abs(dBank), GLIDER.rollRate * h);

  let speed = Math.hypot(v.x, v.z);
  state.heading += (GLIDER.gravity * Math.tan(state.bank) * h) / Math.max(speed, 4);

  // Airspeed settles toward the target. Surplus energy shed while slowing becomes climb;
  // a slow wing dives (extra sink) to recover speed.
  const newSpeed = speed + (target.speed - speed) * (1 - Math.exp(-GLIDER.speedRate * h));
  const shed = (speed * speed - newSpeed * newSpeed) / 2; // J/kg
  speed = newSpeed;

  const sink = target.sink / Math.cos(state.bank) ** 2;
  // Energy balance: climb rate = power shed / (m·g). Speeding up costs height the same way.
  const efficiency = shed > 0 ? GLIDER.zoomEfficiency : 1;
  const wantVy = -sink + (efficiency * shed) / (h * GLIDER.gravity);
  v.y += (wantVy - v.y) * (1 - Math.exp(-GLIDER.sinkRate * h));

  forward.set(-Math.sin(state.heading), 0, -Math.cos(state.heading));
  v.x = forward.x * speed;
  v.z = forward.z * speed;

  state.position.addScaledVector(v, h);
  const ground = groundHeight(state.position.x, state.position.z);
  if (state.position.y <= ground) {
    state.position.y = ground;
    return true;
  }
  return false;
}
