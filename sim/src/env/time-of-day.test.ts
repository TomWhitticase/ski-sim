import { describe, expect, it } from 'vitest';

import { simDate } from '../config';
import { daylight } from './environment';
import { sunPosition } from './sun-position';
import {
  DAY_SECONDS,
  dayPresets,
  formatTime,
  loadTime,
  saveTime,
  TIME_KEY,
  TimeOfDay,
} from './time-of-day';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

describe('TimeOfDay', () => {
  it('advances at its rate', () => {
    const clock = new TimeOfDay(10 * 3600, 60);
    clock.advance(2);
    expect(clock.seconds).toBe(10 * 3600 + 120);
    clock.rate = 1;
    clock.advance(0.5);
    expect(clock.seconds).toBe(10 * 3600 + 120.5);
  });

  it('stands still when paused', () => {
    const clock = new TimeOfDay(3600, 0);
    clock.advance(100);
    expect(clock.seconds).toBe(3600);
  });

  it('wraps at midnight both ways', () => {
    const clock = new TimeOfDay(DAY_SECONDS - 30, 600);
    clock.advance(0.1);
    expect(clock.seconds).toBeCloseTo(30);
    clock.set(-60);
    expect(clock.seconds).toBe(DAY_SECONDS - 60);
    clock.set(DAY_SECONDS * 3 + 5);
    expect(clock.seconds).toBe(5);
  });

  it('formats HH:MM', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(7 * 3600 + 5 * 60 + 59)).toBe('07:05');
    expect(formatTime(DAY_SECONDS - 1)).toBe('23:59');
  });
});

describe('time persistence', () => {
  it('round-trips time and rate', () => {
    const storage = memory();
    saveTime(storage, new TimeOfDay(18 * 3600, 600));
    const loaded = loadTime(storage, 0);
    expect(loaded.seconds).toBe(18 * 3600);
    expect(loaded.rate).toBe(600);
  });

  it('falls back on missing or bad data', () => {
    const storage = memory();
    expect(loadTime(storage, 11 * 3600).seconds).toBe(11 * 3600);
    expect(loadTime(storage, 11 * 3600).rate).toBe(1);
    storage.setItem(TIME_KEY, '{"seconds":"noon","rate":7}');
    expect(loadTime(storage, 3600)).toMatchObject({ seconds: 3600, rate: 1 });
    storage.setItem(TIME_KEY, 'not json');
    expect(loadTime(storage, 3600).seconds).toBe(3600);
  });
});

describe('dayPresets', () => {
  // Val Thorens, 15 Feb 2026: solar noon ≈ 12:48 CET, sunrise ≈ 07:35, sunset ≈ 18:00.
  const elevation = (t: number) => sunPosition(simDate(t), 45.2981, 6.5803).elevation;
  const presets = Object.fromEntries(dayPresets(elevation).map((p) => [p.name, p.seconds / 3600]));

  it('places the day around the real sun', () => {
    expect(presets.Midday).toBeCloseTo(12.8, 0);
    expect(presets.Sunrise).toBeGreaterThan(7.5);
    expect(presets.Sunrise).toBeLessThan(8.5);
    expect(presets.Sunset).toBeGreaterThan(17.3);
    expect(presets.Sunset).toBeLessThan(18);
    expect(presets.Morning).toBeGreaterThan(presets.Sunrise!);
    expect(presets.Afternoon).toBeLessThan(presets.Sunset!);
    expect(elevation(presets.Night! * 3600)).toBeLessThan(-20);
  });

  it('puts the sun just above the horizon at sunrise and sunset', () => {
    expect(elevation(presets.Sunrise! * 3600)).toBeCloseTo(3, 0);
    expect(elevation(presets.Sunset! * 3600)).toBeCloseTo(3, 0);
  });

  it('copes with a sun that never sets', () => {
    const names = dayPresets(() => 20).map((p) => p.name);
    expect(names).toContain('Sunrise');
  });
});

describe('daylight', () => {
  it('is full sun by day, no sun but some sky light at night', () => {
    expect(daylight(30).sun).toBeCloseTo(3.2);
    expect(daylight(30).ambient).toBeCloseTo(0.9);
    expect(daylight(-20).sun).toBe(0);
    expect(daylight(-20).ambient).toBeGreaterThan(0.1);
  });

  it('calls for headlights from around sunset, not in the day', () => {
    expect(daylight(20).dark).toBe(0);
    expect(daylight(4).dark).toBe(0);
    expect(daylight(0).dark).toBeGreaterThan(0.3);
    expect(daylight(-3).dark).toBe(1);
  });

  it('switches the floodlights on at dusk', () => {
    expect(daylight(20).floodlights).toBe(0);
    expect(daylight(0).floodlights).toBeCloseTo(0.5);
    expect(daylight(-10).floodlights).toBe(1);
  });

  it('fades smoothly through dusk', () => {
    let prev = Infinity;
    for (let e = 40; e >= -20; e -= 1) {
      const { sun, ambient } = daylight(e);
      expect(sun + ambient).toBeLessThanOrEqual(prev + 1e-9);
      prev = sun + ambient;
    }
  });
});
