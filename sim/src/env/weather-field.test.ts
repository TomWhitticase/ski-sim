import { describe, expect, it } from 'vitest';

import type { PressureProfile, WeatherDay, WeatherSite } from './weather';
import {
  columnHeights,
  conditionsAt,
  fieldConditions,
  layerAt,
  MAX_GRID,
  planWeatherSites,
  sampleField,
} from './weather-field';

const HOUR = 3_600_000;
const T0 = Date.parse('2024-01-10T00:00:00Z');
const NOON = T0 + 12 * HOUR;

type Values = Partial<{
  temperature: number;
  humidity: number;
  precipitation: number;
  low: number;
  mid: number;
  high: number;
  wind: number;
  gusts: number;
}>;

function site(east: number, north: number, elevation: number, v: Values): WeatherSite {
  const fill = (x: number) => [x, x, x];
  return {
    east,
    north,
    elevation,
    time: [T0, T0 + 12 * HOUR, T0 + 24 * HOUR],
    temperature: fill(v.temperature ?? -5 - 0.0065 * (elevation - 2000)),
    humidity: fill(v.humidity ?? 50),
    precipitation: fill(v.precipitation ?? 0),
    snowfall: fill(0.7 * (v.precipitation ?? 0)),
    cloudLow: fill(v.low ?? 0),
    cloudMid: fill(v.mid ?? 0),
    cloudHigh: fill(v.high ?? 0),
    wind: fill(v.wind ?? 10),
    windDirection: fill(270),
    gusts: fill(v.gusts ?? 20),
    visibility: fill(NaN),
  };
}

/**
 * A 3 × 3 grid 4 km apart (west -4000 … east 4000), ground heights by row from the south,
 * plus a column at the centre; `weather(east, north, elevation)` gives each point's values.
 */
function field(
  ground: number[][],
  weather: (east: number, north: number, elevation: number) => Values,
  column: number[] = [1500, 2500, 3200, 3600, 4200],
  profiles: PressureProfile[] = [],
): WeatherDay {
  const sites: WeatherSite[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const e = -4000 + 4000 * i;
      const n = -4000 + 4000 * j;
      const z = ground[j]![i]!;
      sites.push(site(e, n, z, weather(e, n, z)));
    }
  }
  for (const z of column) sites.push(site(0, 0, z, weather(0, 0, z)));
  return {
    date: '2024-01-10',
    source: 'historical',
    model: 'meteofrance_seamless',
    grid: { nx: 3, ny: 3, west: -4000, south: -4000, east: 4000, north: 4000 },
    sites,
    profiles,
  };
}

describe('planWeatherSites', () => {
  const lifts = [
    {
      supports: [
        { east: -9000, north: -3000, ground: 1400 },
        { east: -6000, north: 1000, ground: 2600 },
      ],
    },
    {
      supports: [
        { east: 5000, north: -2000, ground: 1800 },
        { east: 7000, north: 6000, ground: 3200 },
      ],
    },
  ];
  const extent = { west: -10_000, east: 10_000, south: -8000, north: 8000 };
  const plan = planWeatherSites(lifts, extent, (e, n) => 1000 + e / 10 + n / 20);

  it('lays a grid of at most MAX_GRID points over the lifts, inside the terrain', () => {
    const { grid, points } = plan;
    expect(grid.nx * grid.ny).toBeLessThanOrEqual(MAX_GRID);
    expect(grid.nx * grid.ny).toBeGreaterThanOrEqual(20);
    expect(grid.west).toBe(-10_000); // the 1.5 km margin is clipped to the terrain
    expect(grid.east).toBe(8500);
    expect(grid.south).toBe(-4500);
    expect(grid.north).toBe(7500);
    // Row by row from the south-west, each at its ground height.
    expect(points[0]).toEqual({ east: -10_000, north: -4500, elevation: Math.round(-225) + 0 });
    const last = points[grid.nx * grid.ny - 1]!;
    expect(last.east).toBeCloseTo(8500);
    expect(last.north).toBeCloseTo(7500);
    expect(last.elevation).toBe(Math.round(1000 + 850 + 375));
  });

  it('adds a column of heights at the centre, up to 1,000 m over the top lift', () => {
    const column = plan.points.slice(plan.grid.nx * plan.grid.ny);
    expect(column.map((p) => p.elevation)).toEqual(columnHeights(lifts));
    expect(columnHeights(lifts)).toEqual([1400, 2300, 3200, 3600, 4200]);
    expect(new Set(column.map((p) => `${p.east},${p.north}`)).size).toBe(1);
    expect(plan.points.length).toBeLessThanOrEqual(50);
  });

  it('asks for pressure levels over the corners and centre only', () => {
    expect(plan.profiles).toHaveLength(5);
  });

  it('keeps a small area at least 2 × 2', () => {
    const tiny = planWeatherSites(
      [
        {
          supports: [
            { east: 0, north: 0, ground: 1000 },
            { east: 300, north: 0, ground: 1200 },
          ],
        },
      ],
      extent,
      () => 1000,
    );
    expect(tiny.grid.nx).toBeGreaterThanOrEqual(2);
    expect(tiny.grid.ny).toBeGreaterThanOrEqual(2);
  });
});

describe('the field where you are', () => {
  const flat = [
    [2000, 2000, 2000],
    [2000, 2000, 2000],
    [2000, 2000, 2000],
  ];

  it('blends between grid points, and holds the edge beyond them', () => {
    const d = field(flat, (e) => ({ temperature: e < 0 ? -10 : e > 0 ? 0 : -5, humidity: 40 }));
    const f = sampleField(d, NOON);
    expect(fieldConditions(f, -4000, 0, 2000).temperature).toBeCloseTo(-10, 1);
    expect(fieldConditions(f, -2000, 0, 2000).temperature).toBeCloseTo(-7.5, 1);
    expect(fieldConditions(f, 4000, 0, 2000).temperature).toBeCloseTo(0, 1);
    expect(fieldConditions(f, 9000, 0, 2000).temperature).toBeCloseTo(0, 1);
  });

  it('follows the height profile of the neighbourhood, and the lapse rate beyond it', () => {
    const d = field(flat, () => ({ humidity: 40 }));
    const c = conditionsAt(d, NOON, 3000);
    // -5 °C at 2000 m in the made-up data, 6.5 °C per km.
    expect(c.temperature).toBeCloseTo(-11.5, 0);
    expect(conditionsAt(d, NOON, 6000).temperature).toBeCloseTo(-31, 0);
  });

  it('can snow in one valley and shine in the next', () => {
    const d = field(flat, (e) =>
      e < 0
        ? { humidity: 97, low: 100, mid: 100, precipitation: 2 }
        : { humidity: 40, low: 0, mid: 0 },
    );
    const f = sampleField(d, NOON);
    const west = fieldConditions(f, -4000, 0, 2000);
    const east = fieldConditions(f, 4000, 0, 2000);
    expect(west.precipitation).toBe('snow');
    expect(west.overcast).toBeGreaterThan(0.9);
    expect(east.precipitation).toBe('none');
    expect(east.overcast).toBeLessThan(0.1);
  });
});

describe('cloud decks', () => {
  // A valley in the middle row (1200 m) between ridges (2800 m).
  const valley = [
    [2800, 2800, 2800],
    [1200, 1200, 1200],
    [2800, 2800, 2800],
  ];
  // Saturated up to 1900 m: a sea of cloud in the valley, sunshine on the ridges.
  const sea = (_e: number, _n: number, z: number): Values =>
    z < 1900 ? { humidity: 100, low: 100 } : { humidity: 45, low: 0 };

  it('fills a valley with a sea of cloud whose top is between the points that say so', () => {
    const f = sampleField(field(valley, sea), NOON);
    const deck = layerAt(f, 0, 0)!;
    expect(deck.cover).toBeGreaterThan(0.8);
    expect(deck.top).toBeGreaterThan(1500);
    expect(deck.top).toBeLessThan(2500);
    // In it on the valley floor, above it on the ridge.
    const floor = fieldConditions(f, 0, 0, 1250);
    expect(floor.inCloud).toBeGreaterThan(0.9);
    expect(floor.visibility).toBeLessThan(100);
    const ridge = fieldConditions(f, 0, 4000, 2850);
    expect(ridge.inCloud).toBe(0);
    expect(ridge.overcast).toBeLessThan(0.1);
    expect(ridge.visibility).toBeGreaterThan(20_000);
    // Flying high over the valley: the cloud is below, the sun out.
    const over = fieldConditions(f, 0, 0, 3200);
    expect(over.inCloud).toBe(0);
    expect(over.overcast).toBeLessThan(0.1);
    expect(over.cloudLow).toBe(0);
  });

  it('a ridge point above the sea takes its cover from the valley', () => {
    const f = sampleField(field(valley, sea), NOON);
    // The ridge points' own low cloud is 0, but the deck over them (below their ground)
    // carries the valley's cover, so the sea reaches the slopes under them.
    expect(f.layers[7]!.cover).toBeGreaterThan(0.5);
    expect(f.layers[7]!.top).toBeLessThan(2800);
  });

  it('puts a ceiling over you, hiding what is above its base', () => {
    const d = field(valley, (_e, _n, z) =>
      z > 2600 && z < 3400 ? { humidity: 100, low: 100 } : { humidity: 70, low: 80 },
    );
    const f = sampleField(d, NOON);
    const deck = layerAt(f, 0, 0)!;
    expect(deck.base).toBeGreaterThan(2200);
    expect(deck.base).toBeLessThan(2900);
    const under = fieldConditions(f, 0, 0, 1300);
    expect(under.inCloud).toBe(0);
    expect(under.overcast).toBeGreaterThan(0.75);
    expect(fieldConditions(f, 0, 4000, 2900).inCloud).toBeGreaterThan(0.8);
    const above = fieldConditions(f, 0, 0, 4400);
    expect(above.inCloud).toBe(0);
    expect(above.overcast).toBeLessThan(0.2);
  });

  it('nothing falls above a low deck', () => {
    const d = field(valley, (_e, _n, z) =>
      z < 1900 ? { humidity: 100, low: 100, precipitation: 1 } : { humidity: 45, precipitation: 1 },
    );
    const f = sampleField(d, NOON);
    expect(fieldConditions(f, 0, 0, 1300).precipRate).toBeGreaterThan(0.5);
    expect(fieldConditions(f, 0, 0, 3200).precipRate).toBe(0);
  });

  it('reads a deck from pressure-level cloud when no point is in it', () => {
    const level = (pressure: number, height: number, cloud: number) => ({
      pressure,
      height: [height, height, height],
      cloud: [cloud, cloud, cloud],
    });
    const profile: PressureProfile = {
      east: 0,
      north: 0,
      time: [T0, T0 + 12 * HOUR, T0 + 24 * HOUR],
      levels: [
        level(850, 1500, 0),
        level(800, 2000, 0),
        level(700, 3000, 90),
        level(600, 4200, 90),
        level(500, 5600, 0),
      ],
    };
    const d = field(valley, () => ({ humidity: 60, low: 0, mid: 80 }), [1500], [profile]);
    const deck = layerAt(sampleField(d, NOON), 0, 0)!;
    expect(deck.base).toBeGreaterThan(2400);
    expect(deck.base).toBeLessThan(3000);
    expect(deck.top).toBeGreaterThan(4200);
    expect(deck.top).toBeLessThan(5600);
  });

  it('with only a cover figure, bases the deck over every point (none of them is in it)', () => {
    const d = field(valley, () => ({ humidity: 70, low: 60 }));
    const f = sampleField(d, NOON);
    const deck = layerAt(f, 0, 0)!;
    expect(deck.base).toBeGreaterThan(4200);
    expect(fieldConditions(f, 0, 4000, 2850).inCloud).toBe(0);
    expect(fieldConditions(f, 0, 0, 1250).cloudLow).toBeCloseTo(0.6);
  });

  it('has no deck on a clear day', () => {
    const f = sampleField(
      field(valley, () => ({ humidity: 35 })),
      NOON,
    );
    expect(f.hasLayer).toBe(false);
    expect(layerAt(f, 0, 0)).toBeNull();
    expect(Number.isNaN(fieldConditions(f, 0, 0, 2000).cloudBase)).toBe(true);
  });

  it('works out a resort-sized field quickly', () => {
    const sites: WeatherSite[] = [];
    for (let k = 0; k < 50; k++) {
      const z = 800 + ((k * 397) % 2600);
      sites.push(site((k % 5) * 4000, Math.floor(k / 5) * 4000, z, sea(0, 0, z)));
    }
    const d: WeatherDay = {
      date: '2024-01-10',
      source: 'historical',
      model: 'best_match',
      grid: { nx: 5, ny: 9, west: 0, south: 0, east: 16_000, north: 32_000 },
      sites,
      profiles: [],
    };
    const start = performance.now();
    sampleField(d, NOON);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
