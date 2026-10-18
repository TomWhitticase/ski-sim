import { describe, expect, it } from 'vitest';

import { atlasLayout } from './signs';

describe('atlasLayout', () => {
  it('stays within the GPU texture limit for any number of lifts', () => {
    for (const n of [1, 40, 135, 400, 2000]) {
      const { columns, rows, scale } = atlasLayout(n);
      expect(columns * rows).toBeGreaterThanOrEqual(n);
      expect(columns * 1024 * scale).toBeLessThanOrEqual(8192);
      expect(rows * 192 * scale).toBeLessThanOrEqual(8192);
    }
    expect(atlasLayout(135).scale).toBe(1); // a 3-valley resort needs no downscaling
  });
});
