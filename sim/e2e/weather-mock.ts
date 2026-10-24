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
    humidity: 96,
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
    humidity: 95,
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
    humidity: 95,
    precipitation: 3,
    cloud: 100,
    low: 80,
    mid: 100,
    wind: 15,
    gusts: 35,
  },
};

/** Open-Meteo's answer for every location asked, with the same values every hour. */
export function answer(url: URL, h: Hourly): unknown {
  const start = Date.parse(`${url.searchParams.get('start_date')}T00:00:00Z`);
  const end = Date.parse(`${url.searchParams.get('end_date')}T00:00:00Z`) + 86_400_000;
  const time: string[] = [];
  for (let t = start; t < end; t += 3_600_000) time.push(new Date(t).toISOString().slice(0, 16));
  const n = time.length;
  const fill = (v: number) => Array<number>(n).fill(v);
  const precipitation = h.precipitation ?? 0;
  return url.searchParams
    .get('elevation')!
    .split(',')
    .map((e) => ({
      elevation: Number(e),
      hourly: {
        time,
        temperature_2m: fill(h.temperature),
        relative_humidity_2m: fill(h.humidity),
        dew_point_2m: fill(h.temperature - 2),
        precipitation: fill(precipitation),
        snowfall: fill(h.temperature < 1 ? precipitation * 0.7 : 0),
        snow_depth: fill(1.2),
        weather_code: fill(precipitation > 0 ? 73 : 3),
        cloud_cover: fill(h.cloud),
        cloud_cover_low: fill(h.low),
        cloud_cover_mid: fill(h.mid ?? 0),
        cloud_cover_high: fill(h.high ?? 0),
        wind_speed_10m: fill(h.wind),
        wind_direction_10m: fill(h.from ?? 270),
        wind_gusts_10m: fill(h.gusts),
      },
    }));
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
