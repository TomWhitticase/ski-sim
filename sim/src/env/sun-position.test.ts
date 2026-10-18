import { describe, expect, it } from 'vitest';

import { sunPosition } from './sun-position';

describe('sunPosition', () => {
  // Val Thorens, 15 Feb 2026. Declination ≈ -12.6°, equation of time ≈ -14.2 min,
  // so solar noon is ≈ 11:48 UTC and the noon elevation ≈ 90 - 45.3 - 12.6 ≈ 32.1°.
  const lat = 45.2981;
  const lon = 6.5803;

  it('puts the sun due south at its highest around solar noon', () => {
    const noon = sunPosition(new Date('2026-02-15T11:48:00Z'), lat, lon);
    expect(noon.azimuth).toBeCloseTo(180, 0);
    expect(noon.elevation).toBeCloseTo(32.1, 0);
  });

  it('has the sun in the south-east in the morning', () => {
    const morning = sunPosition(new Date('2026-02-15T09:00:00Z'), lat, lon);
    expect(morning.azimuth).toBeGreaterThan(120);
    expect(morning.azimuth).toBeLessThan(150);
    expect(morning.elevation).toBeGreaterThan(15);
    expect(morning.elevation).toBeLessThan(25);
  });

  it('is below the horizon at night', () => {
    expect(sunPosition(new Date('2026-02-15T23:00:00Z'), lat, lon).elevation).toBeLessThan(0);
  });
});
