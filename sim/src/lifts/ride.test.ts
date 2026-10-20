import { PerspectiveCamera } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import type { Input } from '../controls/input';
import type { SkiControls } from '../controls/ski-controls';
import type { Lift } from '../features/types';
import { LiftSystem } from './lift-system';
import { RideControls } from './ride';

const terminal = (end: 'bottom' | 'top', north: number, dirN: number, pad: number) => ({
  end,
  kind: 'chair' as const,
  detachable: true,
  east: 0,
  north,
  dir: [0, dirN] as [number, number],
  across: [1, 0] as [number, number],
  gauge: 5,
  length: 16,
  back: 4.5,
  width: 10,
  load: 5,
  unload: 4,
  pad,
  ramp: null,
});
const s = (north: number, ground: number, kind: 'station' | 'tower') => ({
  east: 0,
  north,
  ground,
  top: ground + 8,
  kind,
});
const chair = {
  id: 1,
  name: 'Test',
  type: 'chair_lift',
  gauge: 5,
  length: 1000,
  vertical: 300,
  supports: [s(0, 2000, 'station'), s(500, 2150, 'tower'), s(1000, 2300, 'station')],
  occupancy: 6,
  capacity: 3000,
  duration: 250,
  terminals: [terminal('bottom', 0, 1, 2000), terminal('top', 1000, -1, 2300)],
} as Lift;

const ground = (_x: number, z: number) => 2000 + (300 * Math.min(Math.max(-z, 0), 1000)) / 1000;
const skier = {
  view: 'first-person',
  groundAt: ground,
  showRiding: () => {},
} as unknown as SkiControls;
/** Input with only W held (or nothing). */
const holding = (w: boolean) =>
  ({
    mouseX: 0,
    mouseY: 0,
    down: (...codes: string[]) => w && codes.includes('KeyW'),
    wasPressed: () => false,
  }) as unknown as Input;

describe('RideControls', () => {
  it('reports your real speed while fast-forwarding, so jumping off keeps it', () => {
    const lifts = new LiftSystem([chair], ground);
    const ride = new RideControls(new PerspectiveCamera(), lifts, skier);
    ride.approach(0);
    const dt = 1 / 60;
    const frame = (w: boolean) => {
      lifts.update(dt);
      return ride.update(dt, holding(w));
    };
    for (let i = 0; i < 60 * 60 && ride.phase !== 'riding'; i++) frame(false);
    expect(ride.phase).toBe('riding');
    // Out of the station onto the line, then hold W.
    for (let i = 0; i < 60 * 20; i++) frame(false);
    const speed = lifts.lines[0]!.op.speed;
    expect(ride.velocity.length()).toBeCloseTo(speed, 0);
    for (let i = 0; i < 30; i++) frame(true);
    expect(lifts.rate).toBeGreaterThan(1);
    expect(ride.velocity.length()).toBeCloseTo(speed, 0);
    frame(false); // letting go of W: no spike either
    expect(ride.velocity.length()).toBeCloseTo(speed, 0);
  });
});
