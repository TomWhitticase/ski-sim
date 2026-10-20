import { describe, expect, it } from 'vitest';

import { onScreenMiddle } from './world-map';

describe('onScreenMiddle', () => {
  it('finds the middle of the part of a line in view, and its direction', () => {
    // Runs left to right across a 100 px wide view, starting and ending off it.
    const pts: [number, number][] = [
      [-50, 10],
      [20, 10],
      [80, 10],
      [300, 10],
    ];
    const [x, y, dx, dy] = onScreenMiddle(pts, 100, 100);
    expect(x).toBeCloseTo(50);
    expect(y).toBeCloseTo(10);
    expect([dx, dy]).toEqual([1, 0]);
  });

  it('is NaN when none of the line is in view', () => {
    const [x] = onScreenMiddle(
      [
        [-50, -50],
        [-10, -10],
      ],
      100,
      100,
    );
    expect(x).toBeNaN();
  });
});
