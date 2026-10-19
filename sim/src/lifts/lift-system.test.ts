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

describe('LiftLine both ways', () => {
  const asKind = (type: string, kind: 'gondola' | 'cabin') =>
    ({
      ...lift,
      type,
      occupancy: kind === 'gondola' ? 8 : 80,
      terminals: lift.terminals.map((t) => ({ ...t, kind })),
    }) as Lift;

  it('chairs only go up', () => {
    expect(new LiftLine(lift).down).toBeNull();
  });

  it('a gondola also loads at the top, on the down track, and unloads at the bottom', () => {
    const g = new LiftLine(asKind('gondola', 'gondola'));
    const down = g.down!;
    expect(down.loadPoint.y).toBe(2300);
    expect(down.loadPoint.x).toBeCloseTo(-2.5); // the -across (down) track
    expect(down.unloadPoint.y).toBe(2000);
    expect(down.unloadPoint.x).toBeCloseTo(-2.5);
    // A carrier leaving the top reaches the bottom later in the loop.
    const p = g.loop!.period;
    const ride = (((down.unloadTime - down.loadTime) % p) + p) % p;
    expect(ride).toBeGreaterThan(p * 0.3);
    expect(ride).toBeLessThan(p * 0.7);
    const { carrier, inSeconds } = g.nextToLoad(10, true);
    expect(g.passed(carrier, down.loadTime, 10, 10 + inSeconds + 0.01)).toBe(true);
    expect(g.loadingSpot(true).x).toBeLessThan(-2.5); // beside the down track
  });

  it('a cable car boards its top cabin going down', () => {
    const c = new LiftLine(asKind('cable_car', 'cabin'));
    expect(c.down).not.toBeNull();
    expect(c.nextToLoad(0, true).carrier).toBe(1);
    const at = c.pose(1, 0, c.down!.loadPoint.clone(), c.down!.loadPoint.clone());
    expect(at.distance).toBeCloseTo(c.op.length); // docked at the top when cabin 0 boards
  });
});
