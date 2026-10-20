import { describe, expect, it } from 'vitest';

import { engineSound, railSound } from './levels';

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

describe('railSound', () => {
  it('is silent off the rail or standing still on it', () => {
    expect(railSound(8, 0, false).level).toBe(0);
    expect(railSound(0.1, 0, true).level).toBe(0);
  });

  it('gets louder and higher with speed', () => {
    const slow = railSound(3, 0, true);
    const fast = railSound(10, 0, true);
    expect(fast.level).toBeGreaterThan(slow.level);
    expect(fast.pitch).toBeGreaterThan(slow.pitch);
  });

  it('a boardslide (skis across) is grittier and louder than a 50-50', () => {
    const fifty = railSound(6, 0.2, true);
    const board = railSound(6, 6, true);
    expect(board.grit).toBeCloseTo(1);
    expect(fifty.grit).toBeLessThan(0.1);
    expect(board.level).toBeGreaterThan(fifty.level);
  });
});
