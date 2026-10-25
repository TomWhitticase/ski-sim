import { describe, expect, it } from 'vitest';

import { addDays, localNow, zoneOffsetHours } from './time-of-day';
import type { WeatherDay } from './weather';
import type { WeatherPlan } from './weather-field';
import {
  cacheDay,
  cachedDay,
  isDay,
  loadWeatherDay,
  modelName,
  requestCost,
  type WeatherRequest,
  weatherProvenance,
  weatherSources,
  weatherUrl,
} from './weather-source';

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

const plan: WeatherPlan = {
  grid: { nx: 2, ny: 2, west: -1000, south: -1000, east: 1000, north: 1000 },
  points: [
    { east: -1000, north: -1000, elevation: 1434 },
    { east: 1000, north: -1000, elevation: 1800 },
    { east: -1000, north: 1000, elevation: 2100 },
    { east: 1000, north: 1000, elevation: 2500 },
    { east: 0, north: 0, elevation: 3219 },
  ],
  profiles: [
    { east: -1000, north: -1000 },
    { east: 0, north: 0 },
  ],
};

// Val Thorens' origin; a degree is ~111 km (close enough here).
const latLon = (east: number, north: number) => ({
  lat: 45.3275 + north / 111_000,
  lon: 6.5875 + east / 78_000,
});

const request: WeatherRequest = {
  plan,
  latLon,
  country: 'FR',
  date: '2018-01-04',
  today: '2026-10-24',
};

/** Open-Meteo's answer for every place asked, the given number of hours. */
function answer(url: string, hours = 72, temperature: number | null = -5) {
  const u = new URL(url);
  const time = Array.from({ length: hours }, (_, i) =>
    new Date(Date.parse(`${u.searchParams.get('start_date')}T00:00Z`) + i * 3_600_000)
      .toISOString()
      .slice(0, 16),
  );
  const pressure = u.searchParams.get('hourly')!.includes('hPa');
  return u.searchParams
    .get('latitude')!
    .split(',')
    .map(() => ({
      hourly: pressure
        ? {
            time,
            cloud_cover_850hPa: time.map(() => 20),
            geopotential_height_850hPa: time.map(() => 1500),
            cloud_cover_700hPa: time.map(() => 90),
            geopotential_height_700hPa: time.map(() => 3000),
          }
        : { time, temperature_2m: time.map(() => temperature), visibility: time.map(() => null) },
    }));
}

describe('sources', () => {
  it('asks the ERA5 archive for an old day: every point at its height, in UTC', () => {
    expect(weatherSources(request)).toEqual([['archive', 'era5']]);
    const u = new URL(weatherUrl(request, 'archive', 'era5'));
    expect(u.origin + u.pathname).toBe('https://archive-api.open-meteo.com/v1/archive');
    expect(u.searchParams.get('elevation')).toBe('1434,1800,2100,2500,3219');
    expect(u.searchParams.get('latitude')!.split(',')).toHaveLength(5);
    expect(u.searchParams.get('start_date')).toBe('2018-01-03');
    expect(u.searchParams.get('end_date')).toBe('2018-01-05');
    expect(u.searchParams.get('timezone')).toBe('GMT');
    expect(u.searchParams.get('models')).toBeNull();
    expect(u.searchParams.get('hourly')).toContain('snowfall');
    expect(u.searchParams.get('hourly')).not.toContain('visibility');
    // Ten variables: one call per point.
    expect(u.searchParams.get('hourly')!.split(',')).toHaveLength(10);
  });

  it('asks archived model runs from late 2022: AROME in France, then the best match, then ERA5', () => {
    const r = { ...request, date: '2024-01-10' };
    expect(weatherSources(r)).toEqual([
      ['historical', 'meteofrance_seamless'],
      ['historical', 'best_match'],
      ['archive', 'era5'],
    ]);
    const u = new URL(weatherUrl(r, 'historical', 'meteofrance_seamless'));
    expect(u.origin + u.pathname).toBe(
      'https://historical-forecast-api.open-meteo.com/v1/forecast',
    );
    expect(u.searchParams.get('models')).toBe('meteofrance_seamless');
    expect(u.searchParams.get('hourly')).toContain('visibility');
    // Pressure-level cloud over the profile points only, with no heights.
    const p = new URL(weatherUrl(r, 'historical', 'meteofrance_seamless', true));
    expect(p.searchParams.get('latitude')!.split(',')).toHaveLength(2);
    expect(p.searchParams.get('elevation')).toBeNull();
    expect(p.searchParams.get('hourly')).toContain('cloud_cover_700hPa');
    expect(p.searchParams.get('hourly')).toContain('geopotential_height_700hPa');
  });

  it('picks the model by country and date', () => {
    const pick = (country: string, date: string) =>
      weatherSources({ ...request, country, date })[0]!;
    expect(pick('CH', '2025-12-01')).toEqual(['historical', 'meteoswiss_icon_seamless']);
    expect(pick('CH', '2024-12-01')).toEqual(['historical', 'icon_seamless']);
    expect(pick('AT', '2024-12-01')).toEqual(['historical', 'icon_seamless']);
    expect(pick('US', '2024-12-01')).toEqual(['historical', 'best_match']);
    expect(pick('FR', '2022-06-01')).toEqual(['archive', 'era5']);
    // A country's model, but the resort outside its domain: the best match.
    expect(
      weatherSources({
        ...request,
        country: 'FR',
        date: '2024-01-10',
        latLon: () => ({ lat: -21, lon: 55.5 }),
      })[0],
    ).toEqual(['historical', 'best_match']);
  });

  it('asks the forecast for the last week and today', () => {
    const r = { ...request, date: '2026-10-20' };
    expect(weatherSources(r)[0]).toEqual(['forecast', 'meteofrance_seamless']);
    expect(weatherUrl(r, 'forecast', 'meteofrance_seamless')).toMatch(
      /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/,
    );
    expect(weatherSources({ ...request, date: '2026-10-17' })[0]![0]).toBe('historical');
  });

  it('costs about a call per point', () => {
    expect(requestCost(request, 'archive')).toBe(5);
    expect(requestCost(request, 'historical')).toBeCloseTo(5 * 1.1 + 2 * 1.2);
  });
});

describe('cache', () => {
  const day: WeatherDay = {
    date: '2018-01-04',
    source: 'archive',
    model: 'era5',
    grid: { nx: 1, ny: 1, west: 0, south: 0, east: 0, north: 0 },
    sites: [
      {
        east: 0,
        north: 0,
        elevation: 2000,
        time: [0],
        temperature: [-5],
        humidity: [80],
        precipitation: [0],
        snowfall: [0],
        cloudLow: [0],
        cloudMid: [0],
        cloudHigh: [0],
        wind: [5],
        windDirection: [270],
        gusts: [10],
        visibility: [NaN],
      },
    ],
    profiles: [],
  };

  it('keeps a day per resort, NaN intact', () => {
    const store = memory();
    cacheDay(store, 'les-3-vallees', day, 0);
    const hit = cachedDay(store, 'les-3-vallees', '2018-01-04', 1e12);
    expect(hit?.sites[0]!.temperature).toEqual([-5]);
    expect(Number.isNaN(hit?.sites[0]!.visibility[0])).toBe(true);
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
    for (let i = 0; i < 20; i++)
      cacheDay(store, 'x', { ...day, date: addDays('2018-01-01', i) }, 0);
    expect(cachedDay(store, 'x', '2018-01-01', 0)).toBeNull();
    expect(cachedDay(store, 'x', addDays('2018-01-01', 19), 0)).not.toBeNull();
  });

  it("drops the first iteration's single-column days, which it can't read", () => {
    const store = memory();
    store.setItem(
      'ski-sim.weather-day.x.2018-01-01',
      JSON.stringify({ at: 0, day: { levels: [] } }),
    );
    store.setItem('ski-sim.weather-days', JSON.stringify(['ski-sim.weather-day.x.2018-01-01']));
    expect(cachedDay(store, 'x', '2018-01-01', 0)).toBeNull();
    cacheDay(store, 'x', day, 0);
    expect(store.getItem('ski-sim.weather-day.x.2018-01-01')).toBeNull();
    expect(store.getItem('ski-sim.weather-days')).toBeNull();
    expect(isDay({ date: 'x', levels: [] })).toBe(false);
    expect(isDay(day)).toBe(true);
  });
});

describe('loadWeatherDay', () => {
  it('fetches once, then answers from the cache', async () => {
    const store = memory();
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(answer(url)));
    };
    const a = await loadWeatherDay('les-3-vallees', request, get, store, 0);
    const b = await loadWeatherDay('les-3-vallees', request, get, store, 0);
    expect(urls).toHaveLength(1);
    expect(a.sites).toHaveLength(5);
    expect(a.source).toBe('archive');
    expect(a.profiles).toEqual([]);
    expect(b.sites[4]!.elevation).toBe(3219);
    expect(b.sites[1]!.east).toBe(1000);
  });

  it('a model day comes with pressure-level cloud', async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(answer(url)));
    };
    const d = await loadWeatherDay('x', { ...request, date: '2024-01-10' }, get, memory(), 0);
    expect(urls).toHaveLength(2);
    expect(d.model).toBe('meteofrance_seamless');
    expect(modelName(d)).toContain('AROME');
    expect(d.profiles).toHaveLength(2);
    expect(d.profiles[0]!.levels.map((l) => l.pressure)).toEqual([850, 700]);
  });

  it('falls back to the next source when a model has nothing for the place or day', async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      const model = new URL(url).searchParams.get('models');
      if (model === 'meteofrance_seamless')
        return new Response(JSON.stringify(answer(url, 72, null)));
      if (model === 'best_match')
        return new Response(JSON.stringify({ error: true, reason: 'No data' }), { status: 400 });
      return new Response(JSON.stringify(answer(url)));
    };
    const d = await loadWeatherDay('x', { ...request, date: '2024-01-10' }, get, memory(), 0);
    expect(d.source).toBe('archive');
    expect(d.model).toBe('era5');
    expect(urls).toHaveLength(3);
  });

  it('says why when offline or refused (and tries nothing else)', async () => {
    let calls = 0;
    const offline = () => {
      calls++;
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    await expect(
      loadWeatherDay('x', { ...request, date: '2024-01-10' }, offline, memory()),
    ).rejects.toThrow('offline');
    expect(calls).toBe(1);
    const refused = async () =>
      new Response(JSON.stringify({ error: true, reason: 'Too many requests' }), { status: 429 });
    await expect(loadWeatherDay('x', request, refused, memory())).rejects.toThrow(
      'Open-Meteo: Too many requests',
    );
  });
});

describe('credits', () => {
  it('names the model the day came from', () => {
    expect(weatherProvenance(null).attribution).toContain('Open-Meteo');
    const d = {
      date: '2024-01-10',
      source: 'historical',
      model: 'meteofrance_seamless',
      sites: [1, 2],
      profiles: [1],
    };
    expect(weatherProvenance(d as unknown as WeatherDay).attribution).toContain(
      '2024-01-10: Météo-France AROME (1.5–2.5 km) (2 points, with pressure-level cloud).',
    );
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
