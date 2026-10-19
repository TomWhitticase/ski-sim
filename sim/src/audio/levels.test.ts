import { describe, expect, it } from 'vitest';

import { engineSound } from './levels';

describe('engineSound', () => {
  it('is silent with the engine off', () => {
    expect(engineSound(8000, 1, false).level).toBe(0);
  });

  it('fires twice a revolution: ~53 Hz at idle, ~270 Hz near the limiter', () => {
    expect(engineSound(1600, 0, true).frequency).toBeCloseTo(53.3, 0);
    expect(engineSound(8000, 1, true).frequency).toBeCloseTo(266.7, 0);
  });

  it('gets louder and brighter on the throttle, and warbles only at idle', () => {
    const idle = engineSound(1600, 0, true);
    const wot = engineSound(8000, 1, true);
    expect(wot.level).toBeGreaterThan(idle.level * 2);
    expect(wot.cutoff).toBeGreaterThan(idle.cutoff * 4);
    expect(idle.warble).toBeGreaterThan(0.3);
    expect(wot.warble).toBeLessThan(0.01);
  });
});
