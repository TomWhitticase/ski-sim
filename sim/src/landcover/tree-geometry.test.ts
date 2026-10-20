import type { BufferGeometry } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { createTreeGeometry, DETAILED, MINIMAL, SIMPLE, snowOn } from './tree-geometry';

/**
 * How much of the frame a tree covers from `elevation` above the horizon: an
 * orthographic render of the shape's front faces, averaged over azimuths. (Colour is
 * checked in the real renderer, `e2e/forest.spec.ts`: only there do the detailed trees
 * shade each other.)
 */
function coverage(geometry: BufferGeometry, elevation: number) {
  const N = 96;
  const pos = geometry.getAttribute('position');
  let covered = 0;
  const AZIMUTHS = 8;
  for (let k = 0; k < AZIMUTHS; k++) {
    const az = (k / AZIMUTHS) * Math.PI * 2;
    const el = (elevation * Math.PI) / 180;
    // Camera basis: forward (into the scene), right, up.
    const f = [-Math.cos(el) * Math.sin(az), -Math.sin(el), -Math.cos(el) * Math.cos(az)];
    const r = [Math.cos(az), 0, -Math.sin(az)];
    const u = [
      r[1]! * f[2]! - r[2]! * f[1]!,
      r[2]! * f[0]! - r[0]! * f[2]!,
      r[0]! * f[1]! - r[1]! * f[0]!,
    ];
    const hit = new Uint8Array(N * N);
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    for (let t = 0; t < pos.count; t += 3) {
      const p = [0, 1, 2].map((i) => [pos.getX(t + i), pos.getY(t + i) - 0.5, pos.getZ(t + i)]);
      const e1 = p[1]!.map((v, i) => v - p[0]![i]!);
      const e2 = p[2]!.map((v, i) => v - p[0]![i]!);
      const n = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      if (dot(n, f) >= 0) continue; // back face (culled, like the material)
      const s = p.map((q) => [((dot(q, r) + 0.6) / 1.2) * N, ((0.6 - dot(q, u)) / 1.2) * N]);
      const [a, b, c] = s as [number[], number[], number[]];
      const area = (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a[0]!, b[0]!, c[0]!)));
      const x1 = Math.min(N - 1, Math.ceil(Math.max(a[0]!, b[0]!, c[0]!)));
      const y0 = Math.max(0, Math.floor(Math.min(a[1]!, b[1]!, c[1]!)));
      const y1 = Math.min(N - 1, Math.ceil(Math.max(a[1]!, b[1]!, c[1]!)));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((b[0]! - px) * (c[1]! - py) - (b[1]! - py) * (c[0]! - px)) / area;
          const w1 = ((c[0]! - px) * (a[1]! - py) - (c[1]! - py) * (a[0]! - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 >= 0 && w1 >= 0 && w2 >= 0) hit[y * N + x] = 1;
        }
      }
    }
    for (let i = 0; i < N * N; i++) covered += hit[i]!;
  }
  return covered / (AZIMUTHS * N * N);
}

const ELEVATIONS = [10, 30, 60]; // flying low over the trees, higher, looking down

describe('tree detail levels', () => {
  const detailed = createTreeGeometry(DETAILED);
  for (const [name, shape] of [
    ['simple', SIMPLE],
    ['minimal', MINIMAL],
  ] as const) {
    it(`${name} is the detailed tree's size on screen from every angle`, () => {
      const coarse = createTreeGeometry(shape);
      for (const elevation of ELEVATIONS) {
        const ratio = coverage(coarse, elevation) / coverage(detailed, elevation);
        expect(ratio).toBeGreaterThan(0.85);
        expect(ratio).toBeLessThan(1.15);
      }
    });
  }

  it('snow settles on gentle faces, not steep ones', () => {
    expect(snowOn(1)).toBe(1);
    expect(snowOn(0.2)).toBeLessThan(snowOn(0.4));
    expect(snowOn(0)).toBe(0);
  });
});
