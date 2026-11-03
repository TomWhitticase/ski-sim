import { describe, expect, it } from 'vitest';

import type { Terminal } from '../features/types';
import { createTerminals, GROUND_GAP, livery, LIVERY_SATURATION, mute } from './terminals';

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

  describe('livery', () => {
    it('mute pulls a colour toward its own luminance', () => {
      const vivid: [number, number, number] = [0.1, 0.42, 0.62];
      const grey = mute(vivid, 0);
      expect(grey[0]).toBeCloseTo(grey[1], 5);
      expect(grey[1]).toBeCloseTo(grey[2], 5);
      const same = mute(vivid, 1);
      for (let i = 0; i < 3; i++) expect(same[i]).toBeCloseTo(vivid[i]!, 5);
      // Partial desaturation narrows the channel spread by exactly the factor.
      const spread = (c: [number, number, number]) => Math.max(...c) - Math.min(...c);
      expect(spread(mute(vivid, 0.6))).toBeCloseTo(spread(vivid) * 0.6, 5);
    });

    it('keeps every station roof colour plausibly muted (not a vivid teal)', () => {
      expect(LIVERY_SATURATION).toBeLessThan(1);
      for (let id = -20; id < 40; id++) {
        const [paint] = livery(id);
        // No channel spread wide enough to read as a vivid painted roof against the snow.
        expect(Math.max(...paint) - Math.min(...paint)).toBeLessThan(0.34);
      }
    });
  });

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
