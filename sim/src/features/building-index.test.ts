import { describe, expect, it } from 'vitest';

import { BuildingIndex } from './building-index';
import type { Building } from './types';

const box = (id: number, e: number, n: number, size: number): Building => ({
  id,
  type: 'yes',
  footprint: [
    [e, n],
    [e + size, n],
    [e + size, n + size],
    [e, n + size],
  ],
  base: 0,
  top: 10,
  heightSource: 'estimate',
});

describe('BuildingIndex', () => {
  const index = new BuildingIndex([box(1, 0, 0, 10), box(2, 120, 75, 30)], 1);

  it('finds points inside footprints, including across grid cells', () => {
    expect(index.contains(5, 5)).toBe(true);
    expect(index.contains(140, 100)).toBe(true);
    expect(index.contains(60, 60)).toBe(false);
  });

  it('treats points within the margin of a wall as inside', () => {
    expect(index.contains(10.5, 5)).toBe(true);
    expect(index.contains(12, 5)).toBe(false);
  });
});
