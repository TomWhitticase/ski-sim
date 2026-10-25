import { describe, expect, it } from 'vitest';

import { weatherWindLevel } from '../audio/levels';
import { CLEAR } from './weather';
import { loadChoice, sanitizeChoice, saveChoice, WeatherState } from './weather-control';
import { driftDensity, snowDensity, sunlitAt, windVelocity } from './weather-fx';
import { weatherLook } from './environment';

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

/** Open-Meteo's answer for the heights asked: snowing, every hour. */
async function openMeteo(url: string): Promise<Response> {
  const u = new URL(url);
  const start = Date.parse(`${u.searchParams.get('start_date')}T00:00:00Z`);
  const time = Array.from({ length: 72 }, (_, i) =>
    new Date(start + i * 3_600_000).toISOString().slice(0, 16),
  );
  const body = u.searchParams
    .get('latitude')!
    .split(',')
    .map(() => ({
      hourly: {
        time,
        temperature_2m: time.map(() => -6),
        relative_humidity_2m: time.map(() => 96),
        precipitation: time.map(() => 3),
        cloud_cover: time.map(() => 100),
        cloud_cover_low: time.map(() => 90),
      },
    }));
  return new Response(JSON.stringify(body));
}

/** A WeatherState on a fake sim, at 2026-10-24 12:00 UTC. */
function setup(store = memory(), fetcher = openMeteo) {
  const log = { dates: [] as string[], offsets: [] as number[], times: [] as number[], changed: 0 };
  const now = Date.parse('2026-10-24T12:00:00Z');
  const weather = new WeatherState(
    {
      resort: 'les-3-vallees',
      country: 'FR',
      plan: {
        grid: { nx: 2, ny: 1, west: -2000, south: 0, east: 2000, north: 0 },
        points: [
          { east: -2000, north: 0, elevation: 1500 },
          { east: 2000, north: 0, elevation: 2300 },
          { east: 0, north: 0, elevation: 3200 },
        ],
        profiles: [{ east: 0, north: 0 }],
      },
      latLon: (east, north) => ({ lat: 45.3 + north / 111_000, lon: 6.6 + east / 78_000 }),
      zone: 'Europe/Paris',
      utcOffsetHours: 1,
      defaultDate: '2026-02-15',
      setDate: (d, o) => {
        log.dates.push(d);
        log.offsets.push(o);
      },
      setTime: (s) => log.times.push(s),
      changed: () => log.changed++,
    },
    store,
    fetcher,
    () => now,
  );
  return { weather, log, store };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('weather choice', () => {
  it('keeps one choice per resort and rejects junk', () => {
    const store = memory();
    saveChoice(store, 'a', { mode: 'past', date: '2018-01-04' });
    saveChoice(store, 'b', { mode: 'live' });
    expect(loadChoice(store, 'a')).toEqual({ mode: 'past', date: '2018-01-04' });
    expect(loadChoice(store, 'b')).toEqual({ mode: 'live' });
    expect(loadChoice(store, 'c')).toEqual({ mode: 'clear' });
    expect(sanitizeChoice({ mode: 'past', date: '1900-01-01' })).toBeNull();
    expect(sanitizeChoice({ mode: 'past', date: 'yesterday' })).toBeNull();
    expect(sanitizeChoice({ mode: 'storm' })).toBeNull();
  });
});

describe('WeatherState', () => {
  it('a past day: sets the date with that day’s offset, fetches, and gives conditions', async () => {
    const { weather, log, store } = setup();
    weather.choose({ mode: 'past', date: '2018-07-04' });
    expect(weather.status).toBe('loading');
    expect(log.dates.at(-1)).toBe('2018-07-04');
    expect(log.offsets.at(-1)).toBe(2); // summer time in Paris
    await settle();
    expect(weather.status).toBe('ready');
    const c = weather.update(Date.parse('2018-07-04T10:00:00Z'), 2000, 0, 2300);
    expect(weather.layerAt(0, 0)).not.toBeNull();
    expect(c.precipitation).toBe('snow');
    expect(loadChoice(store, 'les-3-vallees')).toEqual({ mode: 'past', date: '2018-07-04' });
  });

  it('live: today in the resort, the clock set to now and real time', async () => {
    const { weather, log } = setup();
    weather.choose({ mode: 'live' });
    expect(log.dates.at(-1)).toBe('2026-10-24');
    expect(log.times.at(-1)).toBe(14 * 3600); // 12:00 UTC is 14:00 in Paris in October
    await settle();
    expect(weather.day?.source).toBe('forecast');
  });

  it('clear: back to the bluebird day with no data', async () => {
    const { weather, log } = setup();
    weather.choose({ mode: 'past', date: '2018-01-04' });
    await settle();
    weather.choose({ mode: 'clear' });
    expect(weather.day).toBeNull();
    expect(weather.conditions).toBe(CLEAR);
    expect(log.dates.at(-1)).toBe('2026-02-15');
  });

  it('falls back to clear skies with a message when the fetch fails', async () => {
    const { weather } = setup(memory(), () => Promise.reject(new TypeError('offline')));
    weather.choose({ mode: 'past', date: '2018-01-04' });
    await settle();
    expect(weather.status).toBe('error');
    expect(weather.message).toContain('showing clear skies');
    expect(weather.update(0, 0, 0, 2000)).toBe(CLEAR);
  });

  it('a guest follows the host (no fetch, nothing saved) and gets its own back after', async () => {
    const host = setup();
    host.weather.choose({ mode: 'past', date: '2018-01-04' });
    await settle();
    let fetched = 0;
    const store = memory();
    saveChoice(store, 'les-3-vallees', { mode: 'clear' });
    const guest = setup(store, (url) => {
      fetched++;
      return openMeteo(url);
    });
    // Over the wire, NaN becomes null.
    guest.weather.follow(JSON.parse(JSON.stringify(host.weather.shared())));
    expect(fetched).toBe(0);
    expect(guest.weather.date).toBe('2018-01-04');
    expect(guest.log.dates.at(-1)).toBe('2018-01-04');
    expect(guest.weather.status).toBe('ready');
    expect(Number.isNaN(guest.weather.day!.sites[0]!.visibility[0])).toBe(true);
    // A day from an older build isn't one.
    guest.weather.follow({
      choice: { mode: 'past', date: '2018-01-04' },
      date: '2018-01-04',
      day: { levels: [] } as never,
    });
    expect(guest.weather.day).toBeNull();
    // The guest can't choose while following.
    guest.weather.choose({ mode: 'live' });
    expect(guest.weather.choice.mode).toBe('past');
    expect(loadChoice(store, 'les-3-vallees')).toEqual({ mode: 'clear' });
    guest.weather.stopFollowing();
    expect(guest.weather.choice).toEqual({ mode: 'clear' });
  });
});

describe('weather effects', () => {
  it('blows downwind: a west wind pushes east', () => {
    const v = windVelocity(10, 270);
    expect(v.x).toBeCloseTo(10);
    expect(v.z).toBeCloseTo(0);
    // From the north: toward the south, which is +z.
    expect(windVelocity(10, 0).z).toBeCloseTo(10);
  });

  it('draws more snow the harder it falls, and drift only near the ground', () => {
    expect(snowDensity({ ...CLEAR, snowRate: 0 })).toBe(0);
    expect(snowDensity({ ...CLEAR, snowRate: 0.5 })).toBeLessThan(
      snowDensity({ ...CLEAR, snowRate: 2 }),
    );
    expect(snowDensity({ ...CLEAR, snowRate: 6 })).toBe(1);
    expect(driftDensity({ ...CLEAR, drift: 1 }, 2)).toBe(1);
    expect(driftDensity({ ...CLEAR, drift: 1 }, 100)).toBe(0);
  });

  it('lets the sun through a broken sky about (1 - cover) of the time', () => {
    expect(sunlitAt(0, 123)).toBe(1);
    for (const cover of [0.3, 0.6]) {
      let lit = 0;
      for (let t = 0; t < 3000; t++) lit += sunlitAt(cover, t);
      expect(lit / 3000).toBeGreaterThan(1 - cover - 0.2);
      expect(lit / 3000).toBeLessThan(1 - cover + 0.2);
    }
  });

  it('looks bluebird when clear, flat and foggy in a whiteout', () => {
    const clear = weatherLook(CLEAR);
    expect(clear.sun).toBe(1);
    expect(clear.dome).toBe(0);
    expect(clear.flat).toBe(0);
    expect(clear.fogDensity).toBeCloseTo(0.000011);
    const whiteout = weatherLook({
      ...CLEAR,
      overcast: 1,
      whiteout: 1,
      inCloud: 1,
      visibility: 50,
    });
    expect(whiteout.sun).toBe(0);
    expect(whiteout.flat).toBe(1);
    expect(whiteout.dome).toBe(1);
    expect(whiteout.ambient).toBeGreaterThan(2);
    // 2 % contrast left at the visibility.
    expect(Math.exp(-((whiteout.fogDensity * 50) ** 2))).toBeCloseTo(0.02, 2);
  });

  it('makes the wind roar in a gale and whisper in a breeze', () => {
    expect(weatherWindLevel(0)).toBe(0);
    expect(weatherWindLevel(3)).toBeLessThan(0.05);
    expect(weatherWindLevel(25)).toBeCloseTo(0.55);
  });
});
