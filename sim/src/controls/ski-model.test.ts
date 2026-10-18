import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { createSkiGeometry, skiProfile } from './ski-model';

describe('skiProfile', () => {
  it('has a sidecut: narrower at the waist than at the shovel and tail', () => {
    const waist = skiProfile(0.48).halfWidth;
    expect(skiProfile(0.86).halfWidth).toBeGreaterThan(waist + 0.008);
    expect(skiProfile(0.06).halfWidth).toBeGreaterThan(waist + 0.004);
  });

  it('is flat underfoot with the tip turned up and a small tail kick', () => {
    expect(skiProfile(0.5).rise).toBe(0);
    expect(skiProfile(1).rise).toBeGreaterThan(0.05);
    expect(skiProfile(0).rise).toBeGreaterThan(0.015);
    expect(skiProfile(0).rise).toBeLessThan(skiProfile(1).rise);
  });
});

describe('createSkiGeometry', () => {
  it('points the top face up and the base face down', () => {
    const g = createSkiGeometry();
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const index = g.getIndex()!;
    // The first triangle of the first strip is on the top sheet; the base strip follows.
    const firstNormal = (tri: number) => {
      const i = index.getX(tri * 3);
      return new Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    };
    const trianglesPerStrip = 64 * 2;
    // Mid-ski, away from the curved ends.
    const mid = 32 * 2;
    expect(firstNormal(mid).y).toBeGreaterThan(0.9);
    expect(firstNormal(trianglesPerStrip + mid).y).toBeLessThan(-0.9);
    expect(pos.count).toBe(4 * 65 * 2);
  });
});
