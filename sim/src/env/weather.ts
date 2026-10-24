// The weather model: Open-Meteo hours (at a few heights on the mountain) in, the
// conditions at one place and moment out. Pure, so it's unit-tested; fetching lives in
// weather-source.ts and drawing in weather-fx.ts / environment.ts.

// Types, not interfaces: a day travels as JSON in a party's control message.

/** One height's hourly series, as Open-Meteo gives it (missing values are NaN). */
export type WeatherSeries = {
  /** The height asked for (m): Open-Meteo corrects temperature to it. */
  elevation: number;
  /** Start of each hour, ms since the epoch (UTC). */
  time: number[];
  /** °C */
  temperature: number[];
  /** % */
  humidity: number[];
  /** °C */
  dewPoint: number[];
  /** mm over the preceding hour (rain + snow water). */
  precipitation: number[];
  /** cm over the preceding hour. */
  snowfall: number[];
  /** m */
  snowDepth: number[];
  /** WMO weather code. */
  code: number[];
  /** % (total, low, mid, high). */
  cloud: number[];
  cloudLow: number[];
  cloudMid: number[];
  cloudHigh: number[];
  /** km/h at 10 m. */
  wind: number[];
  /** Degrees the wind blows from. */
  windDirection: number[];
  /** km/h */
  gusts: number[];
  /** m (forecast API only; the archive has none). */
  visibility: number[];
};

/** One resort-day of weather: what's fetched and cached, and shared with a party. */
export type WeatherDay = {
  /** Local date in the resort, YYYY-MM-DD. */
  date: string;
  source: 'archive' | 'forecast';
  /** Lowest first. */
  levels: WeatherSeries[];
};

export type Precipitation = 'none' | 'snow' | 'sleet' | 'rain';

/** The weather where you are, now: what the renderer, sound and the menu read. */
export interface Conditions {
  /** °C */
  temperature: number;
  /** % */
  humidity: number;
  /** Mean wind (m/s) and the direction it blows from (degrees, 0 = from the north). */
  wind: number;
  windFrom: number;
  /** m/s */
  gusts: number;
  /** 0..1 */
  cloud: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  precipitation: Precipitation;
  /** Water equivalent, mm/h. */
  precipRate: number;
  /** Snow falling, cm/h (0 in rain). */
  snowRate: number;
  /** Rain falling, mm/h. */
  rainRate: number;
  /** Snow fallen in the 24 h before (cm). */
  freshSnow: number;
  /** 0..1: how much you're inside a cloud (fog on the mountain). */
  inCloud: number;
  /** 0..1: snow lifted off the ground by the wind (spindrift, ground blizzard). */
  drift: number;
  /** Horizontal visibility (m). */
  visibility: number;
  /** 0..1: how much of the direct sun the cloud takes away. */
  overcast: number;
  /** 0..1: flat light: no shadows or contrast, snow and sky the same white. */
  whiteout: number;
}

/** The best visibility the model gives (m): clear, dry alpine air. */
export const MAX_VISIBILITY = 180_000;

/** Bluebird: what the sim shows with weather off ("Clear"). */
export const CLEAR: Conditions = {
  temperature: -5,
  humidity: 50,
  wind: 0,
  windFrom: 0,
  gusts: 0,
  cloud: 0,
  cloudLow: 0,
  cloudMid: 0,
  cloudHigh: 0,
  precipitation: 'none',
  precipRate: 0,
  snowRate: 0,
  rainRate: 0,
  freshSnow: 0,
  inCloud: 0,
  drift: 0,
  visibility: MAX_VISIBILITY,
  overcast: 0,
  whiteout: 0,
};

/** Gusts over the mean wind on open slopes. */
const GUST_FACTOR = 2;
/** Inside a cloud (m). */
const CLOUD_VISIBILITY = 50;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** NaN-tolerant lerp: a missing value takes the other. */
const mix = (a: number, b: number, t: number) =>
  Number.isNaN(a) ? b : Number.isNaN(b) ? a : lerp(a, b, t);

const HOURLY = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'precipitation',
  'snowfall',
  'snow_depth',
  'weather_code',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
] as const;
/** The hourly variables asked for (the forecast API adds visibility). */
export const HOURLY_VARIABLES: readonly string[] = HOURLY;

type OpenMeteoLocation = {
  elevation?: number;
  hourly?: Record<string, (number | null)[] | string[] | undefined>;
};

/**
 * Open-Meteo's answer (one location or a list, `timezone=GMT`) as a `WeatherDay`.
 * `elevations` are the heights asked for, in order. Throws on a malformed answer.
 */
export function parseOpenMeteo(
  json: unknown,
  date: string,
  source: WeatherDay['source'],
  elevations: number[],
): WeatherDay {
  const locations = (Array.isArray(json) ? json : [json]) as OpenMeteoLocation[];
  const levels = locations.map((loc, i): WeatherSeries => {
    const h = loc?.hourly;
    if (!h || !Array.isArray(h.time)) throw new Error('No hourly weather in the response');
    const time = (h.time as string[]).map((t) => Date.parse(`${t}:00Z`));
    if (time.some(Number.isNaN)) throw new Error('Bad times in the weather response');
    const series = (name: string) => {
      const v = h[name] as (number | null)[] | undefined;
      return time.map((_, j) => (typeof v?.[j] === 'number' ? v[j] : NaN));
    };
    return {
      elevation: elevations[i] ?? loc.elevation ?? 0,
      time,
      temperature: series('temperature_2m'),
      humidity: series('relative_humidity_2m'),
      dewPoint: series('dew_point_2m'),
      precipitation: series('precipitation'),
      snowfall: series('snowfall'),
      snowDepth: series('snow_depth'),
      code: series('weather_code'),
      cloud: series('cloud_cover'),
      cloudLow: series('cloud_cover_low'),
      cloudMid: series('cloud_cover_mid'),
      cloudHigh: series('cloud_cover_high'),
      wind: series('wind_speed_10m'),
      windDirection: series('wind_direction_10m'),
      gusts: series('wind_gusts_10m'),
      visibility: series('visibility'),
    };
  });
  if (levels.length === 0 || levels[0]!.time.length === 0)
    throw new Error('Empty weather response');
  if (levels[0]!.temperature.every(Number.isNaN)) throw new Error('No weather for that date');
  levels.sort((a, b) => a.elevation - b.elevation);
  return { date, source, levels };
}

/** One height's values at a moment (hours interpolated). */
interface LevelSample {
  elevation: number;
  temperature: number;
  humidity: number;
  dewPoint: number;
  precipitation: number;
  windX: number;
  windY: number;
  gusts: number;
  cloud: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  visibility: number;
  freshSnow: number;
}

/**
 * Open-Meteo's precipitation is the sum over the hour *ending* at its timestamp, the rest
 * are values at it. So rates are read half an hour later than the instantaneous ones.
 */
function sampleLevel(s: WeatherSeries, at: number): LevelSample {
  const n = s.time.length;
  const index = (t: number) => {
    const step = n > 1 ? s.time[1]! - s.time[0]! : 3_600_000;
    const f = Math.min(n - 1, Math.max(0, (t - s.time[0]!) / step));
    const i = Math.min(n - 2, Math.floor(f));
    return n > 1 ? { i, t: f - i } : { i: 0, t: 0 };
  };
  const at0 = index(at);
  const atRate = index(at + 1_800_000);
  const v = (a: number[], { i, t }: { i: number; t: number }) =>
    n > 1 ? mix(a[i]!, a[i + 1]!, t) : a[0]!;
  const zero = (x: number) => (Number.isNaN(x) ? 0 : x);
  // Wind as a vector, so 350° → 10° goes through north, not south.
  const vec = (j: number) => {
    const speed = zero(s.wind[j]!);
    const from = zero(s.windDirection[j]!) * (Math.PI / 180);
    return { x: speed * Math.sin(from), y: speed * Math.cos(from) };
  };
  const a = vec(at0.i);
  const b = vec(Math.min(n - 1, at0.i + 1));
  let fresh = 0;
  for (let j = 0; j < n; j++) {
    const t = s.time[j]!;
    if (t > at - 86_400_000 && t <= at) fresh += zero(s.snowfall[j]!);
  }
  return {
    elevation: s.elevation,
    temperature: v(s.temperature, at0),
    humidity: v(s.humidity, at0),
    dewPoint: v(s.dewPoint, at0),
    precipitation: zero(v(s.precipitation, atRate)),
    windX: lerp(a.x, b.x, at0.t),
    windY: lerp(a.y, b.y, at0.t),
    gusts: zero(v(s.gusts, at0)),
    cloud: zero(v(s.cloud, at0)),
    cloudLow: zero(v(s.cloudLow, at0)),
    cloudMid: zero(v(s.cloudMid, at0)),
    cloudHigh: zero(v(s.cloudHigh, at0)),
    visibility: v(s.visibility, at0),
    freshSnow: fresh,
  };
}

/** Temperature lapse rate used above the top and below the bottom level (°C/m). */
const LAPSE = -0.0065;

/** The levels at `at`, blended for `altitude` (beyond the ends, temperature follows the lapse rate). */
function sampleAt(day: WeatherDay, at: number, altitude: number): LevelSample {
  const levels = day.levels.map((l) => sampleLevel(l, at));
  const first = levels[0]!;
  const last = levels.at(-1)!;
  let lo = first;
  let hi = first;
  if (altitude >= last.elevation) lo = hi = last;
  else if (altitude > first.elevation) {
    const i = levels.findIndex((l) => l.elevation > altitude);
    lo = levels[i - 1]!;
    hi = levels[i]!;
  }
  const t =
    hi.elevation > lo.elevation ? (altitude - lo.elevation) / (hi.elevation - lo.elevation) : 0;
  const out = {} as LevelSample;
  for (const k of Object.keys(lo) as (keyof LevelSample)[]) out[k] = mix(lo[k], hi[k], t);
  // Outside the levels, temperature (and dew point, more slowly) keep changing with height.
  const beyond = lo === hi ? altitude - lo.elevation : 0;
  out.temperature += LAPSE * beyond;
  out.dewPoint += 0.4 * LAPSE * beyond;
  out.elevation = altitude;
  return out;
}

/** Share of precipitation falling as snow at a temperature (°C): sleet between 0.5 and 2.5. */
export function snowFraction(temperature: number): number {
  return 1 - smoothstep(0.5, 2.5, temperature);
}

/** Visibility (m) in falling snow of `rate` cm/h: ~2 km light, ~700 m moderate, ~350 m heavy. */
export function snowVisibility(rate: number): number {
  return rate <= 0.01 ? Infinity : 1000 / rate ** 0.95;
}

/** Visibility (m) in rain of `rate` mm/h. */
export function rainVisibility(rate: number): number {
  return rate <= 0.05 ? Infinity : 12_000 / (1 + 1.5 * rate);
}

/**
 * The conditions at `altitude` (m) at the instant `at` (ms, UTC). Hours are interpolated,
 * heights blended between the fetched levels; visibility, cloud and flat light are derived
 * (the archive has no visibility: fog comes from humidity and low cloud, whiteout from
 * cloud, snow and wind).
 */
export function conditionsAt(day: WeatherDay, at: number, altitude: number): Conditions {
  const s = sampleAt(day, at, altitude);
  const temperature = s.temperature;
  const humidity = Math.min(100, Math.max(0, s.humidity));
  // ERA5's 10 m mean wind is damped by the mountains' roughness (a storm's 130 km/h gusts
  // over a 15 km/h mean), so the mean on the slopes is taken as at least half the gusts.
  const gusts = s.gusts / 3.6;
  const wind = Math.max(Math.hypot(s.windX, s.windY) / 3.6, gusts / GUST_FACTOR);
  const windFrom = ((Math.atan2(s.windX, s.windY) * 180) / Math.PI + 360) % 360;
  const cloud = clamp01(s.cloud / 100);
  const cloudLow = clamp01(s.cloudLow / 100);
  const cloudMid = clamp01(s.cloudMid / 100);
  const cloudHigh = clamp01(s.cloudHigh / 100);

  const precipRate = Math.max(0, s.precipitation);
  const snowShare = snowFraction(temperature);
  // Open-Meteo's own ratio: 1 mm of water is 0.7 cm of snow.
  const snowRate = precipRate * snowShare * 0.7;
  const rainRate = precipRate * (1 - snowShare);
  const precipitation: Precipitation =
    precipRate < 0.05 ? 'none' : snowShare > 0.85 ? 'snow' : snowShare < 0.15 ? 'rain' : 'sleet';

  // In a cloud: near saturation with low or mid cloud about (2 m humidity in ERA5 reaches
  // ~95-100 % inside cloud on the mountain, and in valley fog).
  const inCloud =
    smoothstep(94.5, 99.5, humidity) * smoothstep(0.4, 0.9, Math.max(cloudLow, cloudMid * 0.85));
  // Spindrift: loose snow lifts from ~8 m/s, a ground blizzard from ~18 m/s. Dry new snow
  // goes easily, old wet snow hardly.
  const loose =
    clamp01(0.35 + s.freshSnow / 10 + (snowRate > 0.05 ? 0.5 : 0)) *
    (1 - smoothstep(-1, 1.5, temperature) * 0.8);
  const drift = smoothstep(8, 20, (wind + gusts) / 2) * loose;

  // Extinctions add: 1/V = Σ 1/V_i.
  const haze = Number.isFinite(s.visibility)
    ? Math.max(s.visibility, 2000) * 2 // the forecast's figure is for the valley-level cell
    : MAX_VISIBILITY * (1 - 0.85 * smoothstep(70, 97, humidity));
  const extinction =
    1 / Math.min(MAX_VISIBILITY, haze) +
    1 / snowVisibility(snowRate) +
    1 / rainVisibility(rainRate) +
    inCloud ** 2 / CLOUD_VISIBILITY +
    drift ** 2 / 120;
  const visibility = Math.min(MAX_VISIBILITY, 1 / extinction);

  // The sun's disc: thick low and mid cloud hide it, thin high cloud only dims it.
  const blocked = 1 - (1 - cloudLow) * (1 - cloudMid * 0.95) * (1 - cloudHigh * 0.4);
  const overcast = Math.max(
    smoothstep(0.45, 0.95, Math.max(blocked, cloud * 0.9)),
    inCloud,
    smoothstep(0.2, 1.5, snowRate),
    smoothstep(0.5, 3, rainRate),
  );
  // Flat light: overcast and short visibility on snow.
  const whiteout = overcast * (1 - smoothstep(120, 2500, visibility));
  return {
    temperature,
    humidity,
    wind,
    windFrom,
    gusts: Math.max(wind, gusts),
    cloud,
    cloudLow,
    cloudMid,
    cloudHigh,
    precipitation,
    precipRate,
    snowRate,
    rainRate,
    freshSnow: s.freshSnow,
    inCloud,
    drift,
    visibility,
    overcast,
    whiteout,
  };
}

/**
 * The wind right now (m/s): the mean, rising toward the gusts now and then. Deterministic
 * in `seconds` so sound, snow and remote players agree.
 */
export function gustyWind(c: Pick<Conditions, 'wind' | 'gusts'>, seconds: number): number {
  const w =
    0.55 * Math.sin(seconds * 0.31) +
    0.3 * Math.sin(seconds * 0.83 + 1.7) +
    0.15 * Math.sin(seconds * 2.3 + 0.4);
  const gust = clamp01(w * 0.5 + 0.5) ** 3;
  return c.wind + (c.gusts - c.wind) * gust;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** "NW" for a direction in degrees. */
export function compass(degrees: number): string {
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]!;
}

/** "Heavy snow", "Blizzard", "Partly cloudy"… */
export function describeSky(c: Conditions): string {
  const blowing = c.wind > 14 || c.gusts > 22;
  if (c.precipitation === 'snow' || c.precipitation === 'sleet') {
    if (c.precipitation === 'snow' && blowing && c.snowRate > 0.3) return 'Blizzard';
    const kind = c.precipitation === 'snow' ? 'snow' : 'sleet';
    if (c.snowRate + c.rainRate / 2 < 0.3) return `Light ${kind}`;
    return c.snowRate > 1.5 ? `Heavy ${kind}` : kind === 'snow' ? 'Snow' : 'Sleet';
  }
  if (c.precipitation === 'rain')
    return c.rainRate < 0.5 ? 'Drizzle' : c.rainRate > 4 ? 'Heavy rain' : 'Rain';
  if (c.drift > 0.5) return 'Blowing snow';
  if (c.inCloud > 0.5) return c.whiteout > 0.6 ? 'Whiteout' : 'In cloud';
  const cover = Math.max(c.cloud, c.overcast);
  if (cover < 0.12) return 'Clear';
  if (cover < 0.35) return 'Mostly clear';
  if (cover < 0.65) return 'Partly cloudy';
  if (cover < 0.9) return 'Mostly cloudy';
  return 'Overcast';
}

/** Rounded the way a forecast would say it. */
export function formatVisibility(m: number): string {
  if (m >= 50_000) return 'visibility 50+ km';
  if (m >= 10_000) return `visibility ${Math.round(m / 5000) * 5} km`;
  if (m >= 1000) return `visibility ${Math.round(m / 1000)} km`;
  if (m >= 200) return `visibility ~${Math.round(m / 100) * 100} m`;
  return `visibility ~${Math.max(10, Math.round(m / 10) * 10)} m`;
}

/** "Heavy snow · −8 °C · wind 45 km/h NW · visibility ~50 m" */
export function describe(c: Conditions): string {
  const t = Math.round(c.temperature);
  const temp = `${t < 0 ? '−' : ''}${Math.abs(t)} °C`;
  const kmh = Math.round(c.wind * 3.6);
  const wind = kmh < 3 ? 'calm' : `wind ${kmh} km/h ${compass(c.windFrom)}`;
  return [describeSky(c), temp, wind, formatVisibility(c.visibility)].join(' · ');
}
