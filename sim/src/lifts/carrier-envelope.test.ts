import { describe, expect, it } from 'vitest';
import {
  carrierEnvelope,
  carrierShortfalls,
  ropeAlong,
  staticChecks,
} from '../../scripts/station-checks.mjs';
import type { Lift } from '../features/types';
import { cabinLayout, CHAIR_SEAT_HEIGHT, floorBelowGrip } from './carriers';
import { operation } from './operation';
import { ropeHeight } from './rope';

// The station audit's carrier check (and the pipeline's `carrier_clearance.py`) must use
// the carriers the sim draws.
const lift = (type: string, occupancy: number) =>
  ({ type, occupancy, supports: [], terminals: [], gauge: 6 }) as unknown as Lift;

describe('station audit carrier envelope', () => {
  it.each([
    ['gondola', 8],
    ['gondola', 10],
    ['cable_car', 150],
    ['cable_car', 60],
  ])('%s for %d matches the cabin the sim draws', (type, seats) => {
    const op = operation(lift(type, seats));
    const kind = op.kind as 'gondola' | 'cabin';
    const c = cabinLayout(kind, seats, op.hang);
    const env = carrierEnvelope({ type, occupancy: seats })!;
    expect(env.depth).toBeCloseTo(-c.floor + 0.08, 5); // under the floor slab
    expect(env.halfLength).toBeCloseTo(c.d / 2, 5);
    expect(env.halfWidth).toBeCloseTo(c.w / 2, 5);
    // At the platform the floor is level with it (within the slab).
    expect(env.depth - floorBelowGrip(kind, seats, op.hang)).toBeLessThan(0.1);
  });

  it('a chair reaches below its seat to the rider’s skis, about platform height', () => {
    const op = operation(lift('chair_lift', 4));
    const env = carrierEnvelope({ type: 'chair_lift', occupancy: 4 })!;
    expect(env.depth).toBeGreaterThan(op.hang + 0.2); // the footrest
    expect(env.depth).toBeCloseTo(floorBelowGrip('chair', 4, op.hang), 1);
    expect(env.depth).toBeGreaterThan(op.hang - 0.05 + CHAIR_SEAT_HEIGHT - 0.1);
    expect(carrierEnvelope({ type: 't-bar' })).toBeNull();
  });

  it('hangs on the same sagging rope as the sim', () => {
    const a = { east: 0, north: 0, top: 2000, exit: [0, 18] as [number, number] };
    const b = { east: 0, north: 1018, top: 2400 };
    for (const d of [0, 10, 18, 300, 518, 1018]) {
      const u = Math.max(0, (d - 18) / 1000);
      expect(ropeAlong(a, b, d, 4000)).toBeCloseTo(ropeHeight(2000, 2400, 4000, 1000, u), 6);
    }
  });

  it('flags a cabin arriving through the rock below a cliff-top station', () => {
    // A cable car up a 31° rope into a hall whose apron is at the pad, as Cime Caron was.
    const tan = Math.tan((31 * Math.PI) / 180);
    const terminal = (end: string, north: number, pad: number, d: number) => ({
      end,
      kind: 'cabin',
      east: 0,
      north,
      dir: [0, d],
      across: [1, 0],
      length: 18,
      back: 3,
      width: 14,
      pad,
    });
    const top = terminal('top', 1018, 2000 + 1000 * tan, -1);
    const cable = {
      type: 'cable_car',
      occupancy: 150,
      gauge: 8,
      catenary: null,
      terminals: [terminal('bottom', 0, 2000, 1), top],
      supports: [
        { east: 0, north: 0, ground: 2000, top: 2007.45, kind: 'station', exit: [0, 18] },
        {
          east: 0,
          north: 1018,
          ground: top.pad,
          top: top.pad + 7.45,
          kind: 'station',
          exit: [0, 1000],
        },
      ],
    };
    // The rope's own slope, but the ground levels off to the pad 20 m short of the hall.
    const ground = (_e: number, n: number) =>
      n < 18 ? 2000 : n > 980 ? top.pad : 2000 + (n - 18) * tan - 7.53 - 1.5;
    expect(carrierShortfalls(cable, ground).some((p) => p.end === 'top' && p.shortfall > 1)).toBe(
      true,
    );
    const problems = staticChecks(cable, top, { ground });
    expect(problems.some((p) => p.startsWith('carrier'))).toBe(true);
    // ...and nothing when the ground falls away under the arrival.
    const clear = (_e: number, n: number) => (n < 18 ? 2000 : n > 1000 ? top.pad : 1990);
    expect(staticChecks(cable, top, { ground: clear })).toEqual([]);
  });
});
