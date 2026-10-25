import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { CableIndex } from './cables';

describe('lift cables', () => {
  // A 900 m cable car span climbing 300 m, diagonally across many grid cells.
  const index = new CableIndex([[new Vector3(0, 2000, 0), new Vector3(600, 2300, -670)]]);

  it('finds a point on the rope anywhere along a long span', () => {
    for (const t of [0.05, 0.5, 0.95]) {
      const p = new Vector3(600 * t, 2000 + 300 * t, -670 * t);
      expect(index.hit(p, 1)).toBe(true);
      expect(index.hit(p.clone().add(new Vector3(0, 0.8, 0)), 1)).toBe(true);
    }
  });

  it('misses a point a few metres off it, above or beside', () => {
    const mid = new Vector3(300, 2150, -335);
    expect(index.hit(mid.clone().add(new Vector3(0, 4, 0)), 1)).toBe(false);
    expect(index.hit(mid.clone().add(new Vector3(5, 0, 5)), 1)).toBe(false);
    expect(index.hit(new Vector3(5000, 2000, 0), 1)).toBe(false);
  });
});
