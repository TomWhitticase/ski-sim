import { Vector3 } from 'three/webgpu';

import { DEFAULT_HANDLING, type SkiHandling } from './ski-setup';

/**
 * Skier as a point mass on the terrain surface. Deliberately forgiving: a speed cap,
 * skis that grip well, and the only falls are botched flip landings. Forces per unit mass:
 * - gravity, resolved along the slope
 * - snow friction (μ · normal load), higher off-piste than on groomed runs
 * - air drag (k · v²; lower in a tuck)
 * - skidding: when velocity and skis disagree, velocity swings toward the skis
 *   (carving) and the sideways component scrubs speed; a 90° turn is a hockey stop
 * - chatter: past the skis' stable speed they wash out and scrub speed
 * - rails: almost frictionless whichever way the skis point (a boardslide runs as well as
 *   riding it straight), with a spring pulling you onto the centreline
 * Leaving a lip or a convex roll faster than the slope falls away makes you airborne:
 * checked by looking `liftLook` ahead along your ballistic path. In the air
 * leaning ([ / ]) pitches you into a front flip or backflip; land with the skis within
 * `SKI.landTolerance` of the slope to ski on, otherwise you crash and slide to a stop.
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
  /**
   * W skates below `skateMaxSpeed` and double-poles above it (m/s, ~16 km/h). Once poling
   * it keeps poling down to `poleMinSpeed` (~13 km/h): on a gentle climb skating gets you
   * past the switch but poling can't hold you there, so one threshold flipped between
   * the two every frame or two.
   */
  skateMaxSpeed: 4.5,
  poleMinSpeed: 3.5,
  /** Walking uphill: fastest on gentle grades, a slow plod on steep ones (m/s). */
  climbSpeedMax: 1.3,
  climbSpeedMin: 0.35,
  /** Uphill pull along the skis (m/s²) beyond which skating gives way to stepping. */
  climbThreshold: 0.8,
  jumpSpeed: 3.5,
  /**
   * Ollie (snowboard): a jump popped off the loaded tail. More pop than a flat jump, and the
   * nose lifts as you leave (a nose-up pitch rate the spotting then brings back for landing).
   */
  ollieBoost: 1.3,
  olliePop: 2.4,
  /** Flips: the pitch rate holding [ or ] builds in the air (rad/s), and how fast (rad/s²). */
  flipRate: 5,
  flipAccel: 9,
  /**
   * Let go and the rotation eases off at this rate (1/s) while you spot the landing:
   * the skis turn toward the slope below (at the nearest whole turn) at up to
   * `spotRate` rad/s, `spotGain` per radian off.
   */
  flipDamping: 8,
  spotGain: 4,
  spotRate: 2.5,
  /** Skis within this of the slope at touchdown ski on cleanly (rad). */
  landClean: (15 * Math.PI) / 180,
  /** Up to this costs speed (`sketchyLoss` of it at the limit); beyond it you crash (rad). */
  landTolerance: (35 * Math.PI) / 180,
  sketchyLoss: 0.35,
  /** Crash: tumble and slide to a stop (drag 1/s), swinging round to face downhill. */
  crashTime: 1.8,
  crashDrag: 2.5,
  crashTurn: 3,
  /** Leaning on the snow, at full lean: forward sharpens the carve, back floats in powder. */
  leanCarve: 0.2,
  leanFloat: 0.25,
  /** Height above the snow before we count as airborne (m). */
  airThreshold: 0.4,
  /**
   * Take-off look-ahead: if, this long ahead (s) and halfway there, your ballistic path
   * would be more than `liftGap` (m) above the snow, it falls away under you and you fly
   * (a kicker's lip). Per-step snapping to the snow alone only ever lets go at cliffs.
   */
  liftLook: 0.06,
  liftGap: 0.15,
  /**
   * Going over a sharp convex edge (a halfpipe's coping) the look-ahead can miss it: up a
   * near-vertical wall the snow rises almost as fast as you do. Riding a wall steeper than
   * `peelFrom` (rad), if the snow you step onto turns away from your path faster than
   * `peelSpeed` (m/s along its normal), you fly. (Only on steep walls: on bumpy ordinary
   * slopes it would bounce you off every crease.)
   */
  peelSpeed: 1.5,
  peelFrom: (45 * Math.PI) / 180,
  /**
   * Leaving a wall steeper than this (rad) you go straight up: the vert at the top of a
   * halfpipe turns you vertical, which a height field can't quite reach. Your motion out
   * over the deck is dropped, and you drift `vertDrift` m/s back in, so you come down on
   * the transition just inside the coping.
   */
  vertAngle: (70 * Math.PI) / 180,
  vertDrift: 0.35,
  /** ... if you were on such a wall this recently (s). */
  vertMemory: 0.15,
  maxStep: 1 / 120,
  /** Sliding a rail: friction (μ), and the pull onto its centreline (1/s², damping 1/s). */
  railFriction: 0.008,
  railCentre: 60,
  railDamping: 12,
};

export interface SkiTerrain {
  height(x: number, z: number): number;
  /**
   * Upward unit surface normal at (x, z). Optional: by default it's sampled from `height`
   * NORMAL_STEP apart, too coarse for a kicker's few-metre transition.
   */
  normal?(x: number, z: number, out: Vector3): Vector3;
  /** Whether the snow at (x, z) is a groomed piste. Treated as groomed if omitted. */
  groomed?(x: number, z: number): boolean;
  /** The rail underfoot at (x, z), if any (`RailContact` in parks/park-shapes). */
  rail?(x: number, z: number): RailUnderfoot | null;
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
  /** Sliding on a rail this step. */
  rail?: boolean;
  /**
   * Pitch of the skis above the horizontal (rad, > 0 = tips up). On the snow it follows
   * the slope; in the air leaning rotates it. Unwrapped, so it counts whole flips.
   */
  pitch?: number;
  /** Rate the pitch is changing in the air (rad/s, > 0 = rotating backwards). */
  pitchRate?: number;
  /** Pitch at takeoff: (pitch - takeoffPitch) / 2π is how far you've flipped. */
  takeoffPitch?: number;
  /** Seconds left of a crash (sliding to a stop, then standing up); 0 or unset = skiing. */
  crash?: number;
  /** How the touchdown went, on the stepSki call you land in; null otherwise. */
  landing?: Landing | null;
  /**
   * The last near-vertical wall ridden (`SKI.vertAngle`): its normal, and how long ago
   * (s). Kept briefly: right at the coping the normal is already turning to the deck.
   */
  wall?: { normal: Vector3; age: number };
}

export interface Landing {
  /** Whole rotations completed: > 0 backflips, < 0 front flips. */
  flips: number;
  /** Skis' pitch relative to the slope at touchdown (rad, > 0 = tips high). */
  error: number;
  outcome: 'clean' | 'sketchy' | 'crash';
}

/** A rail underfoot (`RailContact` in parks/park-shapes). */
export interface RailUnderfoot {
  /** Horizontal direction along it (world x, z; unit). */
  dirX: number;
  dirZ: number;
  /** Offset across it (m), + to the left of `dir`. */
  offset: number;
  /** Rise per horizontal metre along `dir`. */
  grade: number;
}

export interface SkiIntent {
  tuck: boolean;
  push: boolean;
  /** Double-poling (too fast to skate). */
  pole?: boolean;
  brake: boolean;
  jump: boolean;
  /** The jump is a snowboard ollie (popped off the tail): more pop, and the nose lifts. */
  ollie?: boolean;
  /** Fore/aft lean, -1 (back, ]) to 1 (forward, [). In the air it flips you. */
  lean?: number;
}

const NORMAL_STEP = 2;
const n = new Vector3();
const gravityAlong = new Vector3();
const skis = new Vector3();
const dir = new Vector3();
const target = new Vector3();
const slopeDir = new Vector3();
const deck = new Vector3();
const steepDir = new Vector3();
/** Wall steepness (normal's y) over which ski direction blends to straight-down projection. */
const STEEP_FROM = Math.cos((40 * Math.PI) / 180);
const STEEP_TO = Math.cos((55 * Math.PI) / 180);
const coping = new Vector3();
/** How far over the edge the deck is sampled when leaving a wall (m). */
const VERT_PROBE = 0.5;

/** Upward unit surface normal at (x, z), in world axes. */
export function surfaceNormal(t: SkiTerrain, x: number, z: number, out: Vector3): Vector3 {
  if (t.normal) return t.normal(x, z, out);
  const h = NORMAL_STEP;
  return out
    .set(t.height(x - h, z) - t.height(x + h, z), 2 * h, t.height(x, z - h) - t.height(x, z + h))
    .normalize();
}

/** Pitch of skis pointing along `yaw` on the surface with normal `normal` (rad, > 0 = uphill). */
export function slopePitch(yaw: number, normal: Vector3): number {
  return Math.asin(Math.max(-1, Math.min(1, skiDirection(yaw, normal, slopeDir).y)));
}

/**
 * Unit vector the skis point along, lying in the surface with normal `normal`. On ordinary
 * slopes that's the yaw projected along the normal. On steep walls (from `STEEP_FROM`, all
 * the way by `STEEP_TO`) it's projected straight down instead, so the skis point where the
 * yaw does seen from above: projecting along a near-vertical wall's normal would swing any
 * diagonal line up a halfpipe wall to run along it.
 */
export function skiDirection(yaw: number, normal: Vector3, out: Vector3): Vector3 {
  const x = -Math.sin(yaw);
  const z = -Math.cos(yaw);
  const across = x * normal.x + z * normal.z;
  out.set(x, 0, z).addScaledVector(normal, -across).normalize();
  const w = 1 - Math.min(1, Math.max(0, (normal.y - STEEP_TO) / (STEEP_FROM - STEEP_TO)));
  if (w > 0) {
    const down = steepDir.set(x, -across / Math.max(normal.y, 0.02), z).normalize();
    out.lerp(down, w).normalize();
  }
  return out;
}

/** Whether W double-poles rather than skates, given whether it was poling last step. */
export function doublePoling(flatSpeed: number, poling: boolean): boolean {
  return flatSpeed >= (poling ? SKI.poleMinSpeed : SKI.skateMaxSpeed);
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
  state.landing = null;
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
    state.rail = false;
    rotate(state, intent.lean ?? 0, h, terrain);
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
      land(state);
    }
    return;
  }

  surfaceNormal(terrain, p.x, p.z, n);
  const rail = state.crash ? null : (terrain.rail?.(p.x, p.z) ?? null);
  state.rail = rail !== null;
  if (rail) {
    slideRail(state, rail, intent, h, terrain, ski);
    return;
  }
  if (state.crash) {
    // Tumbling: slide to a stop whatever the slope, swinging round to face downhill.
    v.multiplyScalar(Math.exp(-SKI.crashDrag * h));
    gravityAlong.set(0, -SKI.gravity, 0).addScaledVector(n, SKI.gravity * n.y);
    if (gravityAlong.x * gravityAlong.x + gravityAlong.z * gravityAlong.z > 0.01) {
      const downhill = Math.atan2(-gravityAlong.x, -gravityAlong.z);
      state.yaw += wrapAngle(downhill - state.yaw) * (1 - Math.exp(-SKI.crashTurn * h));
    }
    p.addScaledVector(v, h);
    p.y = terrain.height(p.x, p.z);
    surfaceNormal(terrain, p.x, p.z, n);
    v.addScaledVector(n, -v.dot(n));
    state.pitch = slopePitch(state.yaw, n);
    state.crash = Math.max(0, state.crash - h);
    return;
  }
  state.pitch = slopePitch(state.yaw, n);
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
    // Leaning forward pressures the shovels so turns bite sooner; sitting back floats the
    // tips up in powder (less to plough through) but steers a little less.
    const lean = Math.max(-1, Math.min(1, intent.lean ?? 0));
    const carve =
      ski.carveRate *
      (groomed ? bite : ski.powderGrip) *
      bend *
      washout *
      (1 + SKI.leanCarve * lean);
    dir.lerp(target, 1 - Math.exp(-carve * grip * h)).normalize();

    const float = 1 - SKI.leanFloat * Math.max(0, -lean);
    const friction = groomed ? ski.snowFriction : ski.powderFriction * float;
    const drag =
      (intent.tuck ? SKI.dragTuck : SKI.dragUpright) + (groomed ? 0 : ski.powderDrag * float);
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
    v.addScaledVector(n, intent.ollie ? SKI.jumpSpeed * SKI.ollieBoost : SKI.jumpSpeed);
    takeOff(state);
    // An ollie pops off the tail: the nose rises as you leave, then the spotting brings the
    // board back to the slope for the landing (same as letting a flip settle).
    if (intent.ollie) state.pitchRate = SKI.olliePop;
    p.addScaledVector(v, h);
    return;
  }

  // Clear of the snow halfway there too: still on a curving run-in, the ramp is above
  // the path just ahead even though the snow past the lip is below it.
  const clears = (t: number) =>
    p.y + v.y * t - 0.5 * SKI.gravity * t * t >
    terrain.height(p.x + v.x * t, p.z + v.z * t) + SKI.liftGap;
  const lip = clears(SKI.liftLook) && clears(SKI.liftLook / 2);
  const onWall = n.y < Math.cos(SKI.peelFrom);
  if (n.y < Math.cos(SKI.vertAngle)) {
    if (state.wall) state.wall.normal.copy(n);
    else state.wall = { normal: n.clone(), age: 0 };
    state.wall.age = 0;
  } else if (state.wall) {
    state.wall.age += h;
  }
  p.addScaledVector(v, h);
  const ground = terrain.height(p.x, p.z);
  if (lip || p.y > ground + SKI.airThreshold) {
    leave(state, terrain); // the slope fell away faster than we did
    return;
  }
  p.y = ground;
  surfaceNormal(terrain, p.x, p.z, n);
  if (onWall && v.dot(n) > SKI.peelSpeed) {
    leave(state, terrain); // over an edge: the snow turned away under us
    return;
  }
  v.addScaledVector(n, -v.dot(n)); // stay in the new surface plane
}

/** Take off from the snow; just off a near-vertical wall, straight up (`SKI.vertAngle`). */
function leave(state: SkiState, terrain: SkiTerrain): void {
  const w = state.wall;
  if (w && w.age < SKI.vertMemory) {
    // Straight up means no motion across the coping. The wall's normal alone leans down
    // the pipe's grade, so take the coping's line from it and the deck just beyond.
    const p = state.position;
    const out = Math.sqrt(w.normal.x * w.normal.x + w.normal.z * w.normal.z);
    const ox = w.normal.x / out;
    const oz = w.normal.z / out;
    surfaceNormal(terrain, p.x - ox * VERT_PROBE, p.z - oz * VERT_PROBE, deck);
    coping.crossVectors(w.normal, deck);
    let ax = -coping.z;
    let az = coping.x;
    const len = Math.sqrt(ax * ax + az * az);
    if (len > 0.1 * coping.length()) {
      const sign = ax * ox + az * oz < 0 ? -1 : 1;
      ax *= sign / len;
      az *= sign / len;
    } else {
      [ax, az] = [ox, oz]; // no deck: just leave the wall's face
    }
    const v = state.velocity;
    const into = v.x * ax + v.z * az;
    v.x += ax * (SKI.vertDrift - into);
    v.z += az * (SKI.vertDrift - into);
  }
  state.wall = undefined;
  takeOff(state);
}

/**
 * On a rail: the path follows the rail, not the skis, so the skis can point any way
 * (sideways is a boardslide) and it barely slows you. A damped spring pulls you onto the
 * centreline; slide off its end (or its side, if you land far off) and you fly.
 */
function slideRail(
  state: SkiState,
  rail: RailUnderfoot,
  intent: SkiIntent,
  h: number,
  terrain: SkiTerrain,
  ski: SkiHandling,
): void {
  const p = state.position;
  const v = state.velocity;
  // The rail's own surface, not a sampled one: samples near its end or edge straddle the
  // drop to the snow and read as a wall, which stopped you dead at the end and threw
  // you sideways off a corner.
  railNormal(rail, n);
  state.pitch = slopePitch(state.yaw, n);
  state.climbing = false;
  gravityAlong.set(0, -SKI.gravity, 0).addScaledVector(n, SKI.gravity * n.y);
  v.addScaledVector(gravityAlong, h);
  // Along the rail (in its surface plane) and across it, to the left.
  dir.set(rail.dirX, 0, rail.dirZ);
  dir.addScaledVector(n, -dir.dot(n)).normalize();
  target.set(rail.dirZ, 0, -rail.dirX);
  let along = v.dot(dir);
  let across = v.dot(target);
  across += (-SKI.railCentre * rail.offset - SKI.railDamping * across) * h;
  const drag = intent.tuck ? SKI.dragTuck : SKI.dragUpright;
  const decel = SKI.railFriction * SKI.gravity * n.y + drag * along * along;
  along = Math.sign(along) * Math.max(0, Math.abs(along) - decel * h);
  v.copy(dir).multiplyScalar(along).addScaledVector(target, across);
  if (v.length() > ski.maxSpeed) v.setLength(ski.maxSpeed);

  if (intent.jump) {
    v.addScaledVector(n, SKI.jumpSpeed);
    takeOff(state);
    p.addScaledVector(v, h);
    return;
  }
  p.addScaledVector(v, h);
  const ground = terrain.height(p.x, p.z);
  if (p.y > ground + SKI.airThreshold) {
    takeOff(state); // off the end or the side
  } else {
    p.y = ground;
    const next = terrain.rail?.(p.x, p.z);
    if (next) railNormal(next, n);
    else surfaceNormal(terrain, p.x, p.z, n);
    v.addScaledVector(n, -v.dot(n));
  }
}

/** Upward unit normal of a rail's top: tilted along it by its grade, level across. */
function railNormal(rail: RailUnderfoot, out: Vector3): Vector3 {
  return out.set(-rail.grade * rail.dirX, 1, -rail.grade * rail.dirZ).normalize();
}

/** Leave the snow with the skis at the slope's pitch (already in `state.pitch`). */
function takeOff(state: SkiState): void {
  state.airborne = true;
  state.pitch ??= 0;
  state.takeoffPitch = state.pitch;
  state.pitchRate = 0;
}

/** In the air: leaning builds rotation; letting go eases it off while you spot the landing. */
function rotate(state: SkiState, lean: number, h: number, terrain: SkiTerrain): void {
  const pitch = state.pitch ?? 0;
  let rate = state.pitchRate ?? 0;
  if (lean !== 0) {
    // Forward lean dips the tips (front flip); leaning back lifts them (backflip).
    const step = SKI.flipAccel * h;
    rate += Math.max(-step, Math.min(step, -lean * SKI.flipRate - rate));
  } else {
    const p = state.position;
    surfaceNormal(terrain, p.x, p.z, n);
    const off = wrapAngle(slopePitch(state.yaw, n) - pitch);
    const want = Math.max(-SKI.spotRate, Math.min(SKI.spotRate, SKI.spotGain * off));
    rate += (want - rate) * (1 - Math.exp(-SKI.flipDamping * h));
  }
  state.pitchRate = rate;
  state.pitch = pitch + rate * h;
}

/** Touchdown (normal `n` already set): ski on, lose some speed, or crash. */
function land(state: SkiState): void {
  const pitch = state.pitch ?? 0;
  const slope = slopePitch(state.yaw, n);
  const error = wrapAngle(pitch - slope);
  const flips = Math.round((pitch - error - (state.takeoffPitch ?? pitch)) / (2 * Math.PI));
  const off = Math.abs(error);
  let outcome: Landing['outcome'] = 'clean';
  if (off > SKI.landTolerance) {
    outcome = 'crash';
    state.crash = SKI.crashTime;
    state.velocity.multiplyScalar(0.6);
  } else if (off > SKI.landClean) {
    outcome = 'sketchy';
    const t = (off - SKI.landClean) / (SKI.landTolerance - SKI.landClean);
    state.velocity.multiplyScalar(1 - SKI.sketchyLoss * t);
  }
  state.landing = { flips, error, outcome };
  state.pitch = slope;
  state.pitchRate = 0;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
