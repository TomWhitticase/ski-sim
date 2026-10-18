import { describe, expect, it } from 'vitest';

import { soundLevels } from '../audio/levels';
import { type SnowContact, skidAmount, sprayRate, trailWidth } from './intensity';

const base: SnowContact = { speed: 12, sideslip: 0, edge: 0, onSnow: true, groomed: true };
const gentleTurn = { ...base, sideslip: 0.5, edge: 0.15 };
const hardCarve = { ...base, speed: 18, sideslip: 0.8, edge: 0.9 };
const hockeyStop = { ...base, speed: 12, sideslip: 9, edge: -0.6 };

describe('snow intensity', () => {
  it('scales from barely anything in a gentle turn to a burst in a hockey stop', () => {
    expect(sprayRate(gentleTurn)).toBeLessThan(5);
    expect(sprayRate(hardCarve)).toBeGreaterThan(sprayRate(gentleTurn));
    expect(sprayRate(hockeyStop)).toBeGreaterThan(5 * sprayRate(hardCarve));
    expect(skidAmount(hockeyStop)).toBeGreaterThan(0.9);
  });

  it('throws nothing in the air and more in powder', () => {
    expect(sprayRate({ ...hockeyStop, onSnow: false })).toBe(0);
    expect(sprayRate({ ...hockeyStop, groomed: false })).toBeGreaterThan(sprayRate(hockeyStop));
  });

  it('leaves thin carve lines and wide skid smears', () => {
    expect(trailWidth(hardCarve)).toBeLessThan(0.12);
    expect(trailWidth(hockeyStop)).toBeGreaterThan(0.7);
  });
});

describe('soundLevels', () => {
  it('wind grows with speed; snow sounds only on the snow', () => {
    expect(soundLevels(30, null).wind).toBeGreaterThan(soundLevels(5, null).wind);
    expect(soundLevels(10, null).glide).toBe(0);
    expect(soundLevels(12, { ...hockeyStop, onSnow: false }).skid).toBe(0);
  });

  it('a hockey stop scrapes loudly; a gentle turn just hisses', () => {
    expect(soundLevels(12, hockeyStop).skid).toBeGreaterThan(0.6);
    expect(soundLevels(12, gentleTurn).skid).toBeLessThan(0.05);
    expect(soundLevels(12, gentleTurn).glide).toBeGreaterThan(0.1);
  });
});

describe('liftHumLevel', () => {
  it('is loud beside a station, silent far away, with a little rope noise when riding', async () => {
    const { liftHumLevel } = await import('../audio/levels');
    expect(liftHumLevel(5, false)).toBeGreaterThan(0.25);
    expect(liftHumLevel(500, false)).toBe(0);
    expect(liftHumLevel(500, true)).toBeGreaterThan(0);
  });
});
