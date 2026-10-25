import type { Page } from '@playwright/test';

// Open-Meteo, mocked for the weather tests and views: page.route answers each request
// with a day of made-up hours, so nothing touches the network.

export type Hourly = {
  temperature: number;
  humidity: number;
  precipitation?: number;
  cloud: number;
  low: number;
  mid?: number;
  high?: number;
  wind: number;
  gusts: number;
  from?: number;
};

export const SCENES: Record<string, Hourly> = {
  clear: { temperature: -8, humidity: 35, cloud: 0, low: 0, wind: 6, gusts: 15 },
  overcast: {
    temperature: -4,
    humidity: 80,
    cloud: 100,
    low: 40,
    mid: 100,
    high: 100,
    wind: 12,
    gusts: 30,
  },
  whiteout: {
    temperature: -5,
    humidity: 99,
    precipitation: 0.2,
    cloud: 100,
    low: 100,
    mid: 100,
    wind: 10,
    gusts: 25,
  },
  'heavy-snow': {
    temperature: -6,
    humidity: 92,
    precipitation: 4,
    cloud: 100,
    low: 90,
    mid: 100,
    wind: 8,
    gusts: 20,
    from: 300,
  },
  blizzard: {
    temperature: -12,
    humidity: 92,
    precipitation: 3,
    cloud: 100,
    low: 85,
    mid: 100,
    wind: 45,
    gusts: 110,
    from: 300,
  },
  rain: {
    temperature: 5,
    humidity: 92,
    precipitation: 3,
    cloud: 100,
    low: 80,
    mid: 100,
    wind: 15,
    gusts: 35,
  },
};

/** A place asked about: its lat/lon and (for the points, not pressure levels) height. */
export type Place = { lat: number; lon: number; elevation: number };

/** Pressure-level cloud over a place: [hPa, height (m), cloud %]. */
export type Levels = (p: Place) => [number, number, number][];

/**
 * Open-Meteo's answer for every location asked, with the same values every hour: `h` for
 * all of them, or by place. Pressure-level requests get `levels` (or nulls: a model
 * without them).
 */
export function answer(url: URL, h: Hourly | ((p: Place) => Hourly), levels?: Levels): unknown {
  const start = Date.parse(`${url.searchParams.get('start_date')}T00:00:00Z`);
  const end = Date.parse(`${url.searchParams.get('end_date')}T00:00:00Z`) + 86_400_000;
  const time: string[] = [];
  for (let t = start; t < end; t += 3_600_000) time.push(new Date(t).toISOString().slice(0, 16));
  const n = time.length;
  const fill = (v: number | null) => Array<number | null>(n).fill(v);
  const list = (k: string) =>
    (url.searchParams.get(k) ?? '').split(',').filter(Boolean).map(Number);
  const lats = list('latitude');
  const lons = list('longitude');
  const elevations = list('elevation');
  const places = lats.map((lat, i) => ({ lat, lon: lons[i]!, elevation: elevations[i] ?? NaN }));
  const vars = url.searchParams.get('hourly')!.split(',');
  if (vars.some((v) => v.endsWith('hPa'))) {
    return places.map((p) => {
      const hourly: Record<string, unknown> = { time };
      const given = levels?.(p) ?? [];
      for (const v of vars) {
        const [, kind, pressure] = /^(cloud_cover|geopotential_height)_(\d+)hPa$/.exec(v) ?? [];
        const level = given.find(([hpa]) => hpa === Number(pressure));
        hourly[v] = fill(level ? (kind === 'cloud_cover' ? level[2] : level[1]) : null);
      }
      return { elevation: 0, hourly };
    });
  }
  return places.map((p) => {
    const at = typeof h === 'function' ? h(p) : h;
    const precipitation = at.precipitation ?? 0;
    return {
      elevation: p.elevation,
      hourly: {
        time,
        temperature_2m: fill(at.temperature),
        relative_humidity_2m: fill(at.humidity),
        precipitation: fill(precipitation),
        snowfall: fill(at.temperature < 1 ? precipitation * 0.7 : 0),
        cloud_cover_low: fill(at.low),
        cloud_cover_mid: fill(at.mid ?? 0),
        cloud_cover_high: fill(at.high ?? 0),
        wind_speed_10m: fill(at.wind),
        wind_direction_10m: fill(at.from ?? 270),
        wind_gusts_10m: fill(at.gusts),
        visibility: fill(null),
      },
    };
  });
}

type Location = { latitude: number; longitude: number; elevation: number; hourly: unknown };

/**
 * A recorded Open-Meteo answer (e2e/fixtures) replayed for whatever places are asked: each
 * gets the recorded location nearest to it (by position, then height).
 */
export function replay(url: URL, recorded: Location[]): unknown {
  const list = (k: string) =>
    (url.searchParams.get(k) ?? '').split(',').filter(Boolean).map(Number);
  const lats = list('latitude');
  const lons = list('longitude');
  const elevations = list('elevation');
  return lats.map((lat, i) => {
    const d = (r: Location) =>
      (r.latitude - lat) ** 2 +
      ((r.longitude - lons[i]!) * 0.7) ** 2 +
      (elevations.length ? ((r.elevation - elevations[i]!) / 50_000) ** 2 : 0);
    return recorded.reduce((a, b) => (d(b) < d(a) ? b : a));
  });
}

/** Weather on for les-3-vallees at `date` 11:00 (clock paused), answered by `respond`. */
export async function withWeather(
  page: Page,
  date: string,
  respond: (url: URL) => unknown,
  requests: string[] = [],
  seconds = 11 * 3600,
) {
  await page.route('**/*open-meteo.com/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.toString());
    await route.fulfill({ json: respond(url) });
  });
  await page.addInitScript(
    ([date, seconds]) => {
      localStorage.setItem(
        'ski-sim.weather',
        JSON.stringify({ 'les-3-vallees': { mode: 'past', date } }),
      );
      localStorage.setItem('ski-sim.time-of-day', JSON.stringify({ seconds, rate: 0 }));
      // The scene alone: no HUD, labels or piste colours.
      localStorage.setItem('ski-sim.labels', JSON.stringify({ hud: false }));
    },
    [date, seconds] as const,
  );
}
