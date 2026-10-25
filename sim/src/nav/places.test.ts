import { describe, expect, it } from 'vitest';

import type { Aerodrome, Lift, Peak, Runway } from '../features/types';
import { aerodromeViewpoint, bearing, buildPlaces, liftViewpoint, peakViewpoint } from './places';

const pose0 = { east: 0, north: 0, altitude: 0, heading: 0, pitch: 0 };
const extent = { west: -1000, east: 1000, south: -1000, north: 1000 };

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

describe('aerodromeViewpoint', () => {
  const courchevel: Aerodrome = {
    id: 1,
    name: 'Altiport de Courchevel',
    kind: 'airfield',
    icao: 'LFLJ',
    iata: 'CVF',
    east: 0,
    north: 0,
    ground: 1980,
    ele: 2006,
  };
  const runway: Runway = {
    id: 2,
    ref: '22/04',
    designators: ['22', '04'],
    // Drawn from the 22 end (the top, north-east) down to the 04 end.
    line: [
      [190, 190],
      [-190, -190],
    ],
    length: 537,
    width: 40,
    heading: 225,
    surface: 'asphalt',
    winter: 'cleared',
    ends: [2006, 1940],
    source: 'osm',
  };
  const fields = {
    aerodromes: [courchevel],
    runways: [runway],
    taxiways: [],
    aprons: [],
    helipads: [],
    windsocks: [],
    snowbanks: [],
    markers: [],
  };

  it('stands on the runway at its lower end, looking up it', () => {
    const pose = aerodromeViewpoint(courchevel, fields);
    expect(pose.east).toBeCloseTo(-190 + 15 / Math.SQRT2);
    expect(pose.north).toBeCloseTo(-190 + 15 / Math.SQRT2);
    expect(pose.heading).toBeCloseTo(45);
  });

  it('is in the teleport list', () => {
    const places = buildPlaces('X', pose0, [], [], extent, [], [], [], fields);
    const place = places.find((p) => p.kind === 'airfield')!;
    expect(place.name).toBe('Altiport de Courchevel');
    expect(place.detail).toBe('Airfield · 2,006 m');
  });
});
