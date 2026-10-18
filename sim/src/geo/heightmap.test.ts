import { describe, expect, it } from 'vitest';

import type { HeightmapMeta } from '../resort/manifest';
import { Heightmap } from './heightmap';

// 3x3 grid, 10 m cells, centred on the origin: h = 1000 + east - 2 * north
function plane(): Heightmap {
  const data = new Float32Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const east = -10 + col * 10;
      const north = 10 - row * 10;
      data[row * 3 + col] = 1000 + east - 2 * north;
    }
  }
  return new Heightmap(data, 3, 3, 10, { west: -10, east: 10, south: -10, north: 10 });
}

describe('Heightmap', () => {
  it('samples bilinearly in local coordinates (row 0 = north)', () => {
    const hm = plane();
    expect(hm.sample(0, 0)).toBeCloseTo(1000);
    expect(hm.sample(-10, 10)).toBeCloseTo(970);
    expect(hm.sample(3.5, -7.25)).toBeCloseTo(1000 + 3.5 + 14.5);
  });

  it('clamps outside the grid', () => {
    const hm = plane();
    expect(hm.sample(50, 0)).toBeCloseTo(hm.sample(10, 0));
    expect(hm.contains(50, 0)).toBe(false);
    expect(hm.contains(10, -10)).toBe(true);
  });

  it('decodes uint16 heights with offset and scale', () => {
    const meta = {
      width: 2,
      height: 1,
      cellSize: 1,
      extent: { west: 0, east: 1, south: 0, north: 0 },
      heightOffset: 821,
      heightScale: 0.05,
    } as HeightmapMeta;
    const hm = Heightmap.decode(new Uint16Array([0, 54780]).buffer, meta);
    expect(hm.at(0, 0)).toBeCloseTo(821);
    expect(hm.at(1, 0)).toBeCloseTo(3560, 3);
  });

  it('rejects data of the wrong size', () => {
    expect(() => new Heightmap(new Float32Array(4), 3, 3, 1, plane().extent)).toThrow();
  });
});
