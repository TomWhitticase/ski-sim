import { describe, expect, it } from 'vitest';

import { LandCover } from './land-cover';

describe('LandCover', () => {
  // 3 x 2 grid, 8 m cells, west edge at 0 and north edge at 8: tree cover in R.
  const data = new Uint8ClampedArray(3 * 2 * 4);
  [0, 255, 255, 0, 0, 255].forEach((r, i) => (data[i * 4] = r));
  const cover = new LandCover({ data, width: 3, height: 2, colorSpace: 'srgb' } as ImageData, 8, {
    west: 0,
    east: 16,
    south: 0,
    north: 8,
  });

  it('samples tree cover bilinearly on the grid-registered samples', () => {
    expect(cover.tree(8, 8)).toBeCloseTo(1);
    expect(cover.tree(0, 8)).toBeCloseTo(0);
    expect(cover.tree(4, 8)).toBeCloseTo(0.5);
    expect(cover.tree(16, 4)).toBeCloseTo(1); // halfway between rows on the east edge
  });

  it('is treeless outside the grid', () => {
    expect(cover.tree(-1, 4)).toBe(0);
    expect(cover.tree(8, 9)).toBe(0);
  });
});
