import { describe, expect, it } from 'vitest';

import {
  hash01,
  LARCH,
  placeTrees,
  SPACING,
  STRIDE,
  TILE,
  type TreeParams,
  type TreeSource,
  typicalHeight,
  unpack,
} from './tree-placement';

const params: TreeParams = { treeLine: 2100, height: { valley: 26, treeLine: 7 } };
const flat = (cover: number, ground = 1500): TreeSource => ({
  cover: () => cover,
  ground: () => ground,
});
const count = (trees: Float32Array) => trees.length / STRIDE;

describe('placeTrees', () => {
  it('is deterministic per tile', () => {
    expect(placeTrees(3, -7, flat(0.8), params)).toEqual(placeTrees(3, -7, flat(0.8), params));
    expect(placeTrees(3, -7, flat(0.8), params)).not.toEqual(placeTrees(4, -7, flat(0.8), params));
  });

  it('plants nothing without tree cover', () => {
    expect(count(placeTrees(0, 0, flat(0), params))).toBe(0);
  });

  it('plants a dense but clumpy forest at full cover', () => {
    let trees = 0;
    for (let t = 0; t < 25; t++)
      trees += count(placeTrees(t % 5, Math.floor(t / 5), flat(1), params));
    const perHectare = trees / ((25 * TILE * TILE) / 10_000);
    // At most one per SPACING cell (400/ha); glades keep it well under that.
    expect(perHectare).toBeGreaterThan(200);
    expect(perHectare).toBeLessThan(10_000 / (SPACING * SPACING));
  });

  it('thins out with partial cover', () => {
    const at = (cover: number) => {
      let n = 0;
      for (let t = 0; t < 25; t++) n += count(placeTrees(t, 2, flat(cover), params));
      return n;
    };
    expect(at(0.3)).toBeLessThan(at(1) * 0.45);
    expect(at(0.3)).toBeGreaterThan(at(1) * 0.15);
  });

  it('keeps every tree inside its tile, on the ground', () => {
    const trees = placeTrees(-2, 5, flat(1, 1834), params);
    for (let i = 0; i < trees.length; i += STRIDE) {
      expect(trees[i]).toBeGreaterThanOrEqual(-2 * TILE);
      expect(trees[i]).toBeLessThan(-1 * TILE);
      expect(trees[i + 1]).toBe(1834);
      expect(trees[i + 2]).toBeGreaterThanOrEqual(5 * TILE);
      expect(trees[i + 2]).toBeLessThan(6 * TILE);
    }
  });

  it('grows tall in the valleys, stunted and mixed with larch near the tree line', () => {
    const stats = (ground: number) => {
      const heights: number[] = [];
      let larch = 0;
      for (let t = 0; t < 10; t++) {
        const trees = placeTrees(t, 0, flat(1, ground), params);
        for (let i = 3; i < trees.length; i += STRIDE) {
          const { height, species } = unpack(trees[i]!);
          heights.push(height);
          if (species === LARCH) larch++;
        }
      }
      const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
      return { mean, larch: larch / heights.length };
    };
    const valley = stats(1100);
    const high = stats(2050);
    expect(valley.mean).toBeGreaterThan(20);
    expect(high.mean).toBeLessThan(10);
    expect(valley.larch).toBe(0);
    expect(high.larch).toBeGreaterThan(0.15);
  });
});

describe('typicalHeight', () => {
  it('runs from valley height down to tree-line height', () => {
    expect(typicalHeight(800, params)).toBeCloseTo(26);
    expect(typicalHeight(2200, params)).toBeCloseTo(7);
    expect(typicalHeight(1800, params)).toBeLessThan(typicalHeight(1500, params));
  });
});

describe('hash01', () => {
  it('spreads evenly over [0, 1)', () => {
    const bins = new Array(10).fill(0);
    for (let x = 0; x < 100; x++) {
      for (let y = 0; y < 100; y++) bins[Math.floor(hash01(x, y, 9) * 10)]++;
    }
    for (const b of bins) expect(b).toBeGreaterThan(850);
  });
});
