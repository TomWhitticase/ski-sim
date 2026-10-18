import { describe, expect, it } from 'vitest';

import type { Lift } from '../features/types';
import { carrierAt, nextDeparture, operation } from './operation';

const line = (length: number, rise: number) => [
  { east: 0, north: 0, ground: 2000, top: 2005, kind: 'station' as const },
  { east: 0, north: length, ground: 2000 + rise, top: 2005 + rise, kind: 'station' as const },
];

// Cascades: 6-seat chair, 4000/h, 4:45 for ~1426 m.
const cascades = {
  id: 1,
  name: 'Cascades',
  type: 'chair_lift',
  gauge: 5,
  length: 1410,
  vertical: 300,
  supports: line(1394, 300),
  occupancy: 6,
  capacity: 4000,
  duration: 285,
} as Lift;

describe('operation', () => {
  it('derives speed and spacing from published specs', () => {
    const op = operation(cascades);
    expect(op.kind).toBe('chair');
    expect(op.speed).toBeCloseTo(5, 1); // 1426 m / 285 s
    // 5 m/s × 3600 × 6 / 4000 = 27 m between chairs
    expect(op.spacing).toBeGreaterThan(25);
    expect(op.spacing).toBeLessThan(29);
    expect(op.carriers).toBeGreaterThan(95);
  });

  it('falls back to typical figures and runs cable cars as two cabins', () => {
    const tram = operation({
      ...cascades,
      type: 'cable_car',
      occupancy: null,
      capacity: null,
      duration: null,
    });
    expect(tram.reversible).toBe(true);
    expect(tram.carriers).toBe(2);
    expect(tram.speed).toBe(10);
  });
});

describe('carrierAt', () => {
  it('loops carriers up one side and down the other', () => {
    const op = operation(cascades);
    const L = op.length;
    expect(carrierAt(op, 0, 0)).toEqual({ distance: 0, side: 1, moving: true });
    const halfway = carrierAt(op, 0, L / 2 / op.speed);
    expect(halfway.side).toBe(1);
    expect(halfway.distance).toBeCloseTo(L / 2);
    const coming = carrierAt(op, 0, (1.5 * L) / op.speed);
    expect(coming.side).toBe(-1);
    expect(coming.distance).toBeCloseTo(L / 2);
  });

  it('shuttles jig-back cabins in opposite directions with a dwell at each end', () => {
    const op = operation({ ...cascades, type: 'cable_car' });
    expect(carrierAt(op, 0, 10)).toMatchObject({ distance: 0, moving: false });
    expect(carrierAt(op, 1, 10)).toMatchObject({ distance: op.length, moving: false });
    const t = op.dwell + op.length / op.speed / 2;
    expect(carrierAt(op, 0, t).distance).toBeCloseTo(op.length / 2);
    expect(carrierAt(op, 1, t).distance).toBeCloseTo(op.length / 2);
    expect(nextDeparture(op, 10)).toBe(0);
    expect(nextDeparture(op, op.dwell + 1)).toBeGreaterThan(0);
  });
});
