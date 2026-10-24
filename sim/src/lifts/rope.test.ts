import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { LoopPath, loopCorners } from './loop';
import { hangPoints, ropeHeight, sag } from './rope';

// The same numbers as pipeline/tests/test_rope.py: the two sides must agree.
describe('rope sag (mirrors pipeline rope.py)', () => {
  it('is span² / (8 · catenary) mid-span', () => {
    expect(sag(1100, 300, 0.5)).toBeCloseTo(10.227272727272727, 12);
    expect(sag(1100, 300, 0)).toBe(0);
    expect(sag(1100, 300, 1)).toBe(0);
    expect(sag(null, 300, 0.5)).toBe(0); // older builds: straight
    expect(sag(undefined, 300, 0.5)).toBe(0);
  });

  it('hangs below the chord', () => {
    expect(ropeHeight(2000, 2050, 1100, 200, 0.25)).toBeCloseTo(2009.090909090909, 9);
  });

  it('is level through a station, then sags (16 m hall, 200 m span to a tower)', () => {
    // pipeline: rope.along(station, tower, 116, 1100) = 2016.8695454545455
    expect(ropeHeight(2002.83, 2040, 1100, 200, 0.5)).toBeCloseTo(2016.8695454545455, 9);
  });

  it('cuts a span into pieces that stay within 5 cm of the curve', () => {
    const a = new Vector3(0, 2000, 0);
    const b = new Vector3(0, 2050, -300);
    const pts = hangPoints(a, b, 1100);
    // 10.2 m of sag: ceil(sqrt(10.2 / 0.05)) = 15 pieces.
    expect(pts.length).toBe(14);
    const mid = pts[6]!.clone().lerp(pts[7]!, 0.5);
    const t = -mid.z / 300;
    expect(Math.abs(mid.y - ropeHeight(2000, 2050, 1100, 300, t))).toBeLessThan(0.05);
    expect(hangPoints(a, b, null)).toEqual([]);
  });
});

describe('carriers ride the sagging rope', () => {
  // A 500 m lift running north (world -z) over one tower, as in loop.test.ts.
  const across = new Vector3(1, 0, 0);
  const bottom = { wheel: new Vector3(0, 2003, 0), dir: new Vector3(0, 0, -1), length: 16 };
  const top = { wheel: new Vector3(0, 2103, -500), dir: new Vector3(0, 0, 1), length: 16 };
  const towers = [new Vector3(0, 2060, -250)];

  it('dips mid-span and comes up to each tower; level in the stations', () => {
    const path = new LoopPath(loopCorners(bottom, top, towers, across, 5, 1100), 5, 5);
    const near = (z: number) => {
      let best = path.points[0]!;
      for (const p of path.points.slice(0, path.points.length / 2)) {
        if (Math.abs(p.z - z) < Math.abs(best.z - z)) best = p;
      }
      return best;
    };
    // Bottom exit (z -16, 2003) to the tower (z -250, 2060): 234 m, 6.2 m of sag mid-span.
    const mid = near(-133);
    const chord = 2003 + (57 * 117) / 234;
    expect(chord - mid.y).toBeCloseTo((234 * 234) / 8800, 1);
    expect(Math.abs(near(-250).y - 2060)).toBeLessThan(0.2);
    expect(near(-8).y).toBeCloseTo(2003, 5);
  });
});
