import { describe, expect, it } from 'vitest';

import { Heightmap } from '../geo/heightmap';
import { buildChunkGeometry, sampleIndices } from './chunk-geometry';

describe('sampleIndices', () => {
  it('steps by stride and always includes the end', () => {
    expect(sampleIndices(0, 8, 4)).toEqual([0, 4, 8]);
    expect(sampleIndices(0, 10, 4)).toEqual([0, 4, 8, 10]);
    expect(sampleIndices(5, 6, 1)).toEqual([5, 6]);
  });
});

describe('buildChunkGeometry', () => {
  const size = 9;
  const data = new Float32Array(size * size).map((_, i) => 2000 + i);
  const hm = new Heightmap(data, size, size, 4, { west: 0, east: 32, south: -32, north: 0 });

  it('builds a grid plus a skirt ring, positioned relative to the chunk centre', () => {
    const { geometry, centerX, centerZ } = buildChunkGeometry(
      hm,
      { col0: 0, row0: 0, col1: 8, row1: 8 },
      2,
      50,
    );
    const n = 5; // samples per side at stride 2
    const ring = 4 * (n - 1);
    expect(geometry.getAttribute('position').count).toBe(n * n + ring);
    expect(geometry.getIndex()!.count).toBe((n - 1) * (n - 1) * 6 + ring * 6);
    expect(centerX).toBe(16);
    expect(centerZ).toBe(16); // centre is 16 m south of the north edge; z = -north

    const pos = geometry.getAttribute('position');
    // First vertex: north-west corner (col 0, row 0).
    expect(pos.getX(0) + centerX).toBe(0);
    expect(pos.getZ(0) + centerZ).toBe(0);
    expect(pos.getY(0)).toBe(2000);
    // First skirt vertex hangs below it.
    expect(pos.getY(n * n)).toBe(2000 - 50);
  });

  it('winds the surface counter-clockwise seen from above (front face up)', () => {
    const { geometry } = buildChunkGeometry(hm, { col0: 0, row0: 0, col1: 1, row1: 1 }, 1, 10);
    const pos = geometry.getAttribute('position');
    const [a, b, c] = Array.from(geometry.getIndex()!.array.slice(0, 3));
    const ux = pos.getX(b!) - pos.getX(a!);
    const uz = pos.getZ(b!) - pos.getZ(a!);
    const vx = pos.getX(c!) - pos.getX(a!);
    const vz = pos.getZ(c!) - pos.getZ(a!);
    // y component of (b - a) x (c - a) must be positive.
    expect(uz * vx - ux * vz).toBeGreaterThan(0);
  });
});
