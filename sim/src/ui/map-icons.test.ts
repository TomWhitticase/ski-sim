import { describe, expect, it } from 'vitest';

import { minimapBadge } from './map-icons';

describe('minimapBadge', () => {
  it('draws a badge on the map where it is', () => {
    expect(minimapBadge(30, -40, 100, 90, false)).toEqual({ x: 30, y: -40, pinned: false });
  });

  it('leaves out one off the map, unless flying pins it to the rim', () => {
    expect(minimapBadge(3000, 0, 100, 90, false)).toBeNull();
    const pinned = minimapBadge(3000, -4000, 100, 90, true)!;
    expect(pinned.pinned).toBe(true);
    expect(Math.hypot(pinned.x, pinned.y)).toBeCloseTo(90);
    // In its direction: 3 east, 4 north (up the screen).
    expect(pinned.x / pinned.y).toBeCloseTo(-0.75);
  });
});
