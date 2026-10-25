import { describe, expect, it } from 'vitest';

import {
  bearingDelta,
  formatAltitude,
  formatHeading,
  formatLatitude,
  formatLongitude,
  formatPower,
  formatSpeed,
  formatVertical,
} from './hud';

describe('HUD formatting', () => {
  it('formats climb and sink with a sign, and power (reverse as REV)', () => {
    expect(formatVertical(3.24)).toBe('+3.2');
    expect(formatVertical(-0.96)).toBe('−1.0');
    expect(formatVertical(0.02)).toBe('0.0');
    expect(formatPower({ kind: 'plane', power: 0.755 })).toBe('76');
    expect(formatPower({ kind: 'plane', power: -0.5 })).toBe('REV');
    expect(formatPower({ kind: 'heli', power: 1.04 })).toBe('104');
  });

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

describe('compass', () => {
  it('formats a heading with the nearest of eight points', () => {
    expect(formatHeading(40)).toBe('040° NE');
    expect(formatHeading(359.7)).toBe('000° N');
    expect(formatHeading(-90)).toBe('270° W');
    expect(formatHeading(200)).toBe('200° S');
  });

  it('measures the signed turn from one bearing to another', () => {
    expect(bearingDelta(10, 350)).toBe(-20);
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(0, 180)).toBe(-180);
    expect(bearingDelta(90, 45)).toBe(-45);
  });
});
