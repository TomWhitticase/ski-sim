import { describe, expect, it } from 'vitest';

import { screenshotName } from './screenshot';

describe('screenshotName', () => {
  it('names the shot by resort, pose and local time', () => {
    const name = screenshotName(
      {
        resort: 'les-3-vallees',
        lat: 45.295119,
        lon: 6.577488,
        altitude: 2256.4,
        heading: 107.6,
        pitch: -5.2,
      },
      new Date(2026, 9, 24, 10, 31, 2),
    );
    expect(name).toBe(
      'ski-sim_les-3-vallees_45.29512,6.57749,2256_h108_p-5_2026-10-24_10-31-02.png',
    );
  });
});
