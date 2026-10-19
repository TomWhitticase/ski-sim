import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import type { SkiTerrain } from './ski-physics';
import {
  createSledState,
  SLED,
  type SledInput,
  type SledState,
  sledSurface,
  stepSled,
} from './snowmobile-physics';

const deg = (d: number) => (d * Math.PI) / 180;
const flat: SkiTerrain = { height: () => 1000 };
const powder: SkiTerrain = { height: () => 1000, groomed: () => false };
/** A plane rising `angle` toward the north (-z): yaw 0 points straight up it. */
const slope = (angle: number, groomed = true): SkiTerrain => ({
  height: (_x, z) => 1000 - Math.tan(deg(angle)) * z,
  groomed: () => groomed,
});

const throttle: SledInput = { throttle: 1, brake: false, steer: 0 };
const coast: SledInput = { throttle: 0, brake: false, steer: 0 };

function sled(terrain: SkiTerrain, speed = 0, yaw = 0): SledState {
  const s = createSledState(new Vector3(), yaw);
  s.position.y = sledSurface(terrain, 0, 0, yaw, new Vector3());
  s.velocity.set(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(speed);
  // Start moving along the surface.
  stepSled(s, coast, 1 / 120, terrain);
  return s;
}

function run(s: SledState, input: SledInput, seconds: number, terrain: SkiTerrain) {
  for (let t = 0; t < seconds; t += 1 / 60) stepSled(s, input, 1 / 60, terrain);
}

const kmh = (s: SledState) => s.velocity.length() * 3.6;

describe('stepSled', () => {
  it('tops out around 125 km/h on flat groomed snow', () => {
    const s = sled(flat);
    run(s, throttle, 40, flat);
    expect(kmh(s)).toBeGreaterThan(110);
    expect(kmh(s)).toBeLessThan(130);
  });

  it('gets to 100 km/h in about five to seven seconds', () => {
    const s = sled(flat);
    let t = 0;
    while (kmh(s) < 100 && t < 20) {
      stepSled(s, throttle, 1 / 60, flat);
      t += 1 / 60;
    }
    expect(t).toBeGreaterThan(4);
    expect(t).toBeLessThan(8);
  });

  it('is slower in powder than on the piste, and bogs down from a standstill', () => {
    const groomed = sled(flat);
    const deep = sled(powder);
    run(groomed, throttle, 3, flat);
    run(deep, throttle, 3, powder);
    expect(deep.velocity.length()).toBeLessThan(groomed.velocity.length() * 0.9);
    expect(deep.sink).toBeGreaterThan(groomed.sink);
    run(groomed, throttle, 40, flat);
    run(deep, throttle, 40, powder);
    expect(kmh(deep)).toBeLessThan(kmh(groomed) * 0.8);
    expect(kmh(deep)).toBeGreaterThan(60); // planing on top, not stuck
  });

  it('climbs a 20° slope from a standstill', () => {
    const hill = slope(20);
    const s = sled(hill);
    const start = s.position.y;
    run(s, throttle, 5, hill);
    const halfway = s.velocity.length();
    run(s, throttle, 5, hill);
    // Grip-limited (0.55 g against 0.34 g of slope): ~1.4 m/s², still speeding up.
    expect(s.position.y - start).toBeGreaterThan(18);
    expect(s.velocity.length()).toBeGreaterThan(halfway + 3);
  });

  it('just about creeps up a 25° piste from a standstill', () => {
    const hill = slope(25);
    const s = sled(hill);
    const start = s.position.y;
    run(s, throttle, 10, hill);
    expect(s.position.y - start).toBeGreaterThan(3);
  });

  it('carries momentum up a 33° powder face, then bogs down', () => {
    const face = slope(33, false);
    const s = sled(face, 25);
    const start = s.position.y;
    let top = start;
    for (let t = 0; t < 30; t += 1 / 60) {
      stepSled(s, throttle, 1 / 60, face);
      top = Math.max(top, s.position.y);
    }
    expect(top - start).toBeGreaterThan(15); // got a good way up on momentum
    expect(s.velocity.y).toBeLessThan(0.1); // but can't keep climbing
    run(s, coast, 3, face);
    expect(s.velocity.y).toBeLessThan(-1); // off the throttle it slides back down
  });

  it("can't climb a 40° slope: the track spins and the sled slides back", () => {
    const wall = slope(40);
    const s = sled(wall);
    const start = s.position.y;
    run(s, throttle, 4, wall);
    expect(s.position.y).toBeLessThan(start - 1);
    expect(s.slip).toBeGreaterThan(0.5);
    expect(s.rpm).toBeGreaterThan(SLED.engageRpm);
  });

  it('holds on a moderate slope with the brake, and rolls back without it', () => {
    const hill = slope(15);
    const held = sled(hill);
    run(held, { ...coast, brake: true }, 5, hill);
    expect(held.velocity.length()).toBeLessThan(0.05);
    const rolled = sled(hill);
    run(rolled, coast, 5, hill);
    expect(rolled.velocity.dot(new Vector3(0, 0, 1))).toBeGreaterThan(2); // backwards (south)
  });

  it('turns tightly at walking pace and wider at speed', () => {
    const radius = (speed: number) => {
      const s = sled(flat, speed);
      // Hold the speed steady on the throttle while turning on full lock.
      const hold = () => ({
        throttle: s.velocity.length() < speed ? 1 : 0,
        brake: false,
        steer: 1,
      });
      for (let t = 0; t < 2; t += 1 / 120) stepSled(s, hold(), 1 / 120, flat);
      const yaw = s.yaw;
      for (let t = 0; t < 1; t += 1 / 120) stepSled(s, hold(), 1 / 120, flat);
      return speed / (s.yaw - yaw);
    };
    const slow = radius(3);
    expect(slow).toBeGreaterThan(3);
    expect(slow).toBeLessThan(8);
    const fast = radius(25);
    expect(fast).toBeGreaterThan(60);
    expect(fast).toBeLessThan(300);
  });

  it('leaning into the turn tightens it at speed', () => {
    const turn = (lean: number) => {
      const s = sled(flat, 20);
      run(s, { throttle: 0.2, brake: false, steer: 1, lean }, 1.5, flat);
      return s.yaw;
    };
    expect(turn(1)).toBeGreaterThan(turn(0) * 1.15);
  });

  it('brakes from 70 km/h to a stop within ~45 m', () => {
    const s = sled(flat, 70 / 3.6);
    run(s, { ...coast, brake: true }, 8, flat);
    expect(s.velocity.length()).toBeLessThan(0.05);
    expect(-s.position.z).toBeGreaterThan(25);
    expect(-s.position.z).toBeLessThan(45);
  });

  it('reverses slowly', () => {
    const s = sled(flat);
    run(s, { ...coast, reverse: true }, 4, flat);
    const back = s.velocity.z; // facing north (-z), so reversing is +z
    expect(back).toBeGreaterThan(2);
    expect(back).toBeLessThan(SLED.reverseSpeed + 0.05);
  });

  it('slides down a steep traverse, holds a gentle one, and leaning uphill helps', () => {
    // Facing west (yaw 90°) across slopes rising to the north: the fall line is +z.
    const slide = (angle: number, lean = 0) => {
      const hill = slope(angle);
      const s = sled(hill, 0, deg(90));
      run(s, { ...coast, lean }, 3, hill);
      return s.position.z;
    };
    expect(slide(15)).toBeLessThan(0.05);
    expect(slide(35)).toBeGreaterThan(3);
    // 28°: just past the keels' grip; weight on the uphill (right, north) board holds it.
    expect(slide(28)).toBeGreaterThan(1);
    expect(slide(28, -1)).toBeLessThan(0.05);
  });

  it('flies off a kicker, pitches with the throttle, and lands on the snow', () => {
    // A 1.5 m lip 20 m ahead (north), then flat again.
    const kicker: SkiTerrain = {
      height: (_x, z) => 1000 + (z < -10 && z > -20 ? (-10 - z) * 0.15 : 0),
    };
    const s = sled(kicker, 22);
    let flew = false;
    let maxPitch = -Infinity;
    for (let t = 0; t < 4; t += 1 / 60) {
      stepSled(s, throttle, 1 / 60, kicker);
      if (s.airborne) {
        flew = true;
        maxPitch = Math.max(maxPitch, s.pitch);
      }
      // Never below the snow.
      expect(s.position.y).toBeGreaterThanOrEqual(
        sledSurface(kicker, s.position.x, s.position.z, s.yaw, new Vector3()) - 1e-6,
      );
    }
    expect(flew).toBe(true);
    expect(maxPitch).toBeGreaterThan(0.1); // throttle held the nose up
    expect(s.airborne).toBe(false);
    expect(s.velocity.length()).toBeGreaterThan(15); // rode it out
  });

  it('drops level from a standstill rather than nose-diving', () => {
    const s = sled(flat);
    s.position.y += 20;
    s.airborne = true;
    let worst = 0;
    for (let t = 0; t < 3 && s.airborne; t += 1 / 60) {
      stepSled(s, coast, 1 / 60, flat);
      worst = Math.max(worst, Math.abs(s.pitch));
    }
    expect(worst).toBeLessThan(0.05);
    expect(s.airborne).toBe(false);
  });

  it('soaks a landing up in the suspension', () => {
    const s = sled(flat);
    s.position.y += 3;
    s.airborne = true;
    let impact = 0;
    let compressed = 0;
    for (let t = 0; t < 2; t += 1 / 60) {
      stepSled(s, coast, 1 / 60, flat);
      impact = Math.max(impact, s.impact);
      compressed = Math.max(compressed, s.suspension);
    }
    expect(impact).toBeGreaterThan(6);
    expect(compressed).toBeGreaterThan(0.1);
    expect(compressed).toBeLessThanOrEqual(SLED.suspensionTravel);
    expect(Math.abs(s.suspension)).toBeLessThan(0.02); // settled again
  });

  it('follows bumpy terrain at speed without dropping through it', () => {
    const bumps: SkiTerrain = {
      height: (x, z) => 1000 + 0.6 * Math.sin(z / 4) + 0.3 * Math.sin(x / 3 + z / 7),
    };
    const s = sled(bumps, 15);
    for (let t = 0; t < 10; t += 1 / 60) {
      stepSled(s, { throttle: 0.6, brake: false, steer: Math.sin(t) }, 1 / 60, bumps);
      const ground = sledSurface(bumps, s.position.x, s.position.z, s.yaw, new Vector3());
      expect(s.position.y).toBeGreaterThanOrEqual(ground - 1e-6);
      expect(Number.isFinite(s.velocity.x)).toBe(true);
    }
  });
});
