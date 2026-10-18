import { describe, expect, it } from 'vitest';

import type { Lift, Peak } from '../features/types';
import { liftLabel, peakLabel } from './labels';

const support = (east: number, top: number) => ({
  east,
  north: 0,
  ground: top - 10,
  top,
  kind: 'tower' as const,
});

describe('liftLabel', () => {
  it('anchors above the point half way along the line', () => {
    const lift: Lift = {
      id: 1,
      name: 'Moraine',
      type: 'gondola',
      gauge: 6,
      length: 400,
      vertical: 100,
      // Uneven spans: half way (200 m) falls inside the second span.
      supports: [support(0, 2000), support(100, 2050), support(400, 2100)],
    };
    const label = liftLabel(lift)!;
    expect(label.detail).toBe('Gondola');
    expect(label.position.x).toBeCloseTo(200);
    expect(label.position.y).toBeCloseTo(2050 + 50 / 3 + 12);
  });

  it('skips unnamed lifts', () => {
    expect(liftLabel({ name: null, supports: [] } as unknown as Lift)).toBeNull();
  });
});

describe('peakLabel', () => {
  const extent = { west: -1000, east: 1000, south: -1000, north: 1000 };
  const peak: Peak = { id: 1, name: 'Cime de Caron', ele: 3195, east: 0, north: 500, ground: 3192 };

  it('shows the published elevation and ranks local peaks first', () => {
    const local = peakLabel(peak, extent);
    expect(local.detail).toBe('3,195 m');
    expect(local.position.z).toBe(-500);
    const distant = peakLabel({ ...peak, east: 50_000, ele: 4807 }, extent);
    expect(distant.tier).toBeGreaterThan(local.tier);
    expect(distant.maxDistance).toBeGreaterThan(local.maxDistance);
  });
});
