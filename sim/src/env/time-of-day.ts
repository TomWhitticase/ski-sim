// The sim clock: a time of day that runs at a chosen rate and wraps at midnight.

export const DAY_SECONDS = 86_400;

/** Selectable clock rates (sim seconds per real second). 0 = paused. */
export const TIME_RATES = [0, 1, 10, 60, 600] as const;

export const TIME_KEY = 'ski-sim.time-of-day';

const wrap = (seconds: number) => ((seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;

export class TimeOfDay {
  private t: number;

  constructor(
    seconds: number,
    /** Sim seconds per real second. */
    public rate = 1,
  ) {
    this.t = wrap(seconds);
  }

  /** Seconds since local midnight, in [0, 86400). */
  get seconds(): number {
    return this.t;
  }

  set(seconds: number): void {
    this.t = wrap(seconds);
  }

  advance(dt: number): void {
    if (this.rate !== 0 && dt > 0) this.t = wrap(this.t + dt * this.rate);
  }
}

/** "HH:MM", rounded down to the minute. */
export function formatTime(seconds: number): string {
  const minutes = Math.floor(wrap(seconds) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function formatRate(rate: number): string {
  return rate === 0 ? 'Paused' : rate === 1 ? 'Real time' : `×${rate}`;
}

export function loadTime(storage: Pick<Storage, 'getItem'>, fallbackSeconds: number): TimeOfDay {
  try {
    const raw = JSON.parse(storage.getItem(TIME_KEY) ?? 'null') as {
      seconds?: unknown;
      rate?: unknown;
    } | null;
    const seconds = Number.isFinite(raw?.seconds) ? (raw!.seconds as number) : fallbackSeconds;
    const rate = TIME_RATES.includes(raw?.rate as never) ? (raw!.rate as number) : 1;
    return new TimeOfDay(seconds, rate);
  } catch {
    return new TimeOfDay(fallbackSeconds);
  }
}

export function saveTime(storage: Pick<Storage, 'setItem'>, clock: TimeOfDay): void {
  storage.setItem(
    TIME_KEY,
    JSON.stringify({ seconds: Math.round(clock.seconds), rate: clock.rate }),
  );
}

export interface TimePreset {
  name: string;
  seconds: number;
}

/**
 * Presets for the day, from the sun's elevation (degrees) at a time of day: sunrise and
 * sunset when the sun is just clear of the horizon, midday at its highest, morning and
 * afternoon halfway between. Falls back to fixed times if the sun never rises or sets.
 */
export function dayPresets(elevationAt: (seconds: number) => number): TimePreset[] {
  const step = 300;
  let noon = 12 * 3600;
  for (let t = 0; t < DAY_SECONDS; t += step) {
    if (elevationAt(t) > elevationAt(noon)) noon = t;
  }
  // Bisect for the time the sun crosses `GOLDEN` degrees between a and b.
  const GOLDEN = 3;
  const cross = (a: number, b: number): number | null => {
    const above = (t: number) => elevationAt(t) > GOLDEN;
    if (above(a) === above(b)) return null;
    const rising = !above(a);
    for (let i = 0; i < 30; i++) {
      const mid = (a + b) / 2;
      if (above(mid) === rising) b = mid;
      else a = mid;
    }
    return (a + b) / 2;
  };
  const rise = cross(noon - DAY_SECONDS / 2, noon) ?? 8 * 3600;
  const set = cross(noon, noon + DAY_SECONDS / 2) ?? 17 * 3600;
  const presets = [
    { name: 'Sunrise', seconds: rise },
    { name: 'Morning', seconds: (rise + noon) / 2 },
    { name: 'Midday', seconds: noon },
    { name: 'Afternoon', seconds: (noon + set) / 2 },
    { name: 'Sunset', seconds: set },
    { name: 'Night', seconds: 22 * 3600 },
  ];
  // Round to the minute so the slider and label agree.
  return presets.map((p) => ({ ...p, seconds: wrap(Math.round(p.seconds / 60) * 60) }));
}
