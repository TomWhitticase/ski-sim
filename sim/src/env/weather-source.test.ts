import { describe, expect, it } from 'vitest';

import { addDays, localNow, zoneOffsetHours } from './time-of-day';
import type { WeatherDay } from './weather';
import { cacheDay, cachedDay, loadWeatherDay, weatherHeights, weatherUrl } from './weather-source';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const request = {
  lat: 45.3275,
  lon: 6.5875,
  elevations: [1434, 2327, 3219],
  date: '2018-01-04',
  today: '2026-10-24',
};

/** Open-Meteo's answer for every height asked, the given number of hours. */
function answer(hours = 72) {
  const time = Array.from({ length: hours }, (_, i) =>
    new Date(Date.parse('2018-01-03T00:00Z') + i * 3_600_000).toISOString().slice(0, 16),
  );
  return request.elevations.map((elevation) => ({
    elevation,
    hourly: { time, temperature_2m: time.map(() => -5), visibility: time.map(() => null) },
  }));
}

describe('weatherUrl', () => {
  it('asks the archive for an old day: three heights, the day either side, in UTC', () => {
    const { url, source } = weatherUrl(request);
    const u = new URL(url);
    expect(source).toBe('archive');
    expect(u.origin + u.pathname).toBe('https://archive-api.open-meteo.com/v1/archive');
    expect(u.searchParams.get('elevation')).toBe('1434,2327,3219');
    expect(u.searchParams.get('latitude')).toBe('45.3275,45.3275,45.3275');
    expect(u.searchParams.get('start_date')).toBe('2018-01-03');
    expect(u.searchParams.get('end_date')).toBe('2018-01-05');
    expect(u.searchParams.get('timezone')).toBe('GMT');
    expect(u.searchParams.get('hourly')).toContain('snowfall');
    expect(u.searchParams.get('hourly')).not.toContain('visibility');
  });

  it('asks the forecast API for the last week and today (with visibility)', () => {
    const { url, source } = weatherUrl({ ...request, date: '2026-10-20' });
    expect(source).toBe('forecast');
    expect(url.startsWith('https://api.open-meteo.com/v1/forecast?')).toBe(true);
    expect(new URL(url).searchParams.get('hourly')).toContain('visibility');
    expect(weatherUrl({ ...request, date: '2026-10-17' }).source).toBe('archive');
  });
});

describe('cache', () => {
  const day: WeatherDay = {
    date: '2018-01-04',
    source: 'archive',
    levels: [
      {
        elevation: 2000,
        time: [0],
        temperature: [-5],
        humidity: [80],
        dewPoint: [-8],
        precipitation: [0],
        snowfall: [0],
        snowDepth: [1],
        code: [0],
        cloud: [0],
        cloudLow: [0],
        cloudMid: [0],
        cloudHigh: [0],
        wind: [5],
        windDirection: [270],
        gusts: [10],
        visibility: [NaN],
      },
    ],
  };

  it('keeps a day per resort, NaN intact', () => {
    const store = memory();
    cacheDay(store, 'les-3-vallees', day, 0);
    const hit = cachedDay(store, 'les-3-vallees', '2018-01-04', 1e12);
    expect(hit?.levels[0]!.temperature).toEqual([-5]);
    expect(Number.isNaN(hit?.levels[0]!.visibility[0])).toBe(true);
    expect(cachedDay(store, 'arlberg', '2018-01-04', 0)).toBeNull();
  });

  it('refetches recent days (the forecast keeps changing) after a few hours', () => {
    const store = memory();
    cacheDay(store, 'x', { ...day, source: 'forecast' }, 0);
    expect(cachedDay(store, 'x', '2018-01-04', 3_600_000)).not.toBeNull();
    expect(cachedDay(store, 'x', '2018-01-04', 4 * 3_600_000)).toBeNull();
  });

  it('forgets the oldest days beyond its limit', () => {
    const store = memory();
    for (let i = 0; i < 45; i++)
      cacheDay(store, 'x', { ...day, date: addDays('2018-01-01', i) }, 0);
    expect(cachedDay(store, 'x', '2018-01-01', 0)).toBeNull();
    expect(cachedDay(store, 'x', addDays('2018-01-01', 44), 0)).not.toBeNull();
  });
});

describe('loadWeatherDay', () => {
  it('fetches once, then answers from the cache', async () => {
    const store = memory();
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(answer()));
    };
    const a = await loadWeatherDay('les-3-vallees', request, get, store, 0);
    const b = await loadWeatherDay('les-3-vallees', request, get, store, 0);
    expect(urls).toHaveLength(1);
    expect(a.levels).toHaveLength(3);
    expect(b.levels[2]!.elevation).toBe(3219);
  });

  it('says why when offline or refused', async () => {
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(loadWeatherDay('x', request, offline, memory())).rejects.toThrow('offline');
    const refused = async () =>
      new Response(JSON.stringify({ error: true, reason: 'Too many requests' }), { status: 429 });
    await expect(loadWeatherDay('x', request, refused, memory())).rejects.toThrow(
      'Open-Meteo: Too many requests',
    );
  });
});

describe('weatherHeights', () => {
  it('takes the bottom (10th percentile), middle and top of the lifts', () => {
    const lift = (bottom: number, top: number) => ({
      supports: [{ ground: bottom }, { ground: (bottom + top) / 2 }, { ground: top }],
    });
    const lifts = [
      lift(600, 1400),
      ...Array.from({ length: 19 }, (_, i) => lift(1500 + i * 10, 2000 + i * 50)),
    ];
    expect(weatherHeights(lifts)).toEqual([1500, 2200, 2900]);
    expect(weatherHeights([])).toEqual([1500, 2500]);
  });
});

describe('dates', () => {
  it("gives a zone's offset for the date (summer time too)", () => {
    expect(zoneOffsetHours('Europe/Paris', '2026-02-15')).toBe(1);
    expect(zoneOffsetHours('Europe/Paris', '2026-07-15')).toBe(2);
    expect(zoneOffsetHours('America/Denver', '2026-02-15')).toBe(-7);
    expect(zoneOffsetHours('Asia/Kathmandu', '2026-02-15')).toBe(5.75);
    expect(zoneOffsetHours('UTC', '2026-02-15')).toBe(0);
    expect(zoneOffsetHours('Not/AZone', '2026-02-15')).toBeNull();
  });

  it('reads the local date and time from a UTC instant', () => {
    expect(localNow(Date.parse('2026-10-24T23:30:00Z'), 2)).toEqual({
      date: '2026-10-25',
      seconds: 1.5 * 3600,
    });
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });
});
