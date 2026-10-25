import { describe, expect, it } from 'vitest';

import { COCKPITS, needle } from './aircraft-cockpit';
import { AIRCRAFT_TYPES } from './aircraft-types';

const deg = (rad: number) => (rad * 180) / Math.PI;

describe('cockpit gauges', () => {
  it('sweeps the airspeed needle round 300° for 0–300 km/h, pinned past the ends', () => {
    expect(deg(needle.airspeed(0))).toBeCloseTo(-150);
    expect(deg(needle.airspeed(150 / 3.6))).toBeCloseTo(0);
    expect(deg(needle.airspeed(400 / 3.6))).toBeCloseTo(150);
  });

  it('turns the altimeter hundreds needle once per 1,000 m, the thousands once per 10,000 m', () => {
    const a = needle.altimeter(2250);
    expect(deg(a.hundreds)).toBeCloseTo(90);
    expect(deg(a.thousands)).toBeCloseTo(81);
  });

  it('reads vertical speed from 9 o’clock: up is clockwise, pinned at ±10 m/s', () => {
    expect(deg(needle.vsi(0))).toBeCloseTo(-90);
    expect(deg(needle.vsi(5))).toBeCloseTo(-5);
    expect(deg(needle.vsi(-20))).toBeCloseTo(-260);
  });

  it('shows power and revs round 270°', () => {
    expect(deg(needle.power(0))).toBeCloseTo(-135);
    expect(deg(needle.power(1.2))).toBeCloseTo(135);
    expect(deg(needle.rotor(1))).toBeGreaterThan(100);
  });

  it('has a cockpit for every type, its gauges on the panel', () => {
    for (const t of AIRCRAFT_TYPES) {
      const c = COCKPITS[t.id]!;
      expect(c).toBeDefined();
      const kinds = c.gauges.map((g) => g.kind);
      for (const k of ['airspeed', 'attitude', 'altimeter', 'vsi', 'power'])
        expect(kinds).toContain(k);
      for (const g of c.gauges) {
        expect(Math.abs(g.x) + c.dial).toBeLessThanOrEqual(c.panel.width / 2);
        expect(Math.abs(g.y) + c.dial).toBeLessThanOrEqual(c.panel.height / 2);
      }
    }
  });
});
