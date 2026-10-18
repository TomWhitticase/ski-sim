import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { ObstacleIndex } from './obstacles';

// A 10 x 10 m hut from east 0-10, north 0-10, 3 m tall on ground at 2000.
const index = new ObstacleIndex([
  {
    ring: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    base: 2000,
    top: 2003,
  },
]);

describe('ObstacleIndex', () => {
  it('pushes you back out of a wall you skied into and stops you going further in', () => {
    const p = new Vector3(0.2, 2000, -5); // 20 cm inside the west wall
    const v = new Vector3(3, 0, 1); // heading east, into the hut, and a bit south
    expect(index.resolve(p, v)).toBe(true);
    expect(p.x).toBeCloseTo(-0.4);
    expect(v.x).toBeCloseTo(0); // into-wall component removed
    expect(v.z).toBe(1); // sliding along the wall is fine
  });

  it('ignores you when clear of it, or flying over the roof', () => {
    expect(index.resolve(new Vector3(-2, 2000, -5), new Vector3())).toBe(false);
    expect(index.resolve(new Vector3(5, 2010, -5), new Vector3())).toBe(false);
  });
});
