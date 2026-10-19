import { describe, expect, it } from 'vitest';

import { restaurantViewpoint } from '../nav/places';
import { restaurantLabel } from '../ui/labels';
import { STYLE, facadeStyle, roofHeight } from './buildings';
import { layoutTerrace } from './restaurants';
import type { Building, Restaurant } from './types';

// A 16 x 10 m hut with a 20 x 7 m deck along its south wall.
const hut: Building = {
  id: 7,
  type: 'yes',
  footprint: [
    [-8, -5],
    [8, -5],
    [8, 5],
    [-8, 5],
  ],
  base: 1999,
  top: 2006,
  heightSource: 'estimate',
  use: 'restaurant',
  roof: {
    ridge: [
      [-30, 0],
      [30, 0],
    ],
    halfWidth: 5,
    rise: 2,
    faces: [],
    eaves: 1.3,
  },
};
const deck: [number, number][] = [
  [-10, -5.5],
  [10, -5.5],
  [10, -12.5],
  [-10, -12.5],
];
const restaurant: Restaurant = {
  id: 1,
  name: 'Krazy Kanguruh',
  east: 0,
  north: 0,
  ground: 2000,
  building: 7,
  terrace: { ring: deck, top: 2000.3, source: 'synthetic' },
  sign: { east: 0, north: -5.1, height: 2005, heading: 180, width: 8 },
};

describe('layoutTerrace', () => {
  const { tables, loungers } = layoutTerrace(deck, hut.footprint);

  it('puts parasol tables on the deck, clear of the edges and the hut', () => {
    expect(tables.length).toBeGreaterThan(0);
    for (const [e, n] of tables) {
      expect(Math.abs(e)).toBeLessThanOrEqual(10 - 2.2);
      expect(n).toBeLessThanOrEqual(-5.5 - 2.2);
      expect(n).toBeGreaterThanOrEqual(-12.5 + 2.2);
    }
  });

  it('lines loungers up along the open edges, facing out, not against the wall', () => {
    expect(loungers.length).toBeGreaterThan(5);
    for (const { at, facing } of loungers) {
      expect(at[1]).toBeLessThan(-6); // none on the wall side
      const [fe, fn] = facing;
      expect(Math.hypot(fe, fn)).toBeCloseTo(1);
      // Facing away from the hut: out over the deck's railing.
      expect(fn < -0.5 || Math.abs(fe) > 0.5).toBe(true);
    }
  });
});

describe('hut buildings', () => {
  it('get the hut facade', () => {
    expect(Math.floor(facadeStyle(hut))).toBe(STYLE.hut);
    expect(Math.floor(facadeStyle({ ...hut, use: undefined }))).not.toBe(STYLE.hut);
  });

  it('have eaves that continue the roof planes down past the walls', () => {
    expect(roofHeight(hut, 0, 0)).toBeCloseTo(2008); // ridge
    expect(roofHeight(hut, 0, 5)).toBeCloseTo(2006); // wall top
    expect(roofHeight(hut, 0, 6.3)).toBeLessThan(2006); // eaves overhang
    const flatEaves = { ...hut, roof: { ...hut.roof!, eaves: undefined } };
    expect(roofHeight(flatEaves, 0, 6.3)).toBe(2006);
  });
});

describe('restaurant label and teleport', () => {
  it('floats the label just over the roof, in the middle of the building', () => {
    const label = restaurantLabel(restaurant, hut);
    expect(label.kind).toBe('restaurant');
    expect(label.position.x).toBeCloseTo(0);
    expect(label.position.y).toBeCloseTo(2006 + 2 + 3);
    expect(label.maxDistance).toBeLessThan(3000);
  });

  it('stands you out in front of the terrace, looking at the hut', () => {
    const pose = restaurantViewpoint(restaurant, hut);
    expect(pose.north).toBeLessThan(-12.5); // beyond the deck, on the south side
    expect(pose.heading).toBeCloseTo(0); // facing north, at the hut
  });
});
