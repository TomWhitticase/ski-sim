// The weather model: Open-Meteo hours (at points spread over the resort, each at its own
// height) in, the conditions at one place and moment out. Pure, so it's unit-tested;
// the field (spatial blending, cloud layers) is weather-field.ts, fetching weather-source.ts
// and drawing weather-fx.ts / cloud-layer.ts / environment.ts.

// Types, not interfaces: a day travels as JSON in a party's control message.

/** One point's hourly series, as Open-Meteo gives it (missing values are NaN). */
export type WeatherSeries = {
  /** The height asked for (m): Open-Meteo picks a grid cell and corrects temperature to it. */
  elevation: number;
  /** Start of each hour, ms since the epoch (UTC). */
  time: number[];
  /** °C */
  temperature: number[];
  /** % */
  humidity: number[];
  /** mm over the preceding hour (rain + snow water). */
  precipitation: number[];
  /** cm over the preceding hour. */
  snowfall: number[];
  /** % (low, mid, high). */
  cloudLow: number[];
  cloudMid: number[];
  cloudHigh: number[];
  /** km/h at 10 m. */
  wind: number[];
  /** Degrees the wind blows from. */
  windDirection: number[];
  /** km/h */
  gusts: number[];
  /** m (forecast models only; the archive has none). */
  visibility: number[];
};

/** A point of the field: its series and where it is in the resort's local frame (m). */
export type WeatherSite = WeatherSeries & { east: number; north: number };

/** Cloud cover on pressure levels above a point, hourly (models that have them). */
export type PressureProfile = {
  east: number;
  north: number;
  time: number[];
  levels: {
    /** hPa */
    pressure: number;
    /** Geopotential height (m), hourly. */
    height: number[];
    /** %, hourly. */
    cloud: number[];
  }[];
};

/** The regular grid the first `nx * ny` sites sit on, row by row from the south-west. */
export type FieldGrid = {
  nx: number;
  ny: number;
  west: number;
  south: number;
  east: number;
  north: number;
};

/** One resort-day of weather: what's fetched and cached, and shared with a party. */
export type WeatherDay = {
  /** Local date in the resort, YYYY-MM-DD. */
  date: string;
  /** Which API: ERA5 reanalysis, archived model runs, or the forecast. */
  source: 'archive' | 'historical' | 'forecast';
  /** The Open-Meteo model asked for (`best_match`, `meteofrance_seamless`…). */
  model: string;
  grid: FieldGrid;
  /** The grid's points at their ground height, then extra heights (a column at the centre). */
  sites: WeatherSite[];
  profiles: PressureProfile[];
};

/** The lowest cloud deck over a point (m above sea level). */
export type CloudLayer = {
  base: number;
  top: number;
  /** 0..1 (0: no deck here). */
  cover: number;
  /** 0..1: how much of it is mid-level cloud (its cover is `cloudMid`, not `cloudLow`). */
  mid: number;
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
  /** 0..1, the cloud above you (a deck below you doesn't count). */
  cloud: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  /** The local cloud deck (m; NaN with none) and its cover. */
  cloudBase: number;
  cloudTop: number;
  cloudCover: number;
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
  cloudBase: NaN,
  cloudTop: NaN,
  cloudCover: 0,
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
  'precipitation',
  'snowfall',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
] as const;
/**
 * The hourly variables asked for at every point: ten, one Open-Meteo "call" per point
 * (forecast models add visibility). Dew point and total cloud are worked out from these.
 */
export const HOURLY_VARIABLES: readonly string[] = HOURLY;

/** Pressure levels asked for over a few points (hPa): ~1000 m to ~5600 m. */
export const PRESSURE_LEVELS = [900, 850, 800, 700, 600, 500] as const;
export const PRESSURE_VARIABLES: readonly string[] = PRESSURE_LEVELS.flatMap((p) => [
  `cloud_cover_${p}hPa`,
  `geopotential_height_${p}hPa`,
]);

type OpenMeteoLocation = {
  elevation?: number;
  hourly?: Record<string, (number | null)[] | string[] | undefined>;
};

/** Open-Meteo's answer as a list of locations with their hours (UTC) and a value reader. */
function locations(json: unknown) {
  const list = (Array.isArray(json) ? json : [json]) as OpenMeteoLocation[];
  return list.map((loc) => {
    const h = loc?.hourly;
    if (!h || !Array.isArray(h.time)) throw new Error('No hourly weather in the response');
    const time = (h.time as string[]).map((t) => Date.parse(`${t}:00Z`));
    if (time.some(Number.isNaN)) throw new Error('Bad times in the weather response');
    const series = (name: string) => {
      const v = h[name] as (number | null)[] | undefined;
      return time.map((_, j) => (typeof v?.[j] === 'number' ? v[j] : NaN));
    };
    return { time, series };
  });
}

/**
 * Open-Meteo's answer (one location or a list, `timezone=GMT`) as series, one per point
 * asked for, in order. Throws on a malformed answer or one with no weather in it (a model
 * that doesn't cover the place or the date).
 */
export function parseOpenMeteo(
  json: unknown,
  points: { east: number; north: number; elevation: number }[],
): WeatherSite[] {
  const sites = locations(json).map(({ time, series }, i): WeatherSite => {
    const p = points[i] ?? { east: 0, north: 0, elevation: 0 };
    return {
      east: p.east,
      north: p.north,
      elevation: p.elevation,
      time,
      temperature: series('temperature_2m'),
      humidity: series('relative_humidity_2m'),
      precipitation: series('precipitation'),
      snowfall: series('snowfall'),
      cloudLow: series('cloud_cover_low'),
      cloudMid: series('cloud_cover_mid'),
      cloudHigh: series('cloud_cover_high'),
      wind: series('wind_speed_10m'),
      windDirection: series('wind_direction_10m'),
      gusts: series('wind_gusts_10m'),
      visibility: series('visibility'),
    };
  });
  if (sites.length === 0 || sites[0]!.time.length === 0) throw new Error('Empty weather response');
  if (sites.length < points.length) throw new Error('Weather missing for some places');
  // A model that doesn't cover the place answers with nulls.
  const empty = sites.filter((s) => s.temperature.every(Number.isNaN)).length;
  if (empty > sites.length / 2) throw new Error('No weather for that date');
  return sites;
}

/** Pressure-level cloud over the points asked for; levels a model lacks are left out. */
export function parsePressure(
  json: unknown,
  points: { east: number; north: number }[],
): PressureProfile[] {
  return locations(json)
    .map(({ time, series }, i): PressureProfile => ({
      east: points[i]?.east ?? 0,
      north: points[i]?.north ?? 0,
      time,
      levels: PRESSURE_LEVELS.map((pressure) => ({
        pressure,
        height: series(`geopotential_height_${pressure}hPa`),
        cloud: series(`cloud_cover_${pressure}hPa`),
      })).filter(
        (l) => l.cloud.some((v) => !Number.isNaN(v)) && l.height.some((v) => !Number.isNaN(v)),
      ),
    }))
    .filter((p) => p.levels.length >= 2);
}

/** One point's values at a moment (hours interpolated). */
export interface Sample {
  elevation: number;
  temperature: number;
  humidity: number;
  precipitation: number;
  windX: number;
  windY: number;
  gusts: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  visibility: number;
  freshSnow: number;
}

/** Where `at` falls in hourly `time`: the hour before and how far to the next. */
export function hourIndex(time: number[], at: number): { i: number; t: number } {
  const n = time.length;
  if (n < 2) return { i: 0, t: 0 };
  const step = time[1]! - time[0]!;
  const f = Math.min(n - 1, Math.max(0, (at - time[0]!) / step));
  const i = Math.min(n - 2, Math.floor(f));
  return { i, t: f - i };
}

/** A series' value at an hour index (NaN-tolerant). */
export function valueAt(a: number[], { i, t }: { i: number; t: number }): number {
  return a.length > 1 ? mix(a[i]!, a[i + 1]!, t) : (a[0] ?? NaN);
}

/**
 * One point's values at `at`. Open-Meteo's precipitation is the sum over the hour *ending*
 * at its timestamp, the rest are values at it. So rates are read half an hour later.
 */
export function sampleSeries(s: WeatherSeries, at: number): Sample {
  const n = s.time.length;
  const at0 = hourIndex(s.time, at);
  const atRate = hourIndex(s.time, at + 1_800_000);
  const v = (a: number[], i: { i: number; t: number }) => valueAt(a, i);
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
    precipitation: zero(v(s.precipitation, atRate)),
    windX: lerp(a.x, b.x, at0.t),
    windY: lerp(a.y, b.y, at0.t),
    gusts: zero(v(s.gusts, at0)),
    cloudLow: zero(v(s.cloudLow, at0)),
    cloudMid: zero(v(s.cloudMid, at0)),
    cloudHigh: zero(v(s.cloudHigh, at0)),
    visibility: v(s.visibility, at0),
    freshSnow: fresh,
  };
}

/** Dew point (°C) from temperature and relative humidity (Magnus). */
export function dewPoint(temperature: number, humidity: number): number {
  const g = Math.log(Math.max(1, humidity) / 100) + (17.62 * temperature) / (243.12 + temperature);
  return (243.12 * g) / (17.62 - g);
}

/** Lifting condensation level (m above the point): ~125 m per °C of dew-point spread. */
export function condensationHeight(temperature: number, humidity: number): number {
  return Math.max(0, 125 * (temperature - dewPoint(temperature, humidity)));
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

/** How far into a layer counts as being in it (m): its edges are soft. */
const EDGE = 40;

/**
 * The conditions at `altitude` (m) from a point's values there and the cloud deck over it
 * (null: none). Visibility, cloud and flat light are derived: fog from the deck, whiteout
 * from cloud, snow and wind (the archive has no visibility).
 */
export function deriveConditions(
  s: Sample,
  layer: CloudLayer | null,
  altitude: number,
): Conditions {
  const temperature = s.temperature;
  const humidity = Math.min(100, Math.max(0, s.humidity));
  // ERA5's 10 m mean wind is damped by the mountains' roughness (a storm's 130 km/h gusts
  // over a 15 km/h mean), so the mean on the slopes is taken as at least half the gusts.
  const gusts = s.gusts / 3.6;
  const wind = Math.max(Math.hypot(s.windX, s.windY) / 3.6, gusts / GUST_FACTOR);
  const windFrom = ((Math.atan2(s.windX, s.windY) * 180) / Math.PI + 360) % 360;

  // The deck: in it between its base and top; above it, it's a sea of cloud below you and
  // takes nothing from the sky.
  const deck = layer && layer.cover > 0.02 ? layer : null;
  const inside = deck
    ? smoothstep(deck.base - EDGE, deck.base + EDGE, altitude) *
      (1 - smoothstep(deck.top - EDGE, deck.top + EDGE, altitude))
    : 0;
  const under = deck ? 1 - smoothstep(deck.top - EDGE, deck.top + 3 * EDGE, altitude) : 1;
  const midDeck = deck?.mid ?? 0;
  const cloudLow = clamp01(s.cloudLow / 100) * (deck ? lerp(under, 1, midDeck) : 1);
  const cloudMid = clamp01(s.cloudMid / 100) * (deck ? lerp(1, under, midDeck) : 1);
  const cloudHigh = clamp01(s.cloudHigh / 100);
  const cloud = 1 - (1 - cloudLow) * (1 - cloudMid) * (1 - cloudHigh);

  // Above a low deck nothing falls on you unless deeper cloud overhead is making it.
  const precipRate = Math.max(0, s.precipitation) * (deck ? Math.max(under, cloudMid) : 1);
  const snowShare = snowFraction(temperature);
  // Open-Meteo's own ratio: 1 mm of water is 0.7 cm of snow.
  const snowRate = precipRate * snowShare * 0.7;
  const rainRate = precipRate * (1 - snowShare);
  const precipitation: Precipitation =
    precipRate < 0.05 ? 'none' : snowShare > 0.85 ? 'snow' : snowShare < 0.15 ? 'rain' : 'sleet';

  // In the cloud: a broken deck is patchy, so only partly.
  const inCloud = deck ? inside * smoothstep(0.25, 0.8, deck.cover) : 0;
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
    cloudBase: deck ? deck.base : NaN,
    cloudTop: deck ? deck.top : NaN,
    cloudCover: deck ? deck.cover : 0,
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
