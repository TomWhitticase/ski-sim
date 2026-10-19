import { describe, expect, it } from 'vitest';

import { formatAltitude, formatLatitude, formatLongitude, formatSpeed } from './hud';

describe('HUD formatting', () => {
  it('formats altitude in whole metres with separators', () => {
    expect(formatAltitude(2699.6)).toBe('2,700 m');
  });

  it('formats coordinates to ~1 m precision with hemisphere', () => {
    expect(formatLatitude(45.298104)).toBe('45.29810° N');
    expect(formatLongitude(6.58034)).toBe('6.58034° E');
    expect(formatLatitude(-33.5)).toBe('33.50000° S');
    expect(formatLongitude(-0.1)).toBe('0.10000° W');
  });

  it('converts m/s to km/h', () => {
    expect(formatSpeed(25)).toBe('90 km/h');
  });
});
