import { describe, expect, it } from 'vitest';

import { boardDimensions, boardProfile, createBoardGeometry } from './board-model';
import { BOARD_PRESETS, DEFAULT_BOARD_SETUP } from './discipline';

describe('board dimensions', () => {
  it('follow the setup: longer/wider boards are bigger, with a directional nose', () => {
    const d = boardDimensions(DEFAULT_BOARD_SETUP);
    expect(d.length).toBeCloseTo(DEFAULT_BOARD_SETUP.length / 100, 5);
    expect(d.waistWidth).toBeCloseTo(DEFAULT_BOARD_SETUP.waist / 1000, 5);
    // Sidecut flares the ends out past the waist; the nose is a touch wider than the tail.
    expect(d.noseWidth).toBeGreaterThan(d.waistWidth);
    expect(d.tailWidth).toBeGreaterThan(d.waistWidth);
    expect(d.noseWidth).toBeGreaterThan(d.tailWidth);

    const longer = boardDimensions({ ...DEFAULT_BOARD_SETUP, length: 165 });
    expect(longer.length).toBeGreaterThan(d.length);
  });
});

describe('board profile', () => {
  const d = boardDimensions(DEFAULT_BOARD_SETUP);

  it('is narrowest at the waist and lifts the nose and tail', () => {
    const waist = boardProfile(0.47, d).halfWidth;
    const nose = boardProfile(0.78, d).halfWidth;
    const tail = boardProfile(0.2, d).halfWidth;
    expect(waist).toBeLessThan(nose);
    expect(waist).toBeLessThan(tail);
    // Flat through the contact length, rising at the very ends.
    expect(boardProfile(0.5, d).rise).toBeCloseTo(0, 3);
    expect(boardProfile(0.99, d).rise).toBeGreaterThan(0.02);
    expect(boardProfile(0.01, d).rise).toBeGreaterThan(0.01);
  });
});

describe('board geometry', () => {
  it('builds a vertex-coloured mesh for every preset', () => {
    for (const id of Object.keys(BOARD_PRESETS) as (keyof typeof BOARD_PRESETS)[]) {
      const g = createBoardGeometry(boardDimensions(BOARD_PRESETS[id].setup), 0);
      const pos = g.getAttribute('position');
      const col = g.getAttribute('color');
      expect(pos.count).toBeGreaterThan(0);
      expect(col.count).toBe(pos.count);
      expect(g.getIndex()).not.toBeNull();
    }
  });
});
