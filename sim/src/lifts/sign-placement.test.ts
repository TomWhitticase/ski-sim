import { describe, expect, it } from 'vitest';

import { BOARD_CLEARANCE, checkSign, placeSign } from './sign-placement';

const query = {
  station: { x: 0, z: 0 },
  facing: { x: 0, z: 1 }, // approach from +z
  across: { x: 1, z: 0 },
  gauge: 5,
  boardWidth: 11,
  boardHeight: 2.1,
};
const flat = () => 1800;
const noBuildings = () => false;

describe('placeSign', () => {
  it('stands on the ground just in front of the station, beside the line', () => {
    const site = placeSign(query, flat, noBuildings)!;
    expect(site.z).toBe(8);
    expect(Math.abs(site.x)).toBeGreaterThan(5 / 2 + 11 / 2); // clear of the cable corridor
    expect(site.y - 2.1 / 2).toBeCloseTo(1800 + BOARD_CLEARANCE);
    expect(site.posts.every((p) => p.ground === 1800)).toBe(true);
    expect(checkSign(site, 2.1, flat, noBuildings)).toEqual([]);
  });

  it('never ends up on or in a nearby building (the Arpasson bug)', () => {
    // A chalet occupying the first choice: the right-hand side, 0-20 m ahead.
    const chalet = (x: number, z: number) => x > 0 && x < 20 && z > 0 && z < 20;
    const site = placeSign(query, flat, chalet)!;
    expect(chalet(site.x, site.z)).toBe(false);
    expect(site.posts.some((p) => chalet(p.x, p.z))).toBe(false);
    expect(site.y).toBeLessThan(1800 + 6); // on the ground, not lifted over the roof
  });

  it('keeps both posts on sloping ground', () => {
    const slope = (x: number) => 1800 + x * 0.4;
    const site = placeSign(query, slope, noBuildings)!;
    for (const p of site.posts) expect(p.ground).toBeCloseTo(slope(p.x));
    expect(checkSign(site, 2.1, slope, noBuildings)).toEqual([]);
  });

  it('avoids cliff edges, falling back to a spot on even ground', () => {
    // Ground drops 80 m just right of x = 6: the first choice straddles it.
    const cliff = (x: number) => (x > 6 ? 1720 : 1800);
    const site = placeSign(query, cliff, noBuildings)!;
    expect(Math.abs(site.posts[0].ground - site.posts[1].ground)).toBeLessThanOrEqual(2.5);
    expect(checkSign(site, 2.1, cliff, noBuildings)).toEqual([]);
  });

  it('gives up rather than place a bad sign when everything is built up', () => {
    expect(placeSign(query, flat, () => true)).toBeNull();
  });
});

describe('checkSign', () => {
  it('flags floating posts and boards', () => {
    const floating = {
      x: 0,
      y: 1830,
      z: 0,
      posts: [
        { x: -5, z: 0, ground: 1814 }, // claims a roof height, but the ground is at 1800
        { x: 5, z: 0, ground: 1814 },
      ] as [{ x: number; z: number; ground: number }, { x: number; z: number; ground: number }],
    };
    const problems = checkSign(floating, 2.1, flat, noBuildings);
    expect(problems).toContain('post not on the ground');
  });
});
