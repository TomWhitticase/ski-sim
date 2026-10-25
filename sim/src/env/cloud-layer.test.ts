import { describe, expect, it } from 'vitest';

import { CLOUD_RADIUS, gridOffset } from './cloud-layer';

describe('cloud deck grid', () => {
  it('is fine under the camera and reaches the horizon at its edge', () => {
    const step = (u: number) => gridOffset(u + 2 / 96) - gridOffset(u);
    expect(gridOffset(0)).toBe(0);
    expect(gridOffset(1)).toBe(CLOUD_RADIUS);
    expect(gridOffset(-1)).toBe(-CLOUD_RADIUS);
    expect(step(0)).toBeLessThan(80);
    expect(step(1 - 2 / 96)).toBeGreaterThan(2000);
    // Always outward.
    for (let u = -1; u < 1; u += 2 / 96) expect(step(u)).toBeGreaterThan(0);
  });
});
