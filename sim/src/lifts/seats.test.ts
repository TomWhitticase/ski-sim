import { describe, expect, it } from 'vitest';

import { cabinLayout, chairSeatX } from './carriers';
import { type Carrier, chooseSeat, seatCount, seatSpot } from './seats';

const chair = (seats: number): Carrier => ({ kind: 'chair', seats, hang: 2.3, cabin: null });
const gondola = (seats: number): Carrier => ({
  kind: 'gondola',
  seats,
  hang: 3,
  cabin: cabinLayout('gondola', seats, 3),
});

describe('seats', () => {
  it('puts each rider on a chair seat of its own, filling in beside the first', () => {
    const c = chair(4);
    expect(seatCount(c)).toBe(4);
    const xs = [0, 1, 2, 3].map((s) => seatSpot(c, s).x);
    expect(xs[0]).toBeCloseTo(chairSeatX(4, 3)); // the +x end
    for (let s = 1; s < 4; s++) expect(xs[s - 1]! - xs[s]!).toBeCloseTo(0.5); // seat by seat
    expect(new Set(xs).size).toBe(4);
  });

  it('spreads a gondola’s riders along the back bench, clear of the walls', () => {
    const c = gondola(8);
    const n = seatCount(c);
    expect(n).toBeGreaterThan(1);
    const xs = Array.from({ length: n }, (_, s) => seatSpot(c, s).x);
    for (const x of xs) expect(Math.abs(x)).toBeLessThan(c.cabin!.w / 2 - 0.3);
    expect(new Set(xs.map((x) => x.toFixed(2))).size).toBe(n);
  });

  it('chooses the lowest free seat, or the least crowded when full', () => {
    expect(chooseSeat(4, [])).toBe(0);
    expect(chooseSeat(4, [0])).toBe(1);
    expect(chooseSeat(4, [1, 0, 3])).toBe(2);
    expect(chooseSeat(2, [0, 1, 0])).toBe(1);
    expect(chooseSeat(1, [0])).toBe(0);
  });
});
