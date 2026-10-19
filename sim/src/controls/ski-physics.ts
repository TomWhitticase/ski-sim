import { Vector3 } from 'three/webgpu';

import { DEFAULT_HANDLING, type SkiHandling } from './ski-setup';

/**
 * Skier as a point mass on the terrain surface. Deliberately forgiving: no falls or
 * crashes, a speed cap, and skis that grip well. Forces per unit mass:
 * - gravity, resolved along the slope
 * - snow friction (μ · normal load), higher off-piste than on groomed runs
 * - air drag (k · v²; lower in a tuck)
 * - skidding: when velocity and skis disagree, velocity swings toward the skis
 *   (carving) and the sideways component scrubs speed; a 90° turn is a hockey stop
 * - chatter: past the skis' stable speed they wash out and scrub speed
 * Leaving a convex roll faster than the slope falls away makes you airborne.
 * Ski-dependent numbers (friction, carve rate, float, speed cap...) come from the
 * `SkiHandling` passed to `stepSki`; the rest are the skier and the mountain.
 */
export const SKI = {
  gravity: 9.81,
  /** Drag coefficient (1/m): 0.5·ρ·CdA/m for ~0.6 m² upright, ~0.25 m² tucked, 80 kg. */
  dragUpright: 0.0045,
  dragTuck: 0.0018,
  /** Snowplough braking (m/s²). */
  brakeDecel: 4,
  /** Skating: strong enough to get moving on the flat, useless once you're quick. */
  pushAccel: 2.5,
  pushMaxSpeed: 6,
  /** Double-poling: a gentler push that keeps you going on the flat. */
  poleAccel: 1.5,
  poleMaxSpeed: 9,
  /** Walking uphill: fastest on gentle grades, a slow plod on steep ones (m/s). */
  climbSpeedMax: 1.3,
  climbSpeedMin: 0.35,
  /** Uphill pull along the skis (m/s²) beyond which skating gives way to stepping. */
  climbThreshold: 0.8,
  jumpSpeed: 3.5,
  /** Height above the snow before we count as airborne (m). */
  airThreshold: 0.4,
  maxStep: 1 / 120,
};

export interface SkiTerrain {
  height(x: number, z: number): number;
  /** Whether the snow at (x, z) is a groomed piste. Treated as groomed if omitted. */
  groomed?(x: number, z: number): boolean;
  /** Push a body out of solid things (buildings, station walls); adjusts velocity. */
  collide?(position: Vector3, velocity: Vector3): void;
}

export interface SkiState {
  /** Feet on the snow, world coordinates. */
  position: Vector3;
  velocity: Vector3;
  /** Ski direction; same convention as Look.yaw (0 = north, positive = left). */
  yaw: number;
  airborne: boolean;
  /** Stepping uphill (herringbone / side-step) this step. */
  climbing?: boolean;
}

export interface SkiIntent {
  tuck: boolean;
  push: boolean;
  /** Double-poling (too fast to skate). */
  pole?: boolean;
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

export function stepSki(
  state: SkiState,
  intent: SkiIntent,
  dt: number,
  terrain: SkiTerrain,
  skis: SkiHandling = DEFAULT_HANDLING,
) {
  let remaining = dt;
  let jump = intent.jump;
  while (remaining > 1e-6) {
    const h = Math.min(remaining, SKI.maxStep);
    substep(state, { ...intent, jump }, h, terrain, skis);
    jump = false;
    remaining -= h;
  }
}

function substep(
  state: SkiState,
  intent: SkiIntent,
  h: number,
  terrain: SkiTerrain,
  ski: SkiHandling,
): void {
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

  // Walking uphill: with W held and the skis pointing up a slope too steep to skate,
  // step up it (herringbone / side-step). Slow, but you can never get stuck.
  skiDirection(state.yaw, n, skis);
  const uphillPull = -gravityAlong.dot(skis);
  const climbSpeed = Math.max(
    SKI.climbSpeedMin,
    SKI.climbSpeedMax - (SKI.climbSpeedMax - SKI.climbSpeedMin) * Math.min(1, (1 - n.y) / 0.3),
  );
  state.climbing =
    intent.push &&
    !intent.brake &&
    uphillPull > SKI.climbThreshold &&
    v.dot(skis) <= climbSpeed + 0.3;
  if (state.climbing) {
    v.lerp(target.copy(skis).multiplyScalar(climbSpeed), 1 - Math.exp(-8 * h));
    p.addScaledVector(v, h);
    p.y = terrain.height(p.x, p.z);
    surfaceNormal(terrain, p.x, p.z, n);
    v.addScaledVector(n, -v.dot(n));
    return;
  }
  v.addScaledVector(gravityAlong, h);

  skiDirection(state.yaw, n, skis);
  if (intent.push && !intent.brake && v.length() < SKI.pushMaxSpeed) {
    // Skating or stepping along a traverse you set your edges: they hold the sideways
    // slip instead of scraping all your speed away (which would pin you in place).
    v.copy(target.copy(skis).multiplyScalar(v.dot(skis)));
  }
  let speed = v.length();
  if (speed > 1e-4) {
    // Skis can run either way along their length (you can slide backwards).
    target.copy(skis).multiplyScalar(v.dot(skis) >= 0 ? 1 : -1);
    dir.copy(v).divideScalar(speed);
    const cos = Math.min(1, Math.abs(dir.dot(target)));
    const sideways = Math.sqrt(1 - cos * cos);
    const groomed = terrain.groomed?.(p.x, p.z) ?? true;
    // Skis grip and steer when roughly aligned (carving); the further across the path they
    // are, the more they just scrape sideways instead (skidding, hockey stop). On hard snow
    // sharp edges and camber hold further across the path; in powder, float steers.
    const bite = groomed ? ski.hardGrip : 1;
    const grip = cos ** (2 / bite);
    // Stiff skis need speed to bend into a carve; past their stable speed any ski chatters.
    const bend = 1 - 0.4 * ski.stiffness * Math.max(0, 1 - speed / 8);
    const over = Math.max(0, speed - ski.stableSpeed);
    const washout = 1 / (1 + over / 10);
    const carve = ski.carveRate * (groomed ? bite : ski.powderGrip) * bend * washout;
    dir.lerp(target, 1 - Math.exp(-carve * grip * h)).normalize();

    const friction = groomed ? ski.snowFriction : ski.powderFriction;
    const drag = (intent.tuck ? SKI.dragTuck : SKI.dragUpright) + (groomed ? 0 : ski.powderDrag);
    const decel =
      friction * SKI.gravity * n.y +
      ski.skidDecel * Math.sqrt(bite) * sideways +
      ski.chatter * over +
      (intent.brake ? SKI.brakeDecel : 0) +
      drag * speed * speed;
    speed = Math.max(0, speed - decel * h);
    v.copy(dir).multiplyScalar(speed);
  }

  if (intent.push && !intent.brake && speed < SKI.pushMaxSpeed) {
    v.addScaledVector(skis, SKI.pushAccel * h);
  }
  if (intent.pole && !intent.brake && speed < SKI.poleMaxSpeed) {
    v.addScaledVector(skis, SKI.poleAccel * h);
  }
  if (v.length() > ski.maxSpeed) v.setLength(ski.maxSpeed);

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
