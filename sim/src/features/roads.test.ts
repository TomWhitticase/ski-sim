import { describe, expect, it } from 'vitest';

import {
  chunks,
  deckHeights,
  densify,
  depthBias,
  drawnLines,
  ROAD_BANK,
  roadSolids,
  SNOW_POLE,
  STEP,
  stripFrame,
  TILE,
  tileOf,
} from './roads';
import type { Road } from './types';

const road = (over: Partial<Road> = {}): Road => ({
  id: 1,
  class: 'secondary',
  name: null,
  ref: null,
  width: 6,
  widthSource: 'estimate',
  surface: null,
  winter: 'cleared',
  structure: null,
  line: [
    [0, 0],
    [100, 0],
  ],
  ...over,
});

describe('densify', () => {
  it('adds points so no segment is longer than the step, keeping the corners', () => {
    const pts = densify([
      [0, 0],
      [10, 0],
      [10, 7],
    ]);
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1]!, pts[i]!];
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThanOrEqual(STEP + 1e-9);
    }
    expect(pts).toContainEqual([10, 0]);
    expect(pts[pts.length - 1]).toEqual([10, 7]);
  });

  it('drops repeated points', () => {
    expect(
      densify([
        [0, 0],
        [0, 0],
        [2, 0],
      ]),
    ).toEqual([
      [0, 0],
      [2, 0],
    ]);
  });
});

describe('stripFrame', () => {
  it('points right of the direction of travel, measuring distance along', () => {
    const { u, right } = stripFrame([
      [0, 0],
      [0, 10],
    ]);
    expect(u).toEqual([0, 10]);
    // Heading north, right is east.
    expect(right[0]![0]).toBeCloseTo(1);
    expect(right[0]![1]).toBeCloseTo(0);
  });

  it('mitres a corner so both edges stay a half-width from each leg', () => {
    // North then east: a right-angle bend at (0, 10).
    const { right } = stripFrame([
      [0, 0],
      [0, 10],
      [10, 10],
    ]);
    const [re, rn] = right[1]!;
    // The inside corner sits √2 out along the bisector: 1 m off each leg per metre.
    expect(re).toBeCloseTo(1);
    expect(rn).toBeCloseTo(-1);
  });

  it('limits the mitre on a hairpin', () => {
    const { right } = stripFrame([
      [0, 0],
      [0, 10],
      [0.5, 0],
    ]);
    expect(Math.hypot(...right[1]!)).toBeLessThanOrEqual(2 + 1e-9);
  });
});

describe('deckHeights', () => {
  it('runs straight between the ends, clear of the ground under it', () => {
    const u = [0, 10, 20, 30];
    // A gully under the bridge, and a hump that pokes above the straight line.
    const ground = [100, 80, 104, 100];
    // Its ends meet the road on the ground.
    const deck = deckHeights(u, ground);
    expect(deck[0]).toBe(100);
    expect(deck[1]).toBe(100);
    expect(deck[2]).toBeCloseTo(104.3);
    expect(deck[3]).toBe(100);
  });
});

describe('chunks', () => {
  it('splits into ranges that share their ends', () => {
    expect(chunks(10, 4)).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
    expect(chunks(2, 40)).toEqual([[0, 1]]);
  });
});

describe('tiles', () => {
  it('finds the tile a point is in, negative coordinates too', () => {
    expect(tileOf(10, 10)).toEqual([0, 0]);
    expect(tileOf(-1, TILE + 1)).toEqual([-1, 1]);
  });
});

describe('drawnLines', () => {
  it('draws cleared roads and bridges, not snow roads or tunnels', () => {
    expect(drawnLines(road())).toHaveLength(1);
    expect(drawnLines(road({ structure: 'bridge' }))).toHaveLength(1);
    expect(drawnLines(road({ winter: 'snow' }))).toEqual([]);
    expect(drawnLines(road({ structure: 'tunnel' }))).toEqual([]);
  });

  it('draws only what is off an airfield', () => {
    const drawn: [number, number][][] = [
      [
        [0, 0],
        [40, 0],
      ],
      [
        [60, 0],
        [100, 0],
      ],
    ];
    expect(drawnLines(road({ drawn }))).toBe(drawn);
  });
});

describe('depthBias', () => {
  it('is centimetres close by and metres far off', () => {
    expect(depthBias(10)).toBeLessThan(0.1);
    expect(depthBias(2000)).toBeGreaterThan(3);
    expect(depthBias(2000)).toBeLessThan(6);
  });
});

describe('roadSolids', () => {
  it('turns banks into boxes along them and poles into posts', () => {
    const solids = roadSolids(
      {
        roads: [],
        snowbanks: [
          [
            [0, 0],
            [20, 0],
          ],
        ],
        poles: [[5, 10]],
      },
      () => 100,
    );
    // 20 m of bank in pieces of at most 8 m, then the pole.
    expect(solids).toHaveLength(4);
    const bank = solids[0]!;
    const ns = bank.ring.map((p) => p[1]);
    expect(Math.max(...ns) - Math.min(...ns)).toBeCloseTo(ROAD_BANK.base - 0.8);
    expect(bank.top).toBeCloseTo(100 + ROAD_BANK.height - 0.2);
    const pole = solids[3]!;
    expect(pole.top).toBe(100 + SNOW_POLE.height);
  });
});
