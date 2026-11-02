/**
 * Where a snowboarder's feet go, in the board's frame (x = right, y = up, z = back, nose at
 * −z). Pure and unit-tested; `ski-stance` uses it for the board's target pose, so the feet
 * travel in the same `Stance.left` / `Stance.right` slots as skis do (and so over the network
 * with no format of their own), and `SkierModel.applyBoard` builds the body on them.
 *
 * Both stances ride nose first: a regular rider leads with the left foot and faces the +x
 * (toe) edge, a goofy rider leads with the right foot and faces −x. On a board a `SkiPose`
 * means: `x`, `z` the boot's place on the deck (or on the snow beside it, pushing), `lift` its
 * height off the snow when it's out of the binding, `yaw` the boot's heading about the board's
 * up (the rig's −z is the toe), `roll` the deck's edge angle (> 0 lifts the +x edge).
 */

import { BOARD_PUSH, type BoardSetup } from './discipline';
import type { SkiPose } from './ski-stance';

export interface BoardGeometry {
  regular: boolean;
  /** Binding angles (deg): + turns the toes toward the nose. */
  angleFront: number;
  angleBack: number;
  /** Half the stance width: binding centre to board centre (m). */
  half: number;
  /** Half the board's waist (m). */
  halfWidth: number;
}

export function boardGeometry(s: BoardSetup): BoardGeometry {
  return {
    regular: s.stance === 'regular',
    angleFront: s.angleFront,
    angleBack: s.angleBack,
    // ~55 cm between the bindings on a 156, a little wider on a longer board.
    half: Math.min(0.29, (s.length / 100) * 0.176),
    halfWidth: s.waist / 2000,
  };
}

/** x-sign of the toe edge. */
export const toeSign = (regular: boolean): 1 | -1 => (regular ? 1 : -1);

/**
 * The yaw that turns a boot (toe along its −z) to point across the board at the toe edge,
 * turned `angle` degrees toward the nose (negative: toward the tail, a duck back foot).
 */
export function footYaw(angleDeg: number, regular: boolean): number {
  const a = (angleDeg * Math.PI) / 180;
  return Math.atan2(-toeSign(regular) * Math.cos(a), Math.sin(a));
}

/** Pushing, the free foot's toes point down the board, turned out toward the toe edge. */
const PUSH_TOE_OUT = 0.25;
/** How far outside the toe edge the pushing boot's centre is (m). */
const PUSH_OUT = 0.13;
/** Share of the push cycle with the foot on the snow; the rest swings it forward again. */
const PUSH_STROKE = 0.62;
const PUSH_LIFT = 0.08;

/** Which rig (left / right foot) leads (goes at the nose). */
export const leadSide = (regular: boolean): 'left' | 'right' => (regular ? 'left' : 'right');

/**
 * The feet for this instant. `edge` rolls the deck (both bound feet with it); `push` takes
 * the back foot out of its binding through a push stride at `phase` (rad, 0 = foot planted
 * beside the front binding, pushing back until PUSH_STROKE of the cycle, then swinging
 * forward clear of the snow).
 */
export function boardFeet(
  geo: BoardGeometry,
  edge: number,
  push: boolean,
  phase: number,
): { left: SkiPose; right: SkiPose } {
  const toe = toeSign(geo.regular);
  const roll = push ? 0 : edge;
  const lead: SkiPose = {
    x: 0,
    lift: 0,
    z: -geo.half,
    yaw: footYaw(geo.angleFront, geo.regular),
    roll,
  };
  let back: SkiPose = {
    x: 0,
    lift: 0,
    z: geo.half,
    yaw: footYaw(geo.angleBack, geo.regular),
    roll,
  };
  if (push) {
    const u = (((phase / (2 * Math.PI)) % 1) + 1) % 1;
    const zFront = -geo.half + 0.12;
    const zBack = geo.half + 0.02;
    let z: number;
    let lift = 0;
    if (u < PUSH_STROKE) {
      const s = u / PUSH_STROKE;
      z = zFront + (zBack - zFront) * (s * s * (3 - 2 * s));
    } else {
      const s = (u - PUSH_STROKE) / (1 - PUSH_STROKE);
      z = zBack + (zFront - zBack) * (s * s * (3 - 2 * s));
      lift = PUSH_LIFT * Math.sin(Math.PI * s);
    }
    back = {
      x: toe * (geo.halfWidth + PUSH_OUT),
      lift,
      z,
      yaw: Math.atan2(-toe * Math.sin(PUSH_TOE_OUT), Math.cos(PUSH_TOE_OUT)),
      roll: 0,
    };
  }
  return geo.regular ? { left: lead, right: back } : { left: back, right: lead };
}

/** Whether a pushing stride just planted the foot (crossed into a new cycle). */
export function pushStep(before: number, after: number): boolean {
  return after < before;
}

export const PUSH_HZ = BOARD_PUSH.hz;

/**
 * A board stance read back from its feet (a remote rider sends only the stance): the lead
 * foot is the one nearer the nose. Falls back to `fallback` while the feet are still easing
 * in from a ski pose (side by side).
 */
export function stanceIsRegular(left: SkiPose, right: SkiPose, fallback: boolean): boolean {
  if (Math.abs(left.z - right.z) < 0.15) return fallback;
  return left.z < right.z;
}

/**
 * How far the back foot is out of its binding (0 strapped in, 1 on the snow beside the
 * board), from its place across the deck.
 */
export function pushAmount(back: SkiPose, halfWidth: number): number {
  const t = (Math.abs(back.x) - 0.3 * halfWidth) / (halfWidth + PUSH_OUT - 0.3 * halfWidth);
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export { PUSH_OUT };
