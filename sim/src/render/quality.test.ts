import { describe, expect, it } from 'vitest';

import { DESKTOP_QUALITY, qualityFor } from './quality';

describe('qualityFor', () => {
  it('leaves desktop exactly as it was', () => {
    expect(qualityFor(false, 2)).toEqual(DESKTOP_QUALITY);
    expect(qualityFor(false, 1)).toEqual({
      ...DESKTOP_QUALITY,
      maxPixelRatio: 1,
      minPixelRatio: 1,
    });
  });

  it('is lighter on a phone, whatever its pixel ratio', () => {
    const q = qualityFor(true, 3);
    expect(q.maxPixelRatio).toBe(1.5);
    expect(q.minPixelRatio).toBeLessThan(1);
    expect(q.antialias).toBe(false);
    expect(q.shadowMapSize).toBeLessThan(DESKTOP_QUALITY.shadowMapSize);
    expect(q.forestDistance).toBeLessThan(1);
    expect(qualityFor(true, 1).maxPixelRatio).toBe(1);
  });
});
