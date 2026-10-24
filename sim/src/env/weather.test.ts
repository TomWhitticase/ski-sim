import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CLEAR,
  compass,
  conditionsAt,
  describe as describeConditions,
  describeSky,
  formatVisibility,
  gustyWind,
  parseOpenMeteo,
  snowFraction,
  snowVisibility,
  type WeatherDay,
} from './weather';

const HOUR = 3_600_000;
const T0 = Date.parse('2023-01-15T00:00:00Z');

type Hour = Partial<{
  temperature: number;
  humidity: number;
  precipitation: number;
  cloud: number;
  low: number;
  mid: number;
  high: number;
  wind: number;
  from: number;
  gusts: number;
  snowfall: number;
  visibility: number;
}>;

/** A day with the same values every hour at each height (`at` lists [elevation, hour]). */
function day(levels: [number, Hour][], hours = 48, vary?: (i: number) => Hour): WeatherDay {
  return {
    date: '2023-01-15',
    source: 'archive',
    levels: levels.map(([elevation, h]) => {
      const pick = (k: keyof Hour, d: number) =>
        Array.from({ length: hours }, (_, i) => vary?.(i)[k] ?? h[k] ?? d);
      return {
        elevation,
        time: Array.from({ length: hours }, (_, i) => T0 + i * HOUR),
        temperature: pick('temperature', -5),
        humidity: pick('humidity', 50),
        dewPoint: pick('temperature', -5).map((t) => t - 5),
        precipitation: pick('precipitation', 0),
        snowfall: pick('snowfall', 0),
        snowDepth: pick('temperature', 1).map(() => 1),
        code: pick('temperature', 0).map(() => 0),
        cloud: pick('cloud', 0),
        cloudLow: pick('low', 0),
        cloudMid: pick('mid', 0),
        cloudHigh: pick('high', 0),
        wind: pick('wind', 5),
        windDirection: pick('from', 270),
        gusts: pick('gusts', 10),
        visibility: pick('visibility', NaN),
      };
    }),
  };
}

describe('parseOpenMeteo', () => {
  it('reads a real multi-height answer (Storm Eleanor, 4 January 2018)', () => {
    const json = JSON.parse(
      readFileSync(
        new URL('../../e2e/fixtures/open-meteo-2018-01-04.json', import.meta.url),
        'utf8',
      ),
    );
    const d = parseOpenMeteo(json, '2018-01-04', 'archive', [1434, 2327, 3219]);
    expect(d.levels.map((l) => l.elevation)).toEqual([1434, 2327, 3219]);
    expect(d.levels[0]!.time[0]).toBe(Date.parse('2018-01-03T00:00:00Z'));
    expect(d.levels[0]!.time).toHaveLength(72);
    // The archive has no visibility: NaN, not 0.
    expect(d.levels[0]!.visibility.every(Number.isNaN)).toBe(true);
    // At 10:00 local (09:00 UTC) on the day, high on the mountain: a storm.
    const c = conditionsAt(d, Date.parse('2018-01-04T09:00:00Z'), 2400);
    expect(c.precipitation).toBe('snow');
    expect(c.snowRate).toBeGreaterThan(1.5);
    expect(c.visibility).toBeLessThan(200);
    expect(c.whiteout).toBeGreaterThan(0.9);
    // The damped ERA5 mean is lifted toward its 130 km/h gusts.
    expect(c.wind * 3.6).toBeGreaterThan(25);
  });

  it('throws on an answer without weather', () => {
    expect(() => parseOpenMeteo({ error: true }, '2023-01-15', 'archive', [2000])).toThrow();
    expect(() =>
      parseOpenMeteo(
        { hourly: { time: ['2023-01-15T00:00'], temperature_2m: [null] } },
        '2023-01-15',
        'archive',
        [2000],
      ),
    ).toThrow('No weather for that date');
  });
});

describe('conditionsAt', () => {
  it('interpolates between hours', () => {
    const d = day([[2000, {}]], 48, (i) => ({ temperature: i < 10 ? -10 : 0 }));
    expect(conditionsAt(d, T0 + 9 * HOUR, 2000).temperature).toBeCloseTo(-10);
    expect(conditionsAt(d, T0 + 9.5 * HOUR, 2000).temperature).toBeCloseTo(-5);
    expect(conditionsAt(d, T0 + 10 * HOUR, 2000).temperature).toBeCloseTo(0);
  });

  it('blends heights, and follows the lapse rate beyond the top and bottom', () => {
    const d = day([
      [1500, { temperature: 0 }],
      [2500, { temperature: -10 }],
    ]);
    const at = T0 + 12 * HOUR;
    expect(conditionsAt(d, at, 2000).temperature).toBeCloseTo(-5);
    expect(conditionsAt(d, at, 3500).temperature).toBeCloseTo(-16.5);
    expect(conditionsAt(d, at, 1000).temperature).toBeCloseTo(3.25);
  });

  it('turns the wind through north, not south', () => {
    const d = day([[2000, {}]], 48, (i) => ({ from: i < 10 ? 350 : 10, wind: 20, gusts: 20 }));
    const c = conditionsAt(d, T0 + 9.5 * HOUR, 2000);
    expect(Math.min(c.windFrom, 360 - c.windFrom)).toBeLessThan(1);
  });

  it('is clear on a dry, cloudless day', () => {
    const c = conditionsAt(day([[2000, { humidity: 40 }]]), T0 + 12 * HOUR, 2000);
    expect(c.precipitation).toBe('none');
    expect(c.overcast).toBe(0);
    expect(c.whiteout).toBe(0);
    expect(c.visibility).toBeGreaterThan(50_000);
    expect(describeSky(c)).toBe('Clear');
  });

  it('snows high and rains low across the freezing level', () => {
    const d = day([
      [1200, { temperature: 4, precipitation: 3, humidity: 95, cloud: 100, low: 90 }],
      [2400, { temperature: -4, precipitation: 3, humidity: 95, cloud: 100, low: 90 }],
    ]);
    const at = T0 + 12 * HOUR;
    const low = conditionsAt(d, at, 1200);
    const high = conditionsAt(d, at, 2400);
    expect(low.precipitation).toBe('rain');
    expect(low.snowRate).toBe(0);
    expect(high.precipitation).toBe('snow');
    expect(high.snowRate).toBeCloseTo(2.1);
    expect(['Heavy snow', 'Snow']).toContain(describeSky(high));
    expect(conditionsAt(d, at, 1575).precipitation).toBe('sleet'); // +1.5 °C
  });

  it('puts you in cloud when saturated under low cloud, and makes it a whiteout', () => {
    const c = conditionsAt(
      day([[2000, { humidity: 100, cloud: 100, low: 100 }]]),
      T0 + 12 * HOUR,
      2000,
    );
    expect(c.inCloud).toBeCloseTo(1);
    expect(c.visibility).toBeLessThan(80);
    expect(c.whiteout).toBeGreaterThan(0.95);
    expect(describeSky(c)).toBe('Whiteout');
  });

  it('valley fog stays in the valley', () => {
    const d = day([
      [1000, { humidity: 100, cloud: 60, low: 90 }],
      [2500, { humidity: 45, cloud: 60, low: 90 }],
    ]);
    const at = T0 + 12 * HOUR;
    expect(conditionsAt(d, at, 1000).visibility).toBeLessThan(100);
    expect(conditionsAt(d, at, 2500).visibility).toBeGreaterThan(20_000);
  });

  it('blows a blizzard in strong wind with snow', () => {
    const c = conditionsAt(
      day([
        [
          2000,
          {
            temperature: -12,
            humidity: 95,
            precipitation: 3,
            cloud: 100,
            low: 85,
            wind: 45,
            gusts: 110,
          },
        ],
      ]),
      T0 + 12 * HOUR,
      2000,
    );
    expect(describeSky(c)).toBe('Blizzard');
    expect(c.drift).toBeGreaterThan(0.5);
    expect(c.wind).toBeCloseTo(110 / 3.6 / 2);
    expect(c.gusts).toBeCloseTo(110 / 3.6);
  });

  it('counts the snow of the 24 hours before', () => {
    const d = day([[2000, {}]], 48, (i) => ({ snowfall: i < 20 ? 1 : 0 }));
    expect(conditionsAt(d, T0 + 30 * HOUR, 2000).freshSnow).toBeCloseTo(13);
  });

  it('dims the sun with thick cloud, hardly with thin high cloud', () => {
    const at = T0 + 12 * HOUR;
    expect(
      conditionsAt(day([[2000, { cloud: 100, mid: 100 }]]), at, 2000).overcast,
    ).toBeGreaterThan(0.9);
    expect(conditionsAt(day([[2000, { cloud: 40, high: 40 }]]), at, 2000).overcast).toBe(0);
  });
});

describe('words', () => {
  it('describes the conditions like a forecast', () => {
    const c = { ...CLEAR, temperature: -8.4, wind: 12.5, windFrom: 315, visibility: 48 };
    expect(describeConditions({ ...c, precipitation: 'snow', snowRate: 2.5 })).toBe(
      'Heavy snow · −8 °C · wind 45 km/h NW · visibility ~50 m',
    );
    expect(describeConditions(CLEAR)).toBe('Clear · −5 °C · calm · visibility 50+ km');
  });

  it('names directions and rounds visibility', () => {
    expect(compass(0)).toBe('N');
    expect(compass(359)).toBe('N');
    expect(compass(225)).toBe('SW');
    expect(formatVisibility(3400)).toBe('visibility 3 km');
    expect(formatVisibility(640)).toBe('visibility ~600 m');
  });
});

describe('rates', () => {
  it('falls as snow when cold, rain when warm', () => {
    expect(snowFraction(-5)).toBe(1);
    expect(snowFraction(5)).toBe(0);
    expect(snowFraction(1.5)).toBeCloseTo(0.5);
  });

  it('sees less in heavier snow', () => {
    expect(snowVisibility(0)).toBe(Infinity);
    expect(snowVisibility(0.5)).toBeGreaterThan(1500);
    expect(snowVisibility(3)).toBeLessThan(400);
  });

  it('gusts between the mean and the gust speed', () => {
    let lo = Infinity;
    let hi = 0;
    for (let t = 0; t < 600; t += 0.5) {
      const w = gustyWind({ wind: 10, gusts: 20 }, t);
      lo = Math.min(lo, w);
      hi = Math.max(hi, w);
    }
    expect(lo).toBeGreaterThanOrEqual(10);
    expect(hi).toBeLessThanOrEqual(20);
    expect(hi - lo).toBeGreaterThan(5);
  });
});
