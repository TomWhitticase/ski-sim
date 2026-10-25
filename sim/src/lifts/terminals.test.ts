import { describe, expect, it } from 'vitest';

import type { Terminal } from '../features/types';
import { createTerminals, GROUND_GAP } from './terminals';

const terminal = (kind: Terminal['kind'], extra: Partial<Terminal> = {}): Terminal => ({
  end: 'bottom',
  kind,
  detachable: kind !== 'drag',
  east: 0,
  north: 0,
  dir: [0, 1],
  across: [1, 0],
  gauge: 6,
  length: 20,
  back: 5,
  width: 13,
  load: 9,
  unload: 11,
  pad: 2000,
  ramp: null,
  roofTop: 6.2,
  hut: kind === 'chair' || kind === 'drag',
  entrance: 'side',
  walk: 5,
  ...extra,
});

/** Signed volume of a mesh: positive when its triangles wind outwards (front faces out). */
function signedVolume(t: Terminal): number {
  const { mesh } = createTerminals([{ terminal: t, rail: 4 }], () => 2000);
  const p = mesh.geometry.getAttribute('position');
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    const [ax, ay, az] = [p.getX(i), p.getY(i) - 2000, p.getZ(i)];
    const [bx, by, bz] = [p.getX(i + 1), p.getY(i + 1) - 2000, p.getZ(i + 1)];
    const [cx, cy, cz] = [p.getX(i + 2), p.getY(i + 2) - 2000, p.getZ(i + 2)];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

describe('createTerminals', () => {
  // The uphill track is to the left of the line at some terminals and to the right at
  // others. A station built in a mirrored frame turns inside out: the renderer culls its
  // outside faces, so walls vanish from some angles and you see the far walls' insides.
  it.each(['chair', 'gondola', 'cabin', 'drag'] as const)(
    '%s stations face outwards whichever side the uphill track is on',
    (kind) => {
      for (const extra of [{}, { detachable: false }]) {
        const right = signedVolume(terminal(kind, { ...extra, across: [1, 0] }));
        const left = signedVolume(terminal(kind, { ...extra, across: [-1, 0] }));
        expect(right).toBeGreaterThan(0);
        expect(left).toBeCloseTo(right, 1);
      }
    },
  );

  it('never puts a face level with the snow on the pad (no z-fighting)', () => {
    const terminals = [
      terminal('chair'),
      terminal('chair', { detachable: false, end: 'top', entrance: 'ramp' }),
      terminal('gondola'),
      terminal('gondola', { entrance: 'back' }),
      terminal('cabin'),
      terminal('drag'),
    ].map((t) => ({ terminal: t, rail: 4 }));
    const { mesh } = createTerminals(terminals, () => 2000);
    const y = mesh.geometry.getAttribute('position');
    for (let i = 0; i < y.count; i++) {
      expect(Math.abs(y.getY(i) - 2000)).toBeGreaterThanOrEqual(GROUND_GAP - 1e-4);
    }
  });
});

describe('station buildings and retaining walls', () => {
  const topOf = (t: Terminal) => {
    const { mesh } = createTerminals([{ terminal: t, rail: 4.3 }], () => 2000);
    const p = mesh.geometry.getAttribute('position');
    let top = -Infinity;
    for (let i = 0; i < p.count; i++) top = Math.max(top, p.getY(i) - 2000);
    return top;
  };

  it('a roofed hall has no slab of its own and its walls reach the storeys above', () => {
    const open = terminal('gondola');
    const roofed = terminal('gondola', { roofed: true });
    // The open hall's slab tops out at roofTop + 0.3; the roofed hall's walls reach the
    // same height (pipeline station_top), so no gap under the storeys and no slab.
    expect(topOf(open)).toBeCloseTo(6.5, 1);
    expect(topOf(roofed)).toBeCloseTo(6.5, 1);
    const slabWidth = (t: Terminal) => {
      const { mesh } = createTerminals([{ terminal: t, rail: 4.3 }], () => 2000);
      const p = mesh.geometry.getAttribute('position');
      let maxX = -Infinity;
      for (let i = 0; i < p.count; i++) if (p.getY(i) - 2000 > 6) maxX = Math.max(maxX, p.getX(i));
      return maxX;
    };
    // The slab overhangs the walls (half-width 6.5) by 0.6 m; roofed, nothing does.
    expect(slabWidth(open)).toBeGreaterThan(6.9);
    expect(slabWidth(roofed)).toBeLessThan(6.7);
  });

  it('retaining walls are solid and stand from their bottom to their top', () => {
    const walls: Terminal['walls'] = [
      [-11, -12, -11, -10, -0.5, 4.2, 1],
      [-11, 12, 1, 12, -4.5, 1, -1],
    ];
    const t = terminal('gondola', { walls });
    const { obstacles } = createTerminals([{ terminal: t, rail: 4.3 }], () => 2000);
    const bare = createTerminals([{ terminal: terminal('gondola'), rail: 4.3 }], () => 2000);
    expect(obstacles.length).toBe(bare.obstacles.length + 2);
    const added = obstacles.slice(0, 2); // walls are built first
    const spans = added.map((o) => [o.base - 2000, o.top - 2000]);
    [
      [-0.5, 4.2],
      [-4.5, 1],
    ].forEach(([b, top], k) => {
      expect(spans[k]![0]).toBeCloseTo(b!, 5);
      expect(spans[k]![1]).toBeCloseTo(top!, 5);
    });
  });
});
