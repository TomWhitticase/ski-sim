// The weather in play: what the player chose (Clear, Live or a past day), its data and the
// conditions where the camera is. Owns the per-resort choice in localStorage; the date and
// clock changes it implies go through `WeatherHost`.

import { localNow, zoneOffsetHours } from './time-of-day';
import { CLEAR, type Conditions, conditionsAt, type WeatherDay } from './weather';
import { FIRST_DATE, loadWeatherDay, reviveDay, type WeatherRequest } from './weather-source';

// Types, not interfaces: they travel as JSON in a control message (`net/session.ts`).
export type WeatherChoice =
  /** No weather: the bluebird default day. */
  | { mode: 'clear' }
  /** Today, now, as it is (Open-Meteo's forecast for the current hour). */
  | { mode: 'live' }
  /** A day in the past, at whatever time the clock says. */
  | { mode: 'past'; date: string };

/** What a party shares: the choice, the date it means, and the data (so guests fetch nothing). */
export type SharedWeather = { choice: WeatherChoice; date: string; day: WeatherDay | null };

export const WEATHER_KEY = 'ski-sim.weather';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A choice from storage or the network, or null if it isn't one. */
export function sanitizeChoice(x: unknown): WeatherChoice | null {
  const c = x as { mode?: unknown; date?: unknown } | null;
  if (c?.mode === 'clear' || c?.mode === 'live') return { mode: c.mode };
  if (c?.mode === 'past' && typeof c.date === 'string' && DATE.test(c.date) && c.date >= FIRST_DATE)
    return { mode: 'past', date: c.date };
  return null;
}

/** The saved choice for a resort (Clear if none). */
export function loadChoice(store: Pick<Storage, 'getItem'>, resort: string): WeatherChoice {
  try {
    const all = JSON.parse(store.getItem(WEATHER_KEY) ?? '{}') as Record<string, unknown>;
    return sanitizeChoice(all[resort]) ?? { mode: 'clear' };
  } catch {
    return { mode: 'clear' };
  }
}

export function saveChoice(
  store: Pick<Storage, 'getItem' | 'setItem'>,
  resort: string,
  choice: WeatherChoice,
): void {
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(store.getItem(WEATHER_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    /* start again */
  }
  all[resort] = choice;
  store.setItem(WEATHER_KEY, JSON.stringify(all));
}

/** What the weather needs from the sim. */
export interface WeatherHost {
  resort: string;
  lat: number;
  lon: number;
  /** Heights to fetch (m), bottom to top of the lifts. */
  elevations: number[];
  /** IANA zone of the resort, if known. */
  zone: string | null;
  /** UTC offset (hours) to fall back on without a zone. */
  utcOffsetHours: number;
  /** The bluebird default date (Clear). */
  defaultDate: string;
  /** Put the sim on this local date (sun, clock) with the zone's offset that day. */
  setDate(date: string, utcOffsetHours: number): void;
  /** Set the clock (seconds after local midnight), optionally its rate. */
  setTime(seconds: number, rate?: number): void;
  /** Something the menu shows changed (status, data, choice). */
  changed(): void;
}

export type WeatherStatus = 'off' | 'loading' | 'ready' | 'error';

export class WeatherState {
  choice: WeatherChoice = { mode: 'clear' };
  /** The local date the choice means (today for Live). */
  date: string;
  day: WeatherDay | null = null;
  status: WeatherStatus = 'off';
  /** Why there's no weather (an error), for the menu. */
  message = '';
  /** Where the camera is, refreshed by `update`. */
  conditions: Conditions = CLEAR;
  /** Bumped on every change of data, so the renderer can snap instead of easing. */
  version = 0;
  /** In a party as a guest: the host's weather, not ours. */
  following = false;
  private request = 0;

  constructor(
    private readonly host: WeatherHost,
    private readonly store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
    private readonly fetcher?: (url: string) => Promise<Response>,
    private readonly now: () => number = Date.now,
  ) {
    this.date = host.defaultDate;
  }

  /** Whether any weather is being shown (not Clear). */
  get on(): boolean {
    return this.choice.mode !== 'clear';
  }

  /** The resort's local date and time now. */
  today(): { date: string; seconds: number } {
    const utc = new Date(this.now()).toISOString().slice(0, 10);
    const offset = this.offsetOn(utc);
    return localNow(this.now(), offset);
  }

  private offsetOn(date: string): number {
    return (
      (this.host.zone ? zoneOffsetHours(this.host.zone, date) : null) ?? this.host.utcOffsetHours
    );
  }

  /** The player picked something (Weather tab, or the saved choice on load). */
  choose(choice: WeatherChoice, save = true): void {
    if (this.following) return;
    if (save) saveChoice(this.store, this.host.resort, choice);
    this.choice = choice;
    if (choice.mode === 'clear') {
      this.request++;
      this.setDay(this.host.defaultDate, null, 'off');
      return;
    }
    let date: string;
    if (choice.mode === 'live') {
      const now = this.today();
      date = now.date;
      this.host.setDate(date, this.offsetOn(date));
      this.host.setTime(now.seconds, 1);
    } else {
      date = choice.date > this.today().date ? this.today().date : choice.date;
      // Already showing (or getting) that day: nothing to do.
      if (date === this.date && (this.status === 'ready' || this.status === 'loading')) {
        this.host.changed();
        return;
      }
      this.host.setDate(date, this.offsetOn(date));
    }
    void this.fetch(date);
  }

  /** The saved choice for this resort. */
  restore(): void {
    this.choose(loadChoice(this.store, this.host.resort), false);
  }

  private async fetch(date: string): Promise<void> {
    const id = ++this.request;
    this.date = date;
    this.status = 'loading';
    this.message = '';
    this.host.changed();
    const request: WeatherRequest = {
      lat: this.host.lat,
      lon: this.host.lon,
      elevations: this.host.elevations,
      date,
      today: this.today().date,
    };
    try {
      const day = await loadWeatherDay(
        this.host.resort,
        request,
        this.fetcher,
        this.store,
        this.now(),
      );
      if (id !== this.request) return;
      this.setDay(date, day, 'ready');
    } catch (e) {
      if (id !== this.request) return;
      console.warn('[weather]', e);
      this.message = `${e instanceof Error ? e.message : String(e)} · showing clear skies`;
      this.setDay(date, null, 'error');
    }
  }

  private setDay(date: string, day: WeatherDay | null, status: WeatherStatus): void {
    if (status === 'off') this.host.setDate(date, this.offsetOn(date));
    this.date = date;
    this.day = day;
    this.status = status;
    if (!day) this.conditions = CLEAR;
    this.version++;
    this.host.changed();
  }

  /** What a party shares (host). */
  shared(): SharedWeather {
    return { choice: this.choice, date: this.date, day: this.day };
  }

  /** Guest: the host's weather (no fetching, nothing saved). */
  follow(w: SharedWeather): void {
    this.following = true;
    this.request++;
    this.choice = sanitizeChoice(w.choice) ?? { mode: 'clear' };
    const date = DATE.test(w.date) ? w.date : this.host.defaultDate;
    this.host.setDate(date, this.offsetOn(date));
    // NaN went over the wire as null.
    const day = w.day?.levels?.length ? reviveDay(w.day) : null;
    this.setDay(date, day, day ? 'ready' : this.on ? 'loading' : 'off');
  }

  /** Out of a party: back to your own weather. */
  stopFollowing(): void {
    if (!this.following) return;
    this.following = false;
    this.restore();
  }

  /** The conditions at `altitude` (m) at the instant `at` (ms UTC). */
  update(at: number, altitude: number): Conditions {
    if (this.day) this.conditions = conditionsAt(this.day, at, altitude);
    return this.conditions;
  }
}
