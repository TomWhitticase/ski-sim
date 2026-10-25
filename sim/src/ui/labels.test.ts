import { describe, expect, it } from 'vitest';

import type { Lift, Peak } from '../features/types';
import { aerodromeDetail, aerodromeLabel, liftIcon, liftLabel, peakLabel } from './labels';

const support = (east: number, top: number) => ({
  east,
  north: 0,
  ground: top - 10,
  top,
  kind: 'tower' as const,
});

describe('liftLabel', () => {
  it('anchors above the bottom end of the line when there is no terminal', () => {
    const lift: Lift = {
      id: 1,
      name: 'Moraine',
      type: 'gondola',
      gauge: 6,
      length: 400,
      vertical: 100,
      // Drawn top to bottom: the bottom is the last support.
      supports: [support(0, 2100), support(100, 2050), support(400, 2000)],
      terminals: [],
    };
    const label = liftLabel(lift)!;
    expect(label.detail).toBe('Gondola');
    expect(label.position.x).toBeCloseTo(400);
    expect(label.position.y).toBeCloseTo(2000 + 6); // cable height at the end
  });

  it('sits over the bottom station roof', () => {
    const terminal = {
      end: 'bottom',
      east: 10,
      north: 20,
      dir: [1, 0],
      length: 20,
      back: 4,
      pad: 1990,
      roofTop: 9,
    };
    const lift = {
      id: 2,
      name: 'Cascades',
      type: 'chair_lift',
      supports: [support(0, 2000), support(400, 2100)],
      terminals: [{ ...terminal, end: 'top', east: 999 }, terminal],
    } as unknown as Lift;
    const label = liftLabel(lift)!;
    expect(label.position.x).toBeCloseTo(10 + 8);
    expect(label.position.z).toBeCloseTo(-20);
    expect(label.position.y).toBeCloseTo(1990 + 9 + 6);
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
    const distant = peakLabel({ ...peak, east: 50_000, ele: 3600 }, extent);
    expect(distant.tier).toBeGreaterThan(local.tier);
    expect(distant.maxDistance).toBeGreaterThan(local.maxDistance);
    // ...except the great 4000 m+ summits on the horizon, which always win.
    const montBlanc = peakLabel({ ...peak, east: 50_000, ele: 4807 }, extent);
    expect(montBlanc.tier).toBeLessThan(local.tier);
    const tacul = peakLabel({ ...peak, east: 50_000, ele: 4248 }, extent);
    expect(montBlanc.tier).toBeLessThan(tacul.tier); // the higher giant wins an overlap
  });
});

describe('lift icons', () => {
  it('groups lift types into chair, gondola, cable car and drag icons', () => {
    expect(liftIcon('chair_lift')).toBe('chair');
    expect(liftIcon('gondola')).toBe('gondola');
    expect(liftIcon('mixed_lift')).toBe('gondola');
    expect(liftIcon('cable_car')).toBe('cable-car');
    for (const t of ['drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow', 'magic_carpet']) {
      expect(liftIcon(t)).toBe('drag');
    }
  });
});

describe('aerodromeLabel', () => {
  it('names the airfield over its runway, with the lifts (1)', () => {
    const label = aerodromeLabel({
      id: 1,
      name: 'Altiport de Courchevel',
      kind: 'airfield',
      icao: 'LFLJ',
      iata: 'CVF',
      east: 10,
      north: 20,
      ground: 1980,
      ele: 2006,
    });
    expect(label.kind).toBe('lift');
    expect(label.icon).toBe('airfield');
    expect(label.detail).toBe('Airfield · LFLJ · 2,006 m');
    expect(label.position.z).toBe(-20);
  });

  it('describes a heliport without a code', () => {
    expect(
      aerodromeDetail({
        id: 2,
        name: 'Héliport de Champlan',
        kind: 'heliport',
        icao: null,
        iata: null,
        east: 0,
        north: 0,
        ground: 1352.4,
        ele: null,
      }),
    ).toBe('Heliport · 1,352 m');
  });
});
