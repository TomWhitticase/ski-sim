import { describe, expect, it } from 'vitest';

import type { Lift } from '../features/types';
import { LiftLine } from './lift-system';

const terminal = (end: 'bottom' | 'top', north: number, dirN: number, pad: number) => ({
  end,
  kind: 'chair' as const,
  detachable: true,
  east: 0,
  north,
  dir: [0, dirN] as [number, number],
  across: [1, 0] as [number, number],
  gauge: 5,
  length: 16,
  back: 4.5,
  width: 10,
  load: 5,
  unload: 4,
  pad,
  ramp: null,
});
const s = (north: number, ground: number, kind: 'station' | 'tower') => ({
  east: 0,
  north,
  ground,
  top: ground + 8,
  kind,
});
const lift = {
  id: 1,
  name: 'Test',
  type: 'chair_lift',
  gauge: 5,
  length: 1000,
  vertical: 300,
  supports: [s(0, 2000, 'station'), s(500, 2150, 'tower'), s(1000, 2300, 'station')],
  occupancy: 6,
  capacity: 3000,
  duration: 250,
  terminals: [terminal('bottom', 0, 1, 2000), terminal('top', 1000, -1, 2300)],
} as Lift;

describe('LiftLine', () => {
  const line = new LiftLine(lift);

  it('counts down to the next carrier reaching the loading point', () => {
    const a = line.nextToLoad(10);
    const b = line.nextToLoad(10.5);
    expect(a.inSeconds).toBeGreaterThanOrEqual(0);
    expect(a.inSeconds).toBeLessThan(line.headway);
    if (a.inSeconds > 0.5) {
      expect(b.carrier).toBe(a.carrier);
      expect(b.inSeconds).toBeCloseTo(a.inSeconds - 0.5, 5);
    }
  });

  it('detects that carrier passing the loading point', () => {
    const { carrier, inSeconds } = line.nextToLoad(10);
    expect(line.passed(carrier, line.loadTime, 10, 10 + inSeconds + 0.01)).toBe(true);
    expect(line.passed(carrier, line.loadTime, 10, 10 + inSeconds - 0.05)).toBe(false);
  });

  it('puts the loading point on the bottom pad, beside the uphill track', () => {
    expect(line.loadPoint.y).toBe(2000);
    expect(line.loadPoint.x).toBeCloseTo(2.5);
    expect(line.loadPoint.z).toBeCloseTo(-5);
    expect(line.inLoadingZone(line.loadPoint)).toBe(true);
  });
});
