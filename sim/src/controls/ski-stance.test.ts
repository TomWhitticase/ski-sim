import { describe, expect, it } from 'vitest';

import {
  carveEdgeAngle,
  initialStance,
  type StanceInput,
  targetStance,
  updateStance,
} from './ski-stance';

const DEG = Math.PI / 180;
const cruising: StanceInput = {
  speed: 12,
  turnRate: 0,
  plough: false,
  skate: false,
  tuck: false,
  airborne: false,
};

describe('carveEdgeAngle', () => {
  it('is flat going straight and grows with speed and turn rate', () => {
    expect(carveEdgeAngle(15, 0)).toBe(0);
    // 15 m/s turning at 0.65 rad/s: ~9.8 m/s² sideways, so a ~45° edge.
    expect(carveEdgeAngle(15, 0.654)).toBeCloseTo(45 * DEG, 1);
    expect(carveEdgeAngle(5, 0.654)).toBeLessThan(carveEdgeAngle(15, 0.654));
  });

  it('edges left in a left turn and right in a right turn, capped at 60°', () => {
    expect(carveEdgeAngle(10, 0.5)).toBeGreaterThan(0);
    expect(carveEdgeAngle(10, -0.5)).toBeLessThan(0);
    expect(carveEdgeAngle(40, 3)).toBeCloseTo(60 * DEG);
  });
});

describe('targetStance', () => {
  it('carves with both skis on the same edges, leaning into the turn', () => {
    const t = targetStance({ ...cruising, turnRate: 0.5 }, 0);
    expect(t.left.roll).toBeGreaterThan(20 * DEG);
    expect(t.right.roll).toBeCloseTo(t.left.roll);
    expect(t.lean).toBeGreaterThan(0);
    expect(t.left.z).toBeLessThan(t.right.z); // inside (left) ski leads
  });

  it('snowploughs into a wedge: tips in, tails apart, inside edges', () => {
    const t = targetStance({ ...cruising, plough: true }, 0);
    expect(t.left.yaw).toBeLessThan(0); // left tip swings right, toward the middle
    expect(t.right.yaw).toBeGreaterThan(0);
    expect(t.left.roll).toBeLessThan(0); // left ski on its right (inside) edge
    expect(t.right.roll).toBeGreaterThan(0);
    expect(t.right.x - t.left.x).toBeGreaterThan(0.5);
  });

  it('skates in a V, alternating which ski pushes and which lifts', () => {
    const a = targetStance({ ...cruising, speed: 2, skate: true }, Math.PI / 2);
    const b = targetStance({ ...cruising, speed: 2, skate: true }, (3 * Math.PI) / 2);
    expect(a.left.yaw).toBeGreaterThan(0); // tips out
    expect(a.right.yaw).toBeLessThan(0);
    expect(a.right.lift).toBeGreaterThan(0.05);
    expect(a.left.lift).toBe(0);
    expect(b.left.lift).toBeGreaterThan(0.05);
    expect(b.right.lift).toBe(0);
  });

  it('crouches into a tuck with the poles tucked back', () => {
    const t = targetStance({ ...cruising, tuck: true }, 0);
    expect(t.crouch).toBe(1);
    expect(t.poleSweep).toBeGreaterThan(1);
  });
});

describe('updateStance', () => {
  it('eases toward the target and advances the stride while skating', () => {
    const stance = initialStance();
    for (let i = 0; i < 60; i++) updateStance(stance, { ...cruising, tuck: true }, 1 / 60);
    expect(stance.crouch).toBeGreaterThan(0.95);
    expect(stance.skatePhase).toBe(0);
    updateStance(stance, { ...cruising, speed: 2, skate: true }, 0.1);
    expect(stance.skatePhase).toBeGreaterThan(0);
  });
});

describe('skating edges', () => {
  it('pushes off the inside edge of each ski', () => {
    const leftPush = targetStance({ ...cruising, speed: 2, skate: true }, Math.PI / 2);
    expect(leftPush.left.roll).toBeLessThan(0); // left ski on its right (inside) edge
    const rightPush = targetStance({ ...cruising, speed: 2, skate: true }, (3 * Math.PI) / 2);
    expect(rightPush.right.roll).toBeGreaterThan(0);
  });
});

describe('hockey stop', () => {
  it('digs in the edge facing the slide and keeps the upper body twisted', () => {
    // Skis sideways, sliding toward the skis' right at 10 m/s.
    const t = targetStance({ ...cruising, sideslip: 10, twist: 1.4 }, 0);
    expect(t.left.roll).toBeLessThan(-0.5); // right edges down
    expect(t.right.roll).toBeLessThan(-0.5);
    expect(t.twist).toBe(1.4);
  });
});

describe('walking steps and double-poling', () => {
  it('fires a step each half stride while skating or climbing', () => {
    const stance = initialStance();
    let steps = 0;
    for (let i = 0; i < 120; i++) {
      if (updateStance(stance, { ...cruising, speed: 1, skate: true, climb: true }, 1 / 60).step)
        steps++;
    }
    // 0.9 Hz stride, two steps (left, right) per stride: ~3.6 in 2 s.
    expect(steps).toBeGreaterThanOrEqual(3);
    expect(steps).toBeLessThanOrEqual(4);
  });

  it('double-poles: reach and plant, then push the hands back past the hips', () => {
    const reach = targetStance({ ...cruising, pole: true }, 0, 0.05);
    const push = targetStance({ ...cruising, pole: true }, 0, Math.PI * 0.75);
    expect(reach.armReach).toBeGreaterThan(0.8);
    expect(reach.poleSweep).toBeLessThan(0); // tips planted ahead of vertical
    expect(push.armReach).toBeLessThan(0);
    expect(push.poleSweep).toBeGreaterThan(0.8); // poles swept back
    expect(push.crouch).toBeGreaterThan(reach.crouch); // crunch into the push

    const stance = initialStance();
    let plants = 0;
    for (let i = 0; i < 180; i++) {
      if (updateStance(stance, { ...cruising, pole: true }, 1 / 60).plant) plants++;
    }
    expect(plants).toBeGreaterThanOrEqual(2); // 0.8 Hz over 3 s
    expect(plants).toBeLessThanOrEqual(3);
  });
});
