import { describe, expect, it } from 'vitest';

import { CUT_SECONDS, SKY_HEIGHTS, planSky, skyPose } from './sky-transition';

const from = { x: 0, z: 0, ground: 2000, yaw: 0 };
const to = { x: 6000, z: -3000, ground: 1500, yaw: 2 };
const plan = planSky(from, to);

describe('skyPose', () => {
  it('cuts up in three steps above the start, looking straight down', () => {
    const heights = [0.1, 1.1, 2.1].map((k) => skyPose(plan, k * CUT_SECONDS));
    expect(heights.map((p) => p.stage)).toEqual([0, 1, 2]);
    heights.forEach((p, i) => {
      expect(p.x).toBe(0);
      expect(p.y - from.ground).toBeGreaterThanOrEqual(SKY_HEIGHTS[i]!);
      expect(p.pitch).toBeLessThan(-1.5);
    });
  });

  it('pans across at the top, then cuts down in three steps over the destination', () => {
    const mid = skyPose(plan, 3 * CUT_SECONDS + plan.pan / 2);
    expect(mid.stage).toBe(3);
    expect(mid.x).toBeCloseTo(3000, -1);
    expect(mid.y - 1750).toBeGreaterThan(SKY_HEIGHTS[2]);

    const down = [0.1, 1.1, 2.1].map((k) =>
      skyPose(plan, 3 * CUT_SECONDS + plan.pan + k * CUT_SECONDS),
    );
    expect(down.map((p) => p.stage)).toEqual([4, 5, 6]);
    expect(down.every((p) => p.x === to.x && p.z === to.z && p.yaw === to.yaw)).toBe(true);
    expect(down[0]!.y).toBeGreaterThan(down[1]!.y);
    expect(down[1]!.y).toBeGreaterThan(down[2]!.y);
    // Ends at the lowest cut, ready to swoop into your view.
    const end = skyPose(plan, plan.duration);
    expect(end.y - to.ground).toBeCloseTo(SKY_HEIGHTS[0], 0);
  });

  it('takes longer to pan further, within limits', () => {
    const near = planSky(from, { ...to, x: 200, z: 0 });
    const far = planSky(from, { ...to, x: 40_000, z: 0 });
    expect(near.pan).toBeLessThan(plan.pan);
    expect(far.pan).toBeLessThanOrEqual(2.6);
    expect(near.pan).toBeGreaterThanOrEqual(1.1);
  });
});
