import { describe, expect, it } from 'vitest';
import { formatDistance, loadWaypoint, placeOnScreen, saveWaypoint } from './waypoint';

const W = 1600;
const H = 900;
const place = (x: number, y: number, z: number) => placeOnScreen({ x, y, z }, 70, W / H, W, H, 40);

describe('placeOnScreen', () => {
  it('projects a point straight ahead to the centre', () => {
    const p = place(0, 0, -100);
    expect(p.onScreen).toBe(true);
    expect(p.x).toBeCloseTo(W / 2);
    expect(p.y).toBeCloseTo(H / 2);
  });

  it('pins a point far to the right onto the right edge', () => {
    const p = place(1000, 0, -10);
    expect(p.onScreen).toBe(false);
    expect(p.x).toBeCloseTo(W - 40);
    expect(p.y).toBeCloseTo(H / 2);
    expect(p.angle).toBeCloseTo(0);
  });

  it('sends a point behind and to the left to the left edge, never the top', () => {
    const p = place(-50, 0, 100);
    expect(p.onScreen).toBe(false);
    expect(p.x).toBeCloseTo(40);
    const behind = place(0, 0, 100);
    expect(behind.y).toBeCloseTo(H - 40);
    const behindAbove = place(0, 30, 100);
    expect(behindAbove.y).toBeGreaterThan(H / 2);
  });

  it('a point below the view goes to the bottom edge', () => {
    const p = place(0, -500, -10);
    expect(p.onScreen).toBe(false);
    expect(p.y).toBeCloseTo(H - 40);
  });
});

describe('waypoint storage', () => {
  it('round-trips per resort and clears', () => {
    const m = new Map<string, string>();
    const s = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
    saveWaypoint(s, 'a', { east: 10.4, north: -20.6 });
    expect(loadWaypoint(s, 'a')).toEqual({ east: 10, north: -21 });
    expect(loadWaypoint(s, 'b')).toBeNull();
    saveWaypoint(s, 'a', null);
    expect(loadWaypoint(s, 'a')).toBeNull();
    m.set('ski-sim.waypoint.a', '{bad');
    expect(loadWaypoint(s, 'a')).toBeNull();
  });

  it('formats distances', () => {
    expect(formatDistance(847)).toBe('850 m');
    expect(formatDistance(2440)).toBe('2.4 km');
  });
});
