import { describe, expect, it } from 'vitest';

import { frameStarts, pinAt, ScreenStack, startsAspect } from './screens';

describe('screen stack', () => {
  it('goes forward and back one screen at a time', () => {
    const s = new ScreenStack('title');
    s.push('resorts');
    s.push('resort');
    expect(s.current).toBe('resort');
    expect(s.previous).toBe('resorts');
    expect(s.back()).toBe(true);
    expect(s.current).toBe('resorts');
    expect(s.back()).toBe(true);
    expect(s.back()).toBe(false); // nowhere further back than the title
    expect(s.current).toBe('title');
  });

  it('going forward to a screen already in the stack returns to it (no loops)', () => {
    const s = new ScreenStack('pause');
    s.push('resorts');
    s.push('resort');
    s.push('resorts');
    expect(s.current).toBe('resorts');
    expect(s.previous).toBe('pause');
  });

  it('reset starts over', () => {
    const s = new ScreenStack('title');
    s.push('resorts');
    s.reset('pause');
    expect(s.current).toBe('pause');
    expect(s.previous).toBeNull();
  });
});

describe('start point map', () => {
  const extent = { west: -8000, east: 8000, south: -15000, north: 15000 };

  it('frames the points with a margin, at least the minimum span', () => {
    const points = [
      { east: -1000, north: -3000 },
      { east: 1000, north: 3000 },
    ];
    const view = frameStarts(extent, points, 1.5);
    for (const p of points) {
      const { x, y } = pinAt(extent, view, p);
      expect(x).toBeGreaterThan(0.05);
      expect(x).toBeLessThan(0.95);
      expect(y).toBeGreaterThan(0.05);
      expect(y).toBeLessThan(0.95);
    }
    // 6 km of north–south points (+18% margin each side) in a 3:2 box: ~12.2 km across.
    expect(16_000 / view.width).toBeCloseTo(6000 * 1.36 * 1.5);
  });

  it('a single point sits in the middle, the view no smaller than the minimum span', () => {
    const view = frameStarts(extent, [{ east: 0, north: 0 }], 1);
    const pin = pinAt(extent, view, { east: 0, north: 0 });
    expect(pin.x).toBeCloseTo(0.5);
    expect(pin.y).toBeCloseTo(0.5);
    expect(view.width).toBeCloseTo(16_000 / 6000);
  });

  it('keeps the view inside the image near its edge', () => {
    const view = frameStarts(extent, [{ east: 7900, north: 14900 }], 1);
    // The view's right edge is the image's right edge, so the point is near the box's edge.
    expect(view.left + view.width).toBeCloseTo(1);
    expect(view.top).toBeCloseTo(0);
  });
});

describe('start map shape', () => {
  const extent = { west: -8000, east: 8000, south: -15000, north: 15000 };
  it('follows the spread of the starts, within portrait and landscape limits', () => {
    expect(
      startsAspect(extent, [
        { east: 0, north: -12000 },
        { east: 4000, north: 12000 },
      ]),
    ).toBe(0.6);
    expect(
      startsAspect(extent, [
        { east: -7000, north: 0 },
        { east: 7000, north: 1000 },
      ]),
    ).toBe(1.8);
    expect(startsAspect(extent, [{ east: 0, north: 0 }])).toBe(1); // one start: square
  });
});
