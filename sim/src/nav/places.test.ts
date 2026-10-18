import { describe, expect, it } from 'vitest';

import type { Lift, Peak } from '../features/types';
import { bearing, buildPlaces, liftViewpoint, peakViewpoint } from './places';

describe('bearing', () => {
  it('is clockwise from north', () => {
    expect(bearing(0, 0, 0, 10)).toBeCloseTo(0);
    expect(bearing(0, 0, 10, 0)).toBeCloseTo(90);
    expect(bearing(0, 0, 0, -10)).toBeCloseTo(180);
    expect(bearing(0, 0, -10, 0)).toBeCloseTo(270);
  });
});

const peak: Peak = { id: 1, name: 'Cime de Caron', ele: 3195, east: 0, north: -4000, ground: 3192 };

describe('peakViewpoint', () => {
  it('sits between the resort centre and the summit, above it, facing it', () => {
    const pose = peakViewpoint(peak, { east: 0, north: 0 });
    expect(pose.east).toBeCloseTo(0);
    expect(pose.north).toBeCloseTo(-3550);
    expect(pose.altitude).toBeCloseTo(3272);
    expect(pose.heading).toBeCloseTo(180);
  });
});

describe('liftViewpoint', () => {
  it('stands behind the bottom station looking up the line', () => {
    const s = (east: number, north: number, ground: number) => ({
      east,
      north,
      ground,
      top: ground + 5,
      kind: 'station' as const,
    });
    const lift = { supports: [s(0, 0, 2300), s(1000, 0, 2700)] } as Lift;
    const pose = liftViewpoint(lift);
    expect(pose.heading).toBeCloseTo(90);
    expect(pose.east).toBeCloseTo(-60);
    expect(pose.altitude).toBe(2340);
  });
});

describe('buildPlaces', () => {
  it('lists the start, named lifts and peaks inside the resort area', () => {
    const spawn = { east: 0, north: 0, altitude: 2700, heading: 200, pitch: -8 };
    const lift = {
      name: 'Moraine',
      type: 'gondola',
      length: 2439,
      supports: [
        { east: 0, north: 0, ground: 2300, top: 2306, kind: 'station' },
        { east: 0, north: 2000, ground: 2700, top: 2706, kind: 'station' },
      ],
    } as Lift;
    const extent = { west: -5000, east: 5000, south: -5000, north: 5000 };
    const places = buildPlaces(
      'Val Thorens',
      spawn,
      [lift, { ...lift, name: null }],
      [peak, { ...peak, name: 'Mont Blanc', east: 20000, north: 60000 }],
      extent,
    );
    expect(places.map((p) => `${p.kind}:${p.name}`)).toEqual([
      'start:Val Thorens',
      'lift:Moraine',
      'peak:Cime de Caron',
    ]);
    expect(places[1]!.detail).toBe('Gondola · 2,439 m');
  });
});

describe('groundedPose', () => {
  it('stands you on the ground and aims at the target', async () => {
    const { groundedPose } = await import('./places');
    const ground = () => 2500;
    const pose = groundedPose(
      { east: 0, north: 0, altitude: 9999, heading: 0, pitch: -30 },
      ground,
      1.8,
      { east: 0, north: 450, altitude: 2800 },
    );
    expect(pose.altitude).toBeCloseTo(2501.8);
    expect(pose.heading).toBeCloseTo(0);
    expect(pose.pitch).toBeCloseTo((Math.atan2(298.2, 450) * 180) / Math.PI);
    const plain = groundedPose(
      { east: 5, north: 5, altitude: 3000, heading: 90, pitch: -40 },
      ground,
      1.8,
    );
    expect(plain.altitude).toBeCloseTo(2501.8);
    expect(plain.pitch).toBe(-10);
  });
});
