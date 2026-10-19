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
  /** Fore/aft lean: 1 = pressing the shins forward, -1 = sitting back. */
  foreAft: number;
  /** Upper body rotation relative to the skis (rad, > 0 = facing left of the skis). */
  twist: number;
  /** Skating stride phase (rad), advancing while skating. */
  skatePhase: number;
  /** Pole angle back from vertical (rad); tucked poles lie almost flat. */
  poleSweep: number;
  /** Double-poling cycle phase (rad), advancing while poling. */
  polePhase: number;
  /** Hands forward (+1, reaching to plant) to back (-0.3, end of the push). */
  armReach: number;
  /**
   * Sitting on a bench (riding a gondola): `amount` blends from standing (0) to seated (1),
   * with the hips `height` above the feet and `back` behind them. Boots rest on the floor.
   */
  sit?: { amount: number; height: number; back: number };
}

/** Moments in the animation that make a sound. */
export interface StanceEvents {
  /** A foot steps or pushes off (walking, climbing, slow skating). */
  step: boolean;
  /** Both poles plant in the snow (double-poling). */
  plant: boolean;
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
  /**
   * Edge angle from the body's balance (rad, > 0 = on the left edges): the angle, about
   * the skis, between the slope normal and the direction the skier balances along.
   * When given, it replaces the estimate from turn rate and sideslip.
   */
  balanceEdge?: number;
  plough: boolean;
  skate: boolean;
  /** Stepping uphill: a slower, wider herringbone instead of skating strides. */
  climb?: boolean;
  /** Double-poling: too fast to skate, so push along with both poles. */
  pole?: boolean;
  tuck: boolean;
  airborne: boolean;
  /** Fore/aft lean intent, -1 (back) to 1 (forward); in the air it tucks you into a flip. */
  foreAft?: number;
  /** Crashed: sprawled in the snow. */
  crashed?: boolean;
  /** How quickly the skis roll edge to edge, 1 = reference (narrow skis are quicker). */
  edgeRate?: number;
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
const CLIMB_HZ = 0.9;
const POLE_HZ = 0.8;
/** Share of the poling cycle spent pushing; the rest is the recovery swing. */
const PUSH_SHARE = 0.4;
const RESPONSE = 9; // 1/s, how quickly the pose follows the target

export function initialStance(): Stance {
  const flat = (x: number): SkiPose => ({ x, lift: 0, z: 0, yaw: 0, roll: 0 });
  return {
    left: flat(-STANCE_WIDTH),
    right: flat(STANCE_WIDTH),
    crouch: 0,
    lean: 0,
    foreAft: 0,
    twist: 0,
    skatePhase: 0,
    poleSweep: 0.35,
    polePhase: 0,
    armReach: 0,
  };
}

/** Edge angle for a carved turn: the skier leans so gravity balances the turn's pull. */
export function carveEdgeAngle(speed: number, turnRate: number): number {
  const lateral = speed * turnRate; // centripetal acceleration (m/s²)
  const angle = Math.atan2(Math.abs(lateral), G);
  return Math.sign(lateral) * Math.min(angle, MAX_EDGE);
}

/** The pose to aim for this instant. */
export function targetStance(
  input: StanceInput,
  skatePhase: number,
  polePhase = 0,
): Omit<Stance, 'skatePhase' | 'polePhase'> {
  // Skidding sideways, the skis bite on the edge facing the slide (a hockey stop).
  const skid = Math.max(-0.75, Math.min(0.75, -(input.sideslip ?? 0) * 0.12));
  const raw = input.balanceEdge ?? carveEdgeAngle(input.speed, input.turnRate) + skid;
  const edge = input.airborne ? 0 : Math.max(-MAX_EDGE, Math.min(MAX_EDGE, raw));
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

  let armReach = 0;
  if (input.pole && !input.airborne && !input.plough && !input.tuck) {
    // Double-pole: reach forward and plant, then crunch down pushing the hands past
    // the hips, then swing back up to reach again.
    const t = polePhase / (2 * Math.PI);
    if (t < PUSH_SHARE) {
      const u = t / PUSH_SHARE;
      armReach = 1 - 1.3 * u;
      poleSweep = -0.15 + 1.25 * u;
      crouch = Math.max(crouch, 0.15 + 0.4 * Math.sin(Math.PI * u));
    } else {
      const u = (t - PUSH_SHARE) / (1 - PUSH_SHARE);
      armReach = -0.3 + 1.3 * u;
      poleSweep = 1.1 - 1.25 * u;
      crouch = Math.max(crouch, 0.15 * (1 - u));
    }
  }
  const foreAft = Math.max(-1, Math.min(1, input.foreAft ?? 0));
  // Flipping, you pull your knees up into a tuck.
  if (input.airborne) crouch = Math.max(crouch, 0.4 + 0.45 * Math.abs(foreAft));
  if (input.crashed) {
    crouch = 0.7;
    armReach = 1;
    poleSweep = 1.2;
  }
  return {
    left,
    right,
    crouch,
    lean: edge * 0.85,
    foreAft,
    twist: input.twist ?? 0,
    poleSweep,
    armReach,
  };
}

/** Move `stance` toward the target for this input over `dt` seconds. */
export function updateStance(stance: Stance, input: StanceInput, dt: number): StanceEvents {
  const events: StanceEvents = { step: false, plant: false };
  if (input.skate && !input.airborne) {
    const hz = input.climb ? CLIMB_HZ : STRIDE_HZ;
    const before = stance.skatePhase;
    stance.skatePhase = (stance.skatePhase + dt * hz * 2 * Math.PI) % (2 * Math.PI);
    // One step per half cycle (left foot, then right).
    events.step = Math.floor(stance.skatePhase / Math.PI) !== Math.floor(before / Math.PI);
  }
  if (input.pole && !input.airborne && !input.plough && !input.tuck) {
    const before = stance.polePhase;
    stance.polePhase = (stance.polePhase + dt * POLE_HZ * 2 * Math.PI) % (2 * Math.PI);
    events.plant = stance.polePhase < before; // wrapped: start of a new push
  } else {
    stance.polePhase = 0;
  }
  const target = targetStance(input, stance.skatePhase, stance.polePhase);
  const k = 1 - Math.exp(-RESPONSE * dt);
  const kRoll = 1 - Math.exp(-RESPONSE * (input.edgeRate ?? 1) * dt);
  const ease = (a: SkiPose, b: SkiPose) => {
    a.x += (b.x - a.x) * k;
    a.lift += (b.lift - a.lift) * k;
    a.z += (b.z - a.z) * k;
    a.yaw += (b.yaw - a.yaw) * k;
    a.roll += (b.roll - a.roll) * kRoll;
  };
  ease(stance.left, target.left);
  ease(stance.right, target.right);
  stance.crouch += (target.crouch - stance.crouch) * k;
  stance.lean += (target.lean - stance.lean) * k;
  stance.foreAft += (target.foreAft - stance.foreAft) * k;
  stance.twist = target.twist; // already smooth: follows the controls directly
  stance.poleSweep += (target.poleSweep - stance.poleSweep) * k;
  stance.armReach += (target.armReach - stance.armReach) * k;
  return events;
}
