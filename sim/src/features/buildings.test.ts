import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { buildBuildingGeometry, signedArea } from './buildings';
import type { Building } from './types';

// 10 x 20 m box footprint, given clockwise to check it gets normalised.
const building: Building = {
  id: 1,
  type: 'yes',
  footprint: [
    [0, 0],
    [0, 20],
    [10, 20],
    [10, 0],
  ],
  base: 2000,
  top: 2012,
  heightSource: 'estimate',
};

describe('signedArea', () => {
  it('is positive for counter-clockwise rings', () => {
    expect(signedArea(building.footprint)).toBe(-200);
    expect(signedArea([...building.footprint].reverse())).toBe(200);
  });
});

describe('buildBuildingGeometry', () => {
  const geometry = buildBuildingGeometry([building]);
  const pos = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  // Building centre in world space (z = -north).
  const centre = new Vector3(5, 2006, -10);

  it('emits 4 walls and a 2-triangle roof', () => {
    expect(pos.count).toBe(4 * 6 + 2 * 3);
  });

  it('points every face outward (walls) or up (roof)', () => {
    for (let i = 0; i < pos.count; i += 3) {
      const faceCentre = new Vector3();
      for (let k = 0; k < 3; k++) {
        faceCentre.add(new Vector3(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)));
      }
      faceCentre.divideScalar(3);
      const n = new Vector3(normal.getX(i), normal.getY(i), normal.getZ(i));
      const isRoof = pos.getY(i) === 2012 && pos.getY(i + 1) === 2012 && pos.getY(i + 2) === 2012;
      if (isRoof) {
        expect(n.y).toBeCloseTo(1);
      } else {
        const outward = faceCentre.sub(centre).setY(0);
        expect(n.dot(outward)).toBeGreaterThan(0);
      }
    }
  });
});

describe('gable roofs', () => {
  // 20 x 8 m footprint, ridge along east at north = 4, 4 m rise.
  const gabled: Building = {
    id: 2,
    type: 'yes',
    footprint: [
      [0, 0],
      [20, 0],
      [20, 8],
      [0, 8],
    ],
    base: 2000,
    top: 2010,
    heightSource: 'estimate',
    roof: {
      ridge: [
        [-10, 4],
        [30, 4],
      ],
      halfWidth: 4,
      rise: 4,
      faces: [
        [
          [0, 0],
          [20, 0],
          [20, 4],
          [0, 4],
        ],
        [
          [0, 4],
          [20, 4],
          [20, 8],
          [0, 8],
        ],
      ],
    },
  };

  it('peaks the gable ends at the ridge and keeps eaves at the wall top', async () => {
    const { roofHeight } = await import('./buildings');
    expect(roofHeight(gabled, 5, 4)).toBeCloseTo(2014);
    expect(roofHeight(gabled, 5, 0)).toBeCloseTo(2010);
    expect(roofHeight(gabled, 5, 2)).toBeCloseTo(2012);
  });

  it('builds walls up to the ridge, with roof faces pointing up', () => {
    const g = buildBuildingGeometry([gabled]);
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const facade = g.getAttribute('facade');
    let maxWall = 0;
    for (let i = 0; i < pos.count; i++) {
      if (facade.getW(i) === 1) maxWall = Math.max(maxWall, pos.getY(i));
      else expect(nrm.getY(i)).toBeGreaterThan(0.5); // roof slopes face upward
    }
    expect(maxWall).toBeCloseTo(2014); // gable end reaches the ridge
  });
});
