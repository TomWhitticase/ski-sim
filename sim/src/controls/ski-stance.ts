/**
 * How the skier's skis and body are posed, derived from what they're doing. Pure and
 * frame-rate independent so it can be unit-tested; the model just applies the result.
 *
 * Ski-local axes match the skier group: x = right, y = up (slope normal), z = back.
 * For each ski: `yaw` > 0 swings the tip to the left; `roll` > 0 lifts the ski's right
 * edge (so it rides on its left edge).
 */

export interface SkiPose {
  /** Lateral position of the boot centre (m); left ski negative. */
  x: number;
  /** Height of the ski off the snow (m), for a lifted skating ski. */
  lift: number;
  /** Fore/aft offset (m), forward negative. */
  z: number;
  yaw: number;
  roll: number;
}

export interface Stance {
  left: SkiPose;
  right: SkiPose;
  /** 0 = standing tall, 1 = full tuck. */
  crouch: number;
  /** Body lean into the turn (rad, > 0 leans left). */
  lean: number;
  /** Upper body rotation relative to the skis (rad, > 0 = facing left of the skis). */
  twist: number;
  /** Skating stride phase (rad), advancing while skating. */
  skatePhase: number;
  /** Pole angle back from vertical (rad); tucked poles lie almost flat. */
  poleSweep: number;
}

export interface StanceInput {
  /** Speed over the snow (m/s). */
  speed: number;
  /** Rate the skier is turning (rad/s, > 0 = turning left). */
  turnRate: number;
  /** Speed sliding sideways relative to the skis (m/s, > 0 = toward the skis' right). */
  sideslip?: number;
  /** Where the upper body faces relative to the skis (rad). */
  twist?: number;
  plough: boolean;
  skate: boolean;
  tuck: boolean;
  airborne: boolean;
}

const G = 9.81;
const STANCE_WIDTH = 0.11; // half the distance between boots, parallel
const MAX_EDGE = (60 * Math.PI) / 180;
const PLOUGH_YAW = 0.28; // ~16° each ski, tips together
const PLOUGH_ROLL = 0.22; // on the inside edges
const PLOUGH_WIDTH = 0.3;
const SKATE_YAW = 0.35; // tips out
const SKATE_ROLL = 0.25; // pushing ski on its inside edge
const SKATE_WIDTH = 0.22;
const SKATE_LIFT = 0.12;
const STRIDE_HZ = 1.3;
const RESPONSE = 9; // 1/s, how quickly the pose follows the target

export function initialStance(): Stance {
  const flat = (x: number): SkiPose => ({ x, lift: 0, z: 0, yaw: 0, roll: 0 });
  return {
    left: flat(-STANCE_WIDTH),
    right: flat(STANCE_WIDTH),
    crouch: 0,
    lean: 0,
    twist: 0,
    skatePhase: 0,
    poleSweep: 0.35,
  };
}

/** Edge angle for a carved turn: the skier leans so gravity balances the turn's pull. */
export function carveEdgeAngle(speed: number, turnRate: number): number {
  const lateral = speed * turnRate; // centripetal acceleration (m/s²)
  const angle = Math.atan2(Math.abs(lateral), G);
  return Math.sign(lateral) * Math.min(angle, MAX_EDGE);
}

/** The pose to aim for this instant. */
export function targetStance(input: StanceInput, skatePhase: number): Omit<Stance, 'skatePhase'> {
  // Skidding sideways, the skis bite on the edge facing the slide (a hockey stop).
  const skid = Math.max(-0.75, Math.min(0.75, -(input.sideslip ?? 0) * 0.12));
  const edge = input.airborne
    ? 0
    : Math.max(-MAX_EDGE, Math.min(MAX_EDGE, carveEdgeAngle(input.speed, input.turnRate) + skid));
  // Inside ski leads a little in a carve and the stance widens with edge angle.
  const lead = Math.abs(edge) * 0.12 * Math.sign(edge);
  const width = STANCE_WIDTH + Math.abs(edge) * 0.08;
  const carve = (side: -1 | 1): SkiPose => ({
    x: side * width,
    lift: 0,
    // Turning left (edge > 0): the left ski (inside) is forward.
    z: side === -1 ? -lead : lead,
    yaw: 0,
    roll: edge,
  });

  let left = carve(-1);
  let right = carve(1);
  let crouch = input.tuck ? 1 : Math.min(Math.abs(edge) / MAX_EDGE, 1) * 0.45;
  let poleSweep = input.tuck ? 1.35 : 0.35;

  if (input.plough && !input.airborne) {
    // Wedge: tips together, tails apart, both on their inside edges.
    left = { x: -PLOUGH_WIDTH, lift: 0, z: 0, yaw: -PLOUGH_YAW, roll: -PLOUGH_ROLL };
    right = { x: PLOUGH_WIDTH, lift: 0, z: 0, yaw: PLOUGH_YAW, roll: PLOUGH_ROLL };
    crouch = 0.25;
    poleSweep = 0.5;
  } else if (input.skate && !input.airborne) {
    // V-skate: tips out, alternately pushing off one inside edge while gliding on the
    // other; the ski that just pushed comes up off the snow to recover.
    const s = Math.sin(skatePhase);
    const push = (side: -1 | 1) => Math.max(0, side === -1 ? s : -s);
    const ski = (side: -1 | 1): SkiPose => {
      const p = push(side);
      return {
        x: side * (SKATE_WIDTH + p * 0.12),
        lift: Math.max(0, side === -1 ? -s : s) * SKATE_LIFT,
        z: -0.1 + p * 0.25,
        yaw: side * -SKATE_YAW, // left ski tip left (+yaw), right ski tip right
        roll: side * SKATE_ROLL * p, // pushing ski rides its inside edge
      };
    };
    left = ski(-1);
    right = ski(1);
    crouch = 0.3 + 0.15 * Math.abs(s);
    poleSweep = 0.45 + 0.35 * Math.abs(s);
  }

  if (input.airborne) crouch = Math.max(crouch, 0.4);
  return { left, right, crouch, lean: edge * 0.85, twist: input.twist ?? 0, poleSweep };
}

/** Move `stance` toward the target for this input over `dt` seconds. */
export function updateStance(stance: Stance, input: StanceInput, dt: number): void {
  if (input.skate && !input.airborne) {
    stance.skatePhase = (stance.skatePhase + dt * STRIDE_HZ * 2 * Math.PI) % (2 * Math.PI);
  }
  const target = targetStance(input, stance.skatePhase);
  const k = 1 - Math.exp(-RESPONSE * dt);
  const ease = (a: SkiPose, b: SkiPose) => {
    a.x += (b.x - a.x) * k;
    a.lift += (b.lift - a.lift) * k;
    a.z += (b.z - a.z) * k;
    a.yaw += (b.yaw - a.yaw) * k;
    a.roll += (b.roll - a.roll) * k;
  };
  ease(stance.left, target.left);
  ease(stance.right, target.right);
  stance.crouch += (target.crouch - stance.crouch) * k;
  stance.lean += (target.lean - stance.lean) * k;
  stance.twist = target.twist; // already smooth: follows the controls directly
  stance.poleSweep += (target.poleSweep - stance.poleSweep) * k;
}
