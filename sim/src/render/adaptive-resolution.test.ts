import { describe, expect, it } from 'vitest';

import { AdaptiveResolution } from './adaptive-resolution';

function feed(ar: AdaptiveResolution, frameMs: number, seconds: number) {
  for (let t = 0; t < seconds * 1000; t += frameMs) ar.sample(frameMs);
}

describe('AdaptiveResolution', () => {
  it('stays at full resolution while frames are fast', () => {
    const ar = new AdaptiveResolution(2);
    feed(ar, 16.7, 10);
    expect(ar.ratio).toBe(2);
  });

  it('steps down while slow, never below the minimum', () => {
    const ar = new AdaptiveResolution(2);
    feed(ar, 40, 2.1);
    expect(ar.ratio).toBe(1.5);
    feed(ar, 40, 20);
    expect(ar.ratio).toBe(1);
  });

  it('recovers when there is headroom, but not straight back to a ratio that was too slow', () => {
    const ar = new AdaptiveResolution(2);
    feed(ar, 40, 1.05); // 2 -> 1.75; 2 is now off limits for a while
    expect(ar.ratio).toBe(1.75);
    feed(ar, 10, 5);
    expect(ar.ratio).toBe(1.75);
    feed(ar, 10, 20); // hold expires
    expect(ar.ratio).toBe(2);
  });
});
