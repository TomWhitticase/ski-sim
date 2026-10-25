import { describe, expect, it } from 'vitest';

import { MIN_RUNWAY, parkingSpots, pavedAt } from './aircraft-parking';
import type { Airfields, Helipad, Runway } from './types';

const runway = (over: Partial<Runway>): Runway => ({
  id: 1,
  ref: '22/04',
  designators: ['22', '04'],
  line: [
    [0, 0],
    [-373, -386],
  ],
  length: 537,
  width: 40,
  heading: 224,
  surface: 'asphalt',
  winter: 'cleared',
  ends: [1942, 2008],
  source: 'osm',
  ...over,
});

const pad = (east: number, north: number, over: Partial<Helipad> = {}): Helipad => ({
  id: east,
  name: null,
  east,
  north,
  ring: null,
  shape: 'circle',
  size: 7,
  heading: 150,
  surface: 'asphalt',
  winter: 'cleared',
  roof: false,
  building: null,
  top: 1992.5,
  ...over,
});

const airfields = (over: Partial<Airfields>): Airfields => ({
  aerodromes: [
    {
      id: 1,
      name: 'Altiport de Courchevel',
      kind: 'airfield',
      icao: 'LFLJ',
      iata: null,
      east: -180,
      north: -190,
      ground: 1975,
      ele: 2008,
    },
  ],
  runways: [],
  taxiways: [],
  aprons: [],
  helipads: [],
  windsocks: [],
  snowbanks: [],
  markers: [],
  ...over,
});

describe('parking spots', () => {
  it('puts a Porter at the top of a runway, lined up to take off downhill', () => {
    const spots = parkingSpots(airfields({ runways: [runway({})] }), () => 2000);
    expect(spots).toHaveLength(1);
    const s = spots[0]!;
    expect(s.type).toBe('pc6');
    expect(s.name).toBe('Altiport de Courchevel');
    // 18 m in from the high (04) end, facing down toward the 22 end (bearing ~44°).
    expect(Math.hypot(s.east + 373, s.north + 386)).toBeCloseTo(18, 0);
    expect(s.heading).toBeCloseTo(44, 0);
  });

  it('skips strips too short for it', () => {
    const short = runway({ length: MIN_RUNWAY - 10 });
    expect(parkingSpots(airfields({ runways: [short] }), () => 0)).toEqual([]);
  });

  it('puts helicopters on pads, a few along a row rather than one on each', () => {
    const row = Array.from({ length: 10 }, (_, i) => pad(i * 12, -i * 22));
    const spots = parkingSpots(airfields({ helipads: row }), () => 0);
    expect(spots.length).toBeGreaterThan(2);
    expect(spots.length).toBeLessThan(6);
    for (const s of spots) {
      expect(s.type).toBe('h125');
      expect(s.ground).toBe(1992.5);
      for (const t of spots) {
        if (t !== s) expect(Math.hypot(s.east - t.east, s.north - t.north)).toBeGreaterThan(34);
      }
    }
  });
});

describe('paved surfaces', () => {
  it('is tarmac on a cleared runway and its taxiway, snow beside them and on a groomed strip', () => {
    const paved = pavedAt(
      airfields({
        runways: [
          runway({}),
          runway({
            line: [
              [500, 0],
              [500, 300],
            ],
            winter: 'groomed',
          }),
        ],
        taxiways: [
          {
            id: 2,
            line: [
              [-100, -50],
              [-150, -50],
            ],
            width: 10,
            surface: 'asphalt',
            winter: 'cleared',
          },
        ],
      }),
    );
    expect(paved(-180, -190)).toBe(true); // mid-runway
    expect(paved(-180 + 30, -190 - 30)).toBe(false); // 40 m off to the side
    expect(paved(-130, -52)).toBe(true); // on the taxiway
    expect(paved(500, 150)).toBe(false); // the groomed snow runway: skis
  });
});
