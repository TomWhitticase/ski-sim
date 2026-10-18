import { Vector3 } from 'three/webgpu';

/**
 * Skier as a point mass on the terrain surface. Deliberately forgiving: no falls or
 * crashes, a speed cap, and skis that grip well. Forces per unit mass:
 * - gravity, resolved along the slope
 * - snow friction (μ · normal load), higher off-piste than on groomed runs
 * - air drag (k · v²; lower in a tuck)
 * - skidding: when velocity and skis disagree, velocity swings toward the skis
 *   (carving) and the sideways component scrubs speed; a 90° turn is a hockey stop
 * Leaving a convex roll faster than the slope falls away makes you airborne.
 */
export const SKI = {
  gravity: 9.81,
  /** Groomed piste. */
  snowFriction: 0.045,
  /** Ungroomed off-piste snow: more resistance, plus extra drag ploughing through it. */
  powderFriction: 0.08,
  powderDrag: 0.0015,
  /** Drag coefficient (1/m): 0.5·ρ·CdA/m for ~0.6 m² upright, ~0.25 m² tucked, 80 kg. */
  dragUpright: 0.0045,
  dragTuck: 0.0018,
  /** How quickly velocity direction swings toward the skis (1/s). */
  carveRate: 2.8,
  /** Deceleration at a full sideways skid (m/s²): a hockey stop bites at ~0.7 g. */
  skidDecel: 8,
  /** Snowplough braking (m/s²). */
  brakeDecel: 4,
  /** Skating: strong enough to get moving on the flat, useless once you're quick. */
  pushAccel: 2.5,
  pushMaxSpeed: 6,
  maxSpeed: 38,
  jumpSpeed: 3.5,
  /** Height above the snow before we count as airborne (m). */
  airThreshold: 0.4,
  maxStep: 1 / 120,
};

export interface SkiTerrain {
  height(x: number, z: number): number;
  /** Whether the snow at (x, z) is a groomed piste. Treated as groomed if omitted. */
  groomed?(x: number, z: number): boolean;
}

export interface SkiState {
  /** Feet on the snow, world coordinates. */
  position: Vector3;
  velocity: Vector3;
  /** Ski direction; same convention as Look.yaw (0 = north, positive = left). */
  yaw: number;
  airborne: boolean;
}

export interface SkiIntent {
  tuck: boolean;
  push: boolean;
  brake: boolean;
  jump: boolean;
}

const NORMAL_STEP = 2;
const n = new Vector3();
const gravityAlong = new Vector3();
const skis = new Vector3();
const dir = new Vector3();
const target = new Vector3();

/** Upward unit surface normal at (x, z), in world axes. */
export function surfaceNormal(t: SkiTerrain, x: number, z: number, out: Vector3): Vector3 {
  const h = NORMAL_STEP;
  return out
    .set(t.height(x - h, z) - t.height(x + h, z), 2 * h, t.height(x, z - h) - t.height(x, z + h))
    .normalize();
}

/** Unit vector the skis point along, lying in the surface with normal `normal`. */
export function skiDirection(yaw: number, normal: Vector3, out: Vector3): Vector3 {
  out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  return out.addScaledVector(normal, -out.dot(normal)).normalize();
}

export function stepSki(state: SkiState, intent: SkiIntent, dt: number, terrain: SkiTerrain) {
  let remaining = dt;
  let jump = intent.jump;
  while (remaining > 1e-6) {
    const h = Math.min(remaining, SKI.maxStep);
    substep(state, { ...intent, jump }, h, terrain);
    jump = false;
    remaining -= h;
  }
}

function substep(state: SkiState, intent: SkiIntent, h: number, terrain: SkiTerrain): void {
  const p = state.position;
  const v = state.velocity;

  if (state.airborne) {
    v.y -= SKI.gravity * h;
    p.addScaledVector(v, h);
    const ground = terrain.height(p.x, p.z);
    if (p.y <= ground) {
      // Land: keep the motion along the slope, lose the part into it.
      p.y = ground;
      surfaceNormal(terrain, p.x, p.z, n);
      const into = v.dot(n);
      if (into < 0) v.addScaledVector(n, -into);
      state.airborne = false;
    }
    return;
  }

  surfaceNormal(terrain, p.x, p.z, n);
  // Gravity minus its component into the slope.
  gravityAlong.set(0, -SKI.gravity, 0).addScaledVector(n, SKI.gravity * n.y);
  v.addScaledVector(gravityAlong, h);

  skiDirection(state.yaw, n, skis);
  let speed = v.length();
  if (speed > 1e-4) {
    // Skis can run either way along their length (you can slide backwards).
    target.copy(skis).multiplyScalar(v.dot(skis) >= 0 ? 1 : -1);
    dir.copy(v).divideScalar(speed);
    const cos = Math.min(1, Math.abs(dir.dot(target)));
    const sideways = Math.sqrt(1 - cos * cos);
    // Skis grip and steer when roughly aligned (carving); the further across the path they
    // are, the more they just scrape sideways instead (skidding, hockey stop).
    const grip = cos * cos;
    dir.lerp(target, 1 - Math.exp(-SKI.carveRate * grip * h)).normalize();

    const groomed = terrain.groomed?.(p.x, p.z) ?? true;
    const friction = groomed ? SKI.snowFriction : SKI.powderFriction;
    const drag = (intent.tuck ? SKI.dragTuck : SKI.dragUpright) + (groomed ? 0 : SKI.powderDrag);
    const decel =
      friction * SKI.gravity * n.y +
      SKI.skidDecel * sideways +
      (intent.brake ? SKI.brakeDecel : 0) +
      drag * speed * speed;
    speed = Math.max(0, speed - decel * h);
    v.copy(dir).multiplyScalar(speed);
  }

  if (intent.push && !intent.brake && speed < SKI.pushMaxSpeed) {
    v.addScaledVector(skis, SKI.pushAccel * h);
  }
  if (v.length() > SKI.maxSpeed) v.setLength(SKI.maxSpeed);

  if (intent.jump) {
    v.addScaledVector(n, SKI.jumpSpeed);
    state.airborne = true;
    p.addScaledVector(v, h);
    return;
  }

  p.addScaledVector(v, h);
  const ground = terrain.height(p.x, p.z);
  if (p.y > ground + SKI.airThreshold) {
    state.airborne = true; // the slope fell away faster than we did
  } else {
    p.y = ground;
    surfaceNormal(terrain, p.x, p.z, n);
    v.addScaledVector(n, -v.dot(n)); // stay in the new surface plane
  }
}
