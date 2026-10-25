// Getting a resort-day of weather from Open-Meteo (https://open-meteo.com, CC BY 4.0): a
// grid of points over the resort in one request (plus pressure-level cloud over a few of
// them), from the best source for the date, cached in localStorage. Nothing here runs
// unless the player turns weather on.

import { addDays } from './time-of-day';
import {
  HOURLY_VARIABLES,
  PRESSURE_VARIABLES,
  parseOpenMeteo,
  parsePressure,
  type PressureProfile,
  type WeatherDay,
  type WeatherSite,
} from './weather';
import type { WeatherPlan } from './weather-field';

export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
export const HISTORICAL_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
/** The reanalysis lags ~5 days; anything this recent comes from the forecast API's past. */
const ARCHIVE_LAG_DAYS = 7;
/** Earliest date the reanalysis covers. */
export const FIRST_DATE = '1940-01-01';
/** From here archived high-resolution model runs (Historical Forecast API) are complete. */
export const HISTORICAL_FROM = '2022-11-24';

/** A weather model Open-Meteo serves, where and since when (its archive), best first. */
interface Model {
  id: string;
  name: string;
  /** ISO countries it's chosen for. */
  countries: string[];
  /** First day of its archive. */
  from: string;
  /** Its domain (lat/lon), so a resort near a border isn't asked of a model that ends short. */
  box: [south: number, west: number, north: number, east: number];
}

// The "seamless" ids fill a high-resolution model's gaps (variables it lacks, beyond its
// domain or forecast range) from the same provider's coarser ones.
const MODELS: Model[] = [
  {
    id: 'meteoswiss_icon_seamless',
    name: 'MeteoSwiss ICON-CH1 (1 km)',
    countries: ['CH', 'LI'],
    from: '2025-07-29',
    box: [43, 0.5, 50, 17],
  },
  {
    id: 'meteofrance_seamless',
    name: 'Météo-France AROME (1.5–2.5 km)',
    countries: ['FR', 'AD', 'MC', 'IT'],
    from: '2022-11-13',
    box: [37.5, -12, 55.4, 16],
  },
  {
    id: 'icon_seamless',
    name: 'DWD ICON-D2 (2 km)',
    countries: ['DE', 'AT', 'CH', 'LI', 'SI'],
    from: '2022-11-24',
    box: [43.2, -3.9, 58, 20.3],
  },
];

export const MODEL_NAMES: Record<string, string> = {
  era5: 'ERA5 / ERA5-Land reanalysis (9–25 km)',
  best_match: "Open-Meteo's best model for the place",
  ...Object.fromEntries(MODELS.map((m) => [m.id, m.name])),
};

/** Words for where a day came from, for the menu and credits. */
export function modelName(day: Pick<WeatherDay, 'model' | 'source'>): string {
  return MODEL_NAMES[day.model] ?? day.model;
}

const ATTRIBUTION =
  'Weather data by Open-Meteo.com: archived high-resolution model runs where they exist ' +
  '(from late 2022), ERA5 reanalysis before, the forecast for the last week; hourly, on a ' +
  'grid of points over the resort at their own heights; fetched only when weather is on.';

export const WEATHER_PROVENANCE = {
  layer: 'weather',
  name: 'Open-Meteo (weather models, ERA5 / ERA5-Land reanalysis)',
  url: 'https://open-meteo.com/',
  license: 'CC BY 4.0',
  attribution: ATTRIBUTION,
};

/** The credits' entry, naming the model the day on show came from. */
export function weatherProvenance(day: WeatherDay | null): typeof WEATHER_PROVENANCE {
  if (!day) return WEATHER_PROVENANCE;
  const where = `${day.sites.length} points${day.profiles.length ? ', with pressure-level cloud' : ''}`;
  return {
    ...WEATHER_PROVENANCE,
    attribution: `${ATTRIBUTION} ${day.date}: ${modelName(day)} (${where}).`,
  };
}

export interface WeatherRequest {
  /** The points (see `planWeatherSites`) with their lat/lon. */
  plan: WeatherPlan;
  latLon: (east: number, north: number) => { lat: number; lon: number };
  /** The resort's main country (ISO). */
  country: string;
  /** Local date in the resort. */
  date: string;
  /** Today's local date in the resort. */
  today: string;
}

type Source = WeatherDay['source'];

/** The sources to try for a day, best first: [API, model]. */
export function weatherSources(r: WeatherRequest): [Source, string][] {
  const recent = r.date > addDays(r.today, -ARCHIVE_LAG_DAYS);
  const centre = r.latLon(
    (r.plan.grid.west + r.plan.grid.east) / 2,
    (r.plan.grid.south + r.plan.grid.north) / 2,
  );
  const fits = (m: Model) =>
    m.countries.includes(r.country.toUpperCase()) &&
    r.date >= m.from &&
    centre.lat >= m.box[0] &&
    centre.lon >= m.box[1] &&
    centre.lat <= m.box[2] &&
    centre.lon <= m.box[3];
  const model = MODELS.find(fits)?.id;
  const models = model ? [model, 'best_match'] : ['best_match'];
  if (recent) return models.map((m) => ['forecast', m]);
  const out: [Source, string][] = [];
  if (r.date >= HISTORICAL_FROM)
    out.push(...models.map((m): [Source, string] => ['historical', m]));
  out.push(['archive', 'era5']);
  return out;
}

const BASE: Record<Source, string> = {
  archive: ARCHIVE_URL,
  historical: HISTORICAL_URL,
  forecast: FORECAST_URL,
};

/**
 * The Open-Meteo URL for the points (or, with `pressure`, the pressure-level cloud over
 * the profile points). Hours are asked for in UTC from the day before to the day after,
 * which covers the local day in any zone plus the 24 h of snow before it.
 */
export function weatherUrl(
  r: WeatherRequest,
  source: Source,
  model: string,
  pressure = false,
): string {
  const places = pressure ? r.plan.profiles : r.plan.points;
  const ll = places.map((p) => r.latLon(p.east, p.north));
  const vars = pressure
    ? PRESSURE_VARIABLES
    : source === 'archive'
      ? HOURLY_VARIABLES
      : [...HOURLY_VARIABLES, 'visibility'];
  const params = new URLSearchParams({
    latitude: ll.map((p) => p.lat.toFixed(4)).join(','),
    longitude: ll.map((p) => p.lon.toFixed(4)).join(','),
  });
  if (!pressure)
    params.set('elevation', r.plan.points.map((p) => Math.round(p.elevation)).join(','));
  params.set('start_date', addDays(r.date, -1));
  params.set('end_date', addDays(r.date, 1));
  params.set('hourly', vars.join(','));
  if (source !== 'archive') params.set('models', model);
  params.set('timezone', 'GMT');
  params.set('wind_speed_unit', 'kmh');
  return `${BASE[source]}?${params}`;
}

/**
 * What a resort-day costs on Open-Meteo's free tier (10,000 calls a day per IP): a call
 * per point per 10 variables, so ~1 per point, plus 1.2 per pressure-level point.
 */
export function requestCost(r: WeatherRequest, source: Source): number {
  const per = (vars: number) => Math.max(1, vars / 10);
  const points =
    r.plan.points.length * per(HOURLY_VARIABLES.length + (source === 'archive' ? 0 : 1));
  return source === 'archive'
    ? points
    : points + r.plan.profiles.length * per(PRESSURE_VARIABLES.length);
}

const CACHE_PREFIX = 'ski-sim.weather-field.';
const CACHE_INDEX = 'ski-sim.weather-fields';
/** The first iteration's single-column days. */
const OLD_INDEX = 'ski-sim.weather-days';
/** Days kept (~150–250 kB each). */
const CACHE_MAX = 12;
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
    if (!isDay(raw?.day)) return null;
    if (raw.day.source === 'forecast' && now - raw.at > FORECAST_TTL) return null;
    return reviveDay(raw.day);
  } catch {
    return null;
  }
}

/** Whether `x` looks like a day of this version (cache, a party's message). */
export function isDay(x: unknown): x is WeatherDay {
  const d = x as Partial<WeatherDay> | null | undefined;
  const g = d?.grid;
  return (
    !!g &&
    Array.isArray(d.sites) &&
    Array.isArray(d.profiles) &&
    Number.isInteger(g.nx) &&
    Number.isInteger(g.ny) &&
    g.nx >= 1 &&
    g.ny >= 1 &&
    d.sites.length >= g.nx * g.ny
  );
}

/** JSON turns NaN into null; turn it back. */
export function reviveDay(day: WeatherDay): WeatherDay {
  const numbers = <T extends object>(o: T): T => {
    const out = { ...o } as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'number' ? x : NaN));
    }
    return out as T;
  };
  return {
    ...day,
    sites: day.sites.map((s) => numbers<WeatherSite>(s)),
    profiles: day.profiles.map((p) => ({
      ...numbers<PressureProfile>(p),
      levels: p.levels.map((l) => numbers(l)),
    })),
  };
}

export function cacheDay(store: Store, resort: string, day: WeatherDay, now: number): void {
  // The first iteration's days can't be read any more: make room.
  try {
    const old = JSON.parse(store.getItem(OLD_INDEX) ?? 'null') as string[] | null;
    if (old) {
      for (const k of old) store.removeItem(k);
      store.removeItem(OLD_INDEX);
    }
  } catch {
    store.removeItem(OLD_INDEX);
  }
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

/** Open-Meteo's answer, or an error worded for the menu (`retry`: another source may work). */
async function getJson(get: Fetch, url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await get(url);
  } catch {
    throw Object.assign(new Error("Couldn't reach Open-Meteo (offline?)"), { retry: false });
  }
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      reason = ((await res.json()) as { reason?: string }).reason ?? reason;
    } catch {
      /* keep the status */
    }
    // Too many requests or a server down won't be better from another model.
    const retry = res.status === 400 || res.status === 404;
    throw Object.assign(new Error(`Open-Meteo: ${reason}`), { retry });
  }
  return res.json();
}

/**
 * A resort-day of weather, from the cache or Open-Meteo: the best source for the date
 * (see `weatherSources`), the next one if it has nothing for the place or day. Throws with
 * a message for the menu.
 */
export async function loadWeatherDay(
  resort: string,
  request: WeatherRequest,
  get: Fetch = (url) => fetch(url),
  store: Store = localStorage,
  now = Date.now(),
): Promise<WeatherDay> {
  const hit = cachedDay(store, resort, request.date, now);
  if (hit) return hit;
  const { plan } = request;
  let error: unknown = null;
  for (const [source, model] of weatherSources(request)) {
    let sites: WeatherSite[];
    try {
      sites = parseOpenMeteo(await getJson(get, weatherUrl(request, source, model)), plan.points);
    } catch (e) {
      error = e;
      if ((e as { retry?: boolean }).retry === false) break;
      continue;
    }
    const profiles = source === 'archive' ? [] : await loadProfiles(request, source, model, get);
    const day: WeatherDay = { date: request.date, source, model, grid: plan.grid, sites, profiles };
    cacheDay(store, resort, day, now);
    return day;
  }
  throw error instanceof Error ? error : new Error('No weather for that date');
}

/** Pressure-level cloud from the same model (or the best match); none if neither has it. */
async function loadProfiles(
  request: WeatherRequest,
  source: Source,
  model: string,
  get: Fetch,
): Promise<PressureProfile[]> {
  for (const m of model === 'best_match' ? [model] : [model, 'best_match']) {
    try {
      const json = await getJson(get, weatherUrl(request, source, m, true));
      const profiles = parsePressure(json, request.plan.profiles);
      if (profiles.length > 0) return profiles;
    } catch (e) {
      console.warn('[weather] no pressure levels:', e);
      return [];
    }
  }
  return [];
}
