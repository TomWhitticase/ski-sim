import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT_HEARD_WITHIN,
  aircraftFalloff,
  aircraftSound,
  DRONE_HEARD_WITHIN,
  droneFalloff,
  droneSound,
  engineSound,
  railSound,
} from './levels';

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

describe('droneSound', () => {
  it('buzzes at ~160 Hz hovering, rising with speed', () => {
    const hover = droneSound(0);
    expect(hover.frequency).toBeCloseTo(160, 0);
    expect(hover.level).toBeGreaterThan(0);
    let last = hover;
    for (const speed of [5, 15, 30, 60, 300, 1500]) {
      const s = droneSound(speed);
      expect(s.frequency).toBeGreaterThan(last.frequency);
      expect(s.level).toBeGreaterThanOrEqual(last.level);
      last = s;
    }
    // Even flat out it's a buzz, not a whine.
    expect(droneSound(1500).frequency).toBeLessThan(450);
  });
});

describe('droneFalloff', () => {
  it('is full close by, quieter further off, and silent past hearing range', () => {
    expect(droneFalloff(0)).toBeCloseTo(1, 1);
    expect(droneFalloff(3)).toBeCloseTo(droneFalloff(0), 1);
    expect(droneFalloff(30)).toBeLessThan(0.25);
    expect(droneFalloff(100)).toBeLessThan(droneFalloff(30));
    expect(droneFalloff(100)).toBeGreaterThan(0);
    expect(droneFalloff(DRONE_HEARD_WITHIN)).toBe(0);
    expect(droneFalloff(5000)).toBe(0);
  });
});

describe('aircraftSound', () => {
  it('is silent with nothing turning', () => {
    expect(aircraftSound('plane', 0, 0).level).toBe(0);
    expect(aircraftSound('heli', 0.01, 1).level).toBe(0);
  });

  it("buzzes at a three-blade prop's 110 Hz, louder and brighter with power", () => {
    const idle = aircraftSound('plane', 0.62, 0);
    const full = aircraftSound('plane', 1, 1);
    expect(full.blade).toBeCloseTo(110, 0);
    expect(full.level).toBeGreaterThan(idle.level);
    expect(full.cutoff).toBeGreaterThan(idle.cutoff);
    expect(full.slap).toBe(0);
  });

  it("slaps at the H125's 19.5 Hz blade passage, harder under load", () => {
    const hover = aircraftSound('heli', 1, 0.6);
    expect(hover.blade).toBeCloseTo(19.5, 1);
    expect(aircraftSound('heli', 1, 1).slap).toBeGreaterThan(hover.slap);
    expect(hover.whine).toBeGreaterThan(4000);
  });

  it('carries a few kilometres, as loud as your own close by', () => {
    expect(aircraftFalloff(10)).toBeCloseTo(1, 1);
    expect(aircraftFalloff(500)).toBeGreaterThan(0.05);
    expect(aircraftFalloff(AIRCRAFT_HEARD_WITHIN)).toBe(0);
  });
});
