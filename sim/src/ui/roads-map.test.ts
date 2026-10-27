import { describe, expect, it } from 'vitest';

import { roadPx, roadRank, roadShown } from './roads-map';

describe('road map styles', () => {
  it('ranks main roads above streets, service roads and tracks', () => {
    expect(roadRank('motorway')).toBe(0);
    expect(roadRank('secondary_link')).toBe(roadRank('secondary'));
    expect(roadRank('residential')).toBeLessThan(roadRank('service'));
    expect(roadRank('service')).toBeLessThan(roadRank('track'));
  });

  it('shows main roads at every zoom and minor ones closer in', () => {
    const at = (cls: Parameters<typeof roadRank>[0], winter: 'cleared' | 'snow', mpp: number) =>
      roadShown({ class: cls, winter }, mpp);
    expect(at('primary', 'cleared', 40)).toBe(true);
    expect(at('residential', 'cleared', 40)).toBe(false);
    expect(at('residential', 'cleared', 8)).toBe(true);
    expect(at('service', 'cleared', 8)).toBe(false);
    expect(at('track', 'snow', 8)).toBe(false);
    expect(at('track', 'snow', 3)).toBe(true);
    // A pass road closed in winter still shows from further out than a track.
    expect(at('tertiary', 'snow', 15)).toBe(true);
  });

  it('draws a road at its ground width zoomed in, never thinner than its rank', () => {
    expect(roadPx(1, 7.5, 1)).toBeCloseTo(7.5);
    expect(roadPx(1, 7.5, 20)).toBeGreaterThanOrEqual(2.6);
    expect(roadPx(6, 3, 20)).toBe(1);
  });
});
