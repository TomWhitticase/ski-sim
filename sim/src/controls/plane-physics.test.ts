import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { airDensity, PC6 } from './aircraft-types';
import {
  type AirTerrain,
  availablePower,
  climbRate,
  createPlaneState,
  groundOrientation,
  type PlaneState,
  stallSpeed,
  stepPlane,
  type Surface,
} from './plane-physics';

const KMH = 1 / 3.6;
const DT = 1 / 60;

/** Flat ground at `h`, or a runway rising `grade` toward the north (−z) from z = 0. */
function runway(h: number, grade = 0, surface: Surface = 'paved'): AirTerrain {
  return { height: (_x, z) => h - grade * Math.min(z, 0), surface: () => surface };
}

/** A plane at rest on the ground at the origin, facing north, engine running. */
function onGround(t: AirTerrain, mass = PC6.maxMass, flaps = 1): PlaneState {
  const s = createPlaneState(PC6);
  s.mass = mass;
  s.rpm = 1;
  s.flaps = flaps;
  s.position.set(0, t.height(0, 0), 0);
  const n = new Vector3(0, 1, 0);
  groundOrientation(0, n, PC6.ground.threePoint, s.orientation);
  return s;
}

/**
 * Full power, stick neutral until ~85 km/h, then back (the tail-up-then-rotate
 * technique). Ground roll and distance to 15 m (m).
 */
function takeoff(t: AirTerrain, mass = PC6.maxMass, wind = new Vector3()) {
  const s = onGround(t, mass);
  let roll = NaN;
  for (let i = 0; i < 60 * 60; i++) {
    const pitch = s.airspeed < 24 ? 0 : 0.6;
    stepPlane(s, { pitch, roll: 0, yaw: 0, throttle: 1, brake: false, flaps: 1 }, DT, PC6, t, {
      wind,
      temperature: null,
    });
    if (s.crash) throw new Error(s.crashed ?? 'crash');
    const d = Math.hypot(s.position.x, s.position.z);
    if (!s.onGround && Number.isNaN(roll)) roll = d;
    if (s.position.y - t.height(s.position.x, s.position.z) > 15) return { roll, to15: d, s };
  }
  throw new Error('never climbed to 15 m');
}

/**
 * A 4.5° approach at 1.3 × the landing stall speed with full flap, flown by a simple
 * autopilot (the stick holds a sink rate, a flare onto the slope at 7 m), then
 * reverse and brakes. Distances from 15 m and the ground roll (m), and the touchdown.
 */
function land(t: AirTerrain, mass: number, grade = 0) {
  const s = createPlaneState(PC6);
  s.mass = mass;
  const h0 = t.height(0, 0);
  const vref = 1.3 * stallSpeed(PC6, mass, airDensity(h0), 2);
  const glide = Math.tan((4.5 * Math.PI) / 180);
  const out = grade ? 300 : 600;
  s.position.set(0, h0 + glide * out, out);
  s.velocity.set(0, -vref * glide, -vref);
  s.flaps = 2;
  s.rpm = 0.8;
  s.onGround = false;
  groundOrientation(0, new Vector3(0, 1, 0), 0.08, s.orientation);
  let at15 = NaN;
  let touch = NaN;
  let sink = 0;
  for (let i = 0; i < 60 * 120; i++) {
    const agl = s.position.y - t.height(s.position.x, s.position.z);
    if (agl < 15 && Number.isNaN(at15)) at15 = s.position.z;
    const rise = s.position.z < 30 ? grade * -s.velocity.z : 0;
    const want = rise + (agl > 4 ? -3 : -0.6);
    const pitch = s.onGround ? 1 : Math.max(-1, Math.min(1, (want - s.velocity.y) * 0.4));
    const throttle = s.onGround ? -1 : agl > 4 ? 0.25 : 0;
    stepPlane(s, { pitch, roll: 0, yaw: 0, throttle, brake: s.onGround, flaps: 2 }, DT, PC6, t);
    if (s.crash) throw new Error(s.crashed ?? 'crash');
    if (s.onGround && Number.isNaN(touch)) {
      touch = s.position.z;
      sink = s.impact;
    }
    if (s.onGround && s.velocity.length() < 0.3) {
      return { from15: at15 - s.position.z, roll: touch - s.position.z, sink, touchZ: touch };
    }
  }
  throw new Error('never stopped');
}

describe('PC-6 aerodynamics against the published figures', () => {
  it('stalls at 107 km/h clean and 96 km/h with full flap at MTOW (sea level)', () => {
    expect(stallSpeed(PC6, 2800, 1.225, 0) / KMH).toBeCloseTo(107, 0);
    expect(stallSpeed(PC6, 2800, 1.225, 2) / KMH).toBeCloseTo(96, 0);
  });

  it('climbs at about 5.1 m/s at MTOW at sea level', () => {
    let best = -Infinity;
    for (let v = 20; v < 70; v += 0.5) best = Math.max(best, climbRate(PC6, 2800, 1.225, v));
    expect(best).toBeGreaterThan(4.3);
    expect(best).toBeLessThan(6.3);
  });

  it('cruises at about 125 kt flat out at 10,000 ft', () => {
    let top = 0;
    for (let v = 40; v < 100; v += 0.5) if (climbRate(PC6, 2800, airDensity(3048), v) > 0) top = v;
    expect(top / KMH).toBeGreaterThan(200);
    expect(top / KMH).toBeLessThan(250);
  });

  it('keeps its flat-rated power to about 2,000 m, then loses it with the air', () => {
    expect(availablePower(PC6, airDensity(0))).toBe(PC6.engine.rated);
    expect(availablePower(PC6, airDensity(1800))).toBe(PC6.engine.rated);
    expect(availablePower(PC6, airDensity(4000))).toBeLessThan(0.9 * PC6.engine.rated);
  });
});

describe('PC-6 take-off and landing', () => {
  it('leaves the ground in about the published 197 m at MTOW at sea level', () => {
    const { roll, to15 } = takeoff(runway(0));
    expect(roll).toBeGreaterThan(150);
    expect(roll).toBeLessThan(250);
    // 440 m to 15 m published (STOL).
    expect(to15).toBeGreaterThan(250);
    expect(to15).toBeLessThan(520);
  });

  it('needs a longer run at a 2,000 m altiport, less into the wind, less downhill', () => {
    const sea = takeoff(runway(0)).roll;
    const high = takeoff(runway(2000)).roll;
    expect(high).toBeGreaterThan(1.15 * sea);
    expect(high).toBeLessThan(1.7 * sea);
    // 20 kt on the nose (the wind blows south: air moving +z, the plane heading -z).
    expect(takeoff(runway(2000), PC6.maxMass, new Vector3(0, 0, 10)).roll).toBeLessThan(0.7 * high);
    // Courchevel: downhill on its ~12 % mean slope (the runway falls to the north here).
    const downhill: AirTerrain = { height: (_x, z) => 2000 + 0.12 * z, surface: () => 'paved' };
    expect(takeoff(downhill).roll).toBeLessThan(0.8 * high);
  });

  it('takes a longer run on snow skis than on wheels, and much longer in powder', () => {
    const paved = takeoff(runway(2000)).roll;
    const groomed = takeoff(runway(2000, 0, 'groomed')).roll;
    const powder = takeoff(runway(2000, 0, 'powder')).roll;
    expect(groomed).toBeGreaterThan(paved);
    expect(powder).toBeGreaterThan(1.1 * groomed);
  });

  it('lands in about the published 127 m ground roll (reverse and brakes)', () => {
    const { roll, from15, sink } = land(runway(0), 2660);
    expect(roll).toBeGreaterThan(80);
    expect(roll).toBeLessThan(180);
    expect(from15).toBeGreaterThan(220); // 315 m published
    expect(from15).toBeLessThan(420);
    expect(sink).toBeLessThan(2);
  });

  it('lands uphill on an 18.6 % slope at 2,000 m and stops short', () => {
    const { roll, sink, touchZ } = land(runway(2000, 0.186), 2200, 0.186);
    expect(touchZ).toBeLessThan(0); // on the slope, past its foot
    expect(roll).toBeLessThan(110);
    expect(sink).toBeLessThan(PC6.ground.maxSink);
  });

  it('holds still on the slope with the brakes on, and rolls back down without them', () => {
    const t = runway(2000, 0.12);
    const s = onGround(t, 2200);
    s.position.set(0, t.height(0, -100), -100);
    const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 1 };
    for (let i = 0; i < 120; i++) stepPlane(s, { ...idle, brake: true }, DT, PC6, t);
    expect(s.velocity.length()).toBeLessThan(0.05);
    for (let i = 0; i < 180; i++) stepPlane(s, { ...idle, brake: false }, DT, PC6, t);
    expect(s.velocity.z).toBeGreaterThan(1); // rolling back south, downhill
  });
});

describe('PC-6 in the air', () => {
  /** Level at `speed` m/s, 1,000 m over flat ground at 2,000 m. */
  function flying(speed: number, flaps = 0): PlaneState {
    const s = createPlaneState(PC6);
    s.onGround = false;
    s.rpm = 1;
    s.flaps = flaps;
    s.position.set(0, 3000, 0);
    s.velocity.set(0, 0, -speed);
    return s;
  }
  const sky = runway(2000);

  it('stalls with the stick held back at idle, and flies again when it is let go', () => {
    const s = flying(40);
    let stalled = false;
    let warned = false;
    const start = s.position.y;
    for (let i = 0; i < 60 * 12; i++) {
      stepPlane(
        s,
        { pitch: 1, roll: 0, yaw: 0, throttle: 0, brake: false, flaps: 0 },
        DT,
        PC6,
        sky,
      );
      stalled ||= s.stall;
      warned ||= s.stallWarning;
    }
    expect(warned).toBe(true);
    expect(stalled).toBe(true);
    for (let i = 0; i < 60 * 10; i++) {
      stepPlane(
        s,
        { pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: false, flaps: 0 },
        DT,
        PC6,
        sky,
      );
    }
    expect(s.stall).toBe(false);
    expect(s.crash).toBe(0);
    // A gentle break: well under 200 m lost from the entry.
    expect(start - s.position.y).toBeLessThan(200);
  });

  it('rolls into a turn with the stick and levels its wings hands off', () => {
    const s = flying(50);
    const bank = () => {
      const r = new Vector3(1, 0, 0).applyQuaternion(s.orientation);
      const u = new Vector3(0, 1, 0).applyQuaternion(s.orientation);
      return (Math.atan2(-r.y, u.y) * 180) / Math.PI;
    };
    const cruise = { pitch: 0, yaw: 0, throttle: 0.7, brake: false, flaps: 0 };
    for (let i = 0; i < 30; i++) stepPlane(s, { ...cruise, roll: 1 }, DT, PC6, sky);
    expect(bank()).toBeGreaterThan(15); // right wing down
    const heading0 = Math.atan2(-s.velocity.x, -s.velocity.z);
    for (let i = 0; i < 120; i++) stepPlane(s, { ...cruise, roll: 0 }, DT, PC6, sky);
    // Turning right while banked (heading in Look terms goes negative).
    expect(Math.atan2(-s.velocity.x, -s.velocity.z)).toBeLessThan(heading0 - 0.05);
    for (let i = 0; i < 60 * 6; i++) stepPlane(s, { ...cruise, roll: 0 }, DT, PC6, sky);
    expect(Math.abs(bank())).toBeLessThan(3);
  });

  it('measures airspeed through the air, not over the ground', () => {
    const s = flying(40);
    const air = { wind: new Vector3(0, 0, 15), temperature: null };
    stepPlane(
      s,
      { pitch: 0, roll: 0, yaw: 0, throttle: 0.5, brake: false, flaps: 0 },
      DT,
      PC6,
      sky,
      air,
    );
    // 40 m/s north into a 15 m/s wind from the north: 55 m/s through the air.
    expect(s.airspeed).toBeCloseTo(55, 0);
  });

  it('crashes flying into the ground, and on a hard or nose-first touchdown', () => {
    const dive = flying(45);
    dive.position.y = 2010;
    dive.velocity.set(0, -9, -45);
    for (let i = 0; i < 120 && !dive.crash; i++) {
      stepPlane(
        dive,
        { pitch: -1, roll: 0, yaw: 0, throttle: 1, brake: false, flaps: 0 },
        DT,
        PC6,
        sky,
      );
    }
    expect(dive.crash).toBeGreaterThan(0);
    expect(dive.crashed).toMatch(/Hard landing|Prop strike/);
  });
});
