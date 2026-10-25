import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { airDensity, H125 } from './aircraft-types';
import {
  createHeliState,
  heliAvailablePower,
  type HeliInput,
  type HeliState,
  hoverPower,
  powerRequired,
  stepHeli,
} from './heli-physics';
import type { AirTerrain } from './plane-physics';

const DT = 1 / 60;
const HANDS_OFF: HeliInput = { collective: 0, cyclicX: 0, cyclicY: 0, pedal: 0 };

/** Ground at `h`, tilted `slope` (rad) rising to the east. */
function ground(h: number, slope = 0): AirTerrain {
  return { height: (x) => h + Math.tan(slope) * x };
}

function parked(t: AirTerrain, mass = H125.mass): HeliState {
  const s = createHeliState(H125);
  s.mass = mass;
  s.rotor = 1;
  s.position.set(0, t.height(0, 0), 0);
  return s;
}

function run(s: HeliState, input: HeliInput, seconds: number, t: AirTerrain): void {
  for (let i = 0; i < seconds * 60; i++) stepHeli(s, input, DT, H125, t);
}

/** Highest altitude (m) it can hover at a mass, out of ground effect. */
function hoverCeiling(mass: number, height = Infinity): number {
  let h = 0;
  while (
    h < 9000 &&
    hoverPower(H125, mass, airDensity(h), height) < heliAvailablePower(H125, airDensity(h))
  ) {
    h += 50;
  }
  return h;
}

describe('H125 power and performance', () => {
  it('hovers at MTOW with power to spare at sea level and at a 2,000 m altiport', () => {
    for (const h of [0, 2000]) {
      const rho = airDensity(h);
      const share = hoverPower(H125, H125.maxMass, rho) / heliAvailablePower(H125, rho);
      expect(share).toBeGreaterThan(0.6);
      expect(share).toBeLessThan(0.9);
    }
  });

  it('hovers out of ground effect to about 3,500–4,000 m at MTOW, higher in ground effect', () => {
    const oge = hoverCeiling(H125.maxMass);
    expect(oge).toBeGreaterThan(3200);
    expect(oge).toBeLessThan(4500);
    expect(hoverCeiling(H125.maxMass, H125.ground.hub + 1)).toBeGreaterThan(oge + 500);
  });

  it('needs least power around 100–150 km/h (translational lift), most flat out', () => {
    const at = (kmh: number) => powerRequired(H125, H125.maxMass * 9.81, 1.225, kmh / 3.6);
    expect(at(120)).toBeLessThan(0.6 * at(0));
    expect(at(270)).toBeGreaterThan(at(120));
    // Flat out at sea level is about where the power runs out (VNE 287 km/h).
    expect(at(245)).toBeLessThan(heliAvailablePower(H125, 1.225));
  });
});

describe('H125 flying', () => {
  it('lifts off with W, holds its height hands off, and comes down gently with S', () => {
    const t = ground(2000);
    const s = parked(t);
    run(s, HANDS_OFF, 1, t);
    expect(s.onGround).toBe(true);
    run(s, { ...HANDS_OFF, collective: 1 }, 3, t);
    expect(s.onGround).toBe(false);
    expect(s.position.y).toBeGreaterThan(2008);
    run(s, HANDS_OFF, 3, t);
    const y = s.position.y;
    run(s, HANDS_OFF, 4, t);
    expect(Math.abs(s.position.y - y)).toBeLessThan(0.5);
    expect(s.power).toBeGreaterThan(0.5);
    expect(s.power).toBeLessThan(1);
    run(s, { ...HANDS_OFF, collective: -1 }, 30, t);
    expect(s.onGround).toBe(true);
    expect(s.crash).toBe(0);
    expect(s.impact).toBeLessThan(1.5);
  });

  it('flies forward with the cyclic, and slows back to a hover hands off', () => {
    const t = ground(2000);
    const s = parked(t);
    run(s, { ...HANDS_OFF, collective: 1 }, 4, t);
    run(s, { ...HANDS_OFF, cyclicY: 1 }, 12, t);
    const forward = -s.velocity.z; // heading north
    expect(forward).toBeGreaterThan(30);
    expect(s.pitch).toBeLessThan(-0.25); // nose down
    run(s, HANDS_OFF, 40, t);
    expect(new Vector3(s.velocity.x, 0, s.velocity.z).length()).toBeLessThan(3);
    expect(s.onGround).toBe(false);
  });

  it('turns with the pedals in a hover', () => {
    const t = ground(2000);
    const s = parked(t);
    run(s, { ...HANDS_OFF, collective: 1 }, 3, t);
    run(s, { ...HANDS_OFF, pedal: 1 }, 1.5, t);
    expect(s.yaw).toBeLessThan(-0.8); // yawed right
  });

  it('sits on a 10° slope but slides off a 15° one, and rolls over landing on 25°', () => {
    const ten = ground(2000, (10 * Math.PI) / 180);
    const a = parked(ten);
    run(a, HANDS_OFF, 3, ten);
    expect(a.onGround).toBe(true);
    expect(new Vector3(a.velocity.x, 0, a.velocity.z).length()).toBeLessThan(0.05);
    expect(Math.abs(a.bank)).toBeGreaterThan(0.15); // skids across the slope, tilted with it

    const fifteen = ground(2000, (15 * Math.PI) / 180);
    const b = parked(fifteen);
    run(b, HANDS_OFF, 2, fifteen);
    expect(b.position.x).toBeLessThan(-0.5); // slid downhill (west)

    const steep = ground(2000, (25 * Math.PI) / 180);
    const c = parked(steep);
    c.onGround = false;
    c.position.y += 0.3;
    c.thrust = c.mass * 9.81;
    run(c, { ...HANDS_OFF, collective: -1 }, 3, steep);
    expect(c.crashed).toMatch(/Rolled over|Rotor strike/);
  });

  it('crashes landing hard or fast', () => {
    const t = ground(2000);
    const s = parked(t);
    s.onGround = false;
    s.position.y = 2003;
    s.velocity.set(0, -7, 0);
    s.rotor = 0.1; // no power to stop the fall
    run(s, HANDS_OFF, 2, t);
    expect(s.crashed).toBe('Hard landing');

    const fast = parked(t);
    fast.onGround = false;
    fast.position.y = 2000.3;
    fast.velocity.set(0, -0.5, -20);
    run(fast, { ...HANDS_OFF, collective: -1 }, 1, t);
    expect(fast.crashed).not.toBeNull();
  });

  it('drifts with the wind unless it is flown against it', () => {
    const t = ground(2000);
    const s = parked(t);
    run(s, { ...HANDS_OFF, collective: 1 }, 3, t);
    const air = { wind: new Vector3(8, 0, 0), temperature: null };
    for (let i = 0; i < 60 * 3; i++) stepHeli(s, { ...HANDS_OFF, cyclicY: 0.05 }, DT, H125, t, air);
    expect(s.velocity.x).toBeGreaterThan(1);
  });
});
