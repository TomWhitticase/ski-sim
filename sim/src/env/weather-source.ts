// Getting a resort-day of weather from Open-Meteo (https://open-meteo.com, CC BY 4.0):
// one request per resort-day, for a few heights at once, cached in localStorage. Nothing
// here runs unless the player turns weather on.

import { addDays } from './time-of-day';
import { HOURLY_VARIABLES, parseOpenMeteo, type WeatherDay, type WeatherSeries } from './weather';

export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
/** The reanalysis lags ~5 days; anything this recent comes from the forecast API's past. */
const ARCHIVE_LAG_DAYS = 7;
/** Earliest date the reanalysis covers. */
export const FIRST_DATE = '1940-01-01';

export const WEATHER_PROVENANCE = {
  layer: 'weather',
  name: 'Open-Meteo (ERA5 / ERA5-Land reanalysis, weather models)',
  url: 'https://open-meteo.com/',
  license: 'CC BY 4.0',
  attribution:
    'Weather data by Open-Meteo.com. Hourly, ~9–25 km grid, corrected to the height of the ' +
    'resort; fetched only when weather is on.',
};

export interface WeatherRequest {
  lat: number;
  lon: number;
  /** Heights to ask for (m): the bottom, middle and top of the lifts. */
  elevations: number[];
  /** Local date in the resort. */
  date: string;
  /** Today's local date in the resort. */
  today: string;
}

/**
 * The Open-Meteo URL for a resort-day. Hours are asked for in UTC from the day before to
 * the day after, which covers the local day in any zone plus the 24 h of snow before it.
 */
export function weatherUrl(r: WeatherRequest): { url: string; source: WeatherDay['source'] } {
  const source = r.date <= addDays(r.today, -ARCHIVE_LAG_DAYS) ? 'archive' : 'forecast';
  const vars = source === 'forecast' ? [...HOURLY_VARIABLES, 'visibility'] : HOURLY_VARIABLES;
  const n = r.elevations.length;
  const params = new URLSearchParams({
    latitude: Array(n).fill(r.lat.toFixed(4)).join(','),
    longitude: Array(n).fill(r.lon.toFixed(4)).join(','),
    elevation: r.elevations.map((e) => Math.round(e)).join(','),
    start_date: addDays(r.date, -1),
    end_date: addDays(r.date, 1),
    hourly: vars.join(','),
    timezone: 'GMT',
    wind_speed_unit: 'kmh',
  });
  return { url: `${source === 'archive' ? ARCHIVE_URL : FORECAST_URL}?${params}`, source };
}

const CACHE_PREFIX = 'ski-sim.weather-day.';
const CACHE_INDEX = 'ski-sim.weather-days';
/** Days kept (~25 kB each). */
const CACHE_MAX = 40;
/** Recent days come from the forecast API, which keeps improving them: refetch after this (ms). */
const FORECAST_TTL = 3 * 3_600_000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const cacheKey = (resort: string, date: string) => `${CACHE_PREFIX}${resort}.${date}`;

/** A cached day, if there's one still fresh. */
export function cachedDay(
  store: Store,
  resort: string,
  date: string,
  now: number,
): WeatherDay | null {
  try {
    const raw = JSON.parse(store.getItem(cacheKey(resort, date)) ?? 'null') as {
      at: number;
      day: WeatherDay;
    } | null;
    if (!raw?.day?.levels?.length) return null;
    if (raw.day.source === 'forecast' && now - raw.at > FORECAST_TTL) return null;
    return reviveDay(raw.day);
  } catch {
    return null;
  }
}

/** JSON turns NaN into null; turn it back. */
export function reviveDay(day: WeatherDay): WeatherDay {
  return {
    ...day,
    levels: day.levels.map((l) => {
      const out = { ...l } as Record<string, unknown>;
      for (const [k, v] of Object.entries(l)) {
        if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'number' ? x : NaN));
      }
      return out as unknown as WeatherSeries;
    }),
  };
}

export function cacheDay(store: Store, resort: string, day: WeatherDay, now: number): void {
  const key = cacheKey(resort, day.date);
  let index: string[] = [];
  try {
    index = (JSON.parse(store.getItem(CACHE_INDEX) ?? '[]') as string[]).filter((k) => k !== key);
  } catch {
    /* a fresh index */
  }
  index.push(key);
  while (index.length > CACHE_MAX) store.removeItem(index.shift()!);
  try {
    store.setItem(key, JSON.stringify({ at: now, day }));
    store.setItem(CACHE_INDEX, JSON.stringify(index));
  } catch {
    // Storage full: forget the older half and carry on uncached.
    for (const k of index.splice(0, index.length >> 1)) store.removeItem(k);
    store.setItem(CACHE_INDEX, JSON.stringify(index));
  }
}

export type Fetch = (url: string) => Promise<Response>;

/** A resort-day of weather, from the cache or Open-Meteo. Throws with a message for the menu. */
export async function loadWeatherDay(
  resort: string,
  request: WeatherRequest,
  get: Fetch = (url) => fetch(url),
  store: Store = localStorage,
  now = Date.now(),
): Promise<WeatherDay> {
  const hit = cachedDay(store, resort, request.date, now);
  if (hit) return hit;
  const { url, source } = weatherUrl(request);
  let res: Response;
  try {
    res = await get(url);
  } catch {
    throw new Error("Couldn't reach Open-Meteo (offline?)");
  }
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      reason = ((await res.json()) as { reason?: string }).reason ?? reason;
    } catch {
      /* keep the status */
    }
    throw new Error(`Open-Meteo: ${reason}`);
  }
  const day = parseOpenMeteo(await res.json(), request.date, source, request.elevations);
  cacheDay(store, resort, day, now);
  return day;
}

/**
 * The heights to fetch for a resort (m): the bottom of its lifts (the 10th percentile of
 * bottom stations, so one long valley lift doesn't set it), the top, and halfway.
 */
export function weatherHeights(lifts: { supports: { ground: number }[] }[]): number[] {
  const ends = lifts.filter((l) => l.supports.length >= 2);
  if (ends.length === 0) return [1500, 2500];
  const bottoms = ends.map((l) => l.supports[0]!.ground).sort((a, b) => a - b);
  const bottom = bottoms[Math.floor((bottoms.length - 1) * 0.1)]!;
  const top = Math.max(...ends.map((l) => l.supports.at(-1)!.ground));
  if (top - bottom < 300) return [Math.round(bottom), Math.round(top)];
  return [bottom, (bottom + top) / 2, top].map(Math.round);
}
