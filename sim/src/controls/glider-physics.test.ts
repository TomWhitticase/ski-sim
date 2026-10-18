import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { GLIDER, type GliderInput, type GliderState, stepGlider } from './glider-physics';

const level: GliderInput = { turn: 0, bar: false, brake: false };
const sea = () => -1e6;

function glider(speed: number, vy = 0): GliderState {
  return {
    position: new Vector3(0, 3000, 0),
    velocity: new Vector3(0, vy, -speed), // heading north
    heading: 0,
    bank: 0,
  };
}

function fly(state: GliderState, seconds: number, input = level, ground = sea) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    if (stepGlider(state, input, 1 / 60, ground)) return true;
  }
  return false;
}

describe('stepGlider', () => {
  it('settles into a ~9:1 glide at trim speed', () => {
    const s = glider(GLIDER.trimSpeed, -GLIDER.trimSink);
    fly(s, 20);
    const ratio = Math.hypot(s.velocity.x, s.velocity.z) / -s.velocity.y;
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(GLIDER.trimSpeed, 0);
    expect(ratio).toBeGreaterThan(8);
    expect(ratio).toBeLessThan(11);
  });

  it('keeps momentum: launched fast it zooms up before settling', () => {
    const s = glider(30);
    fly(s, 2);
    expect(s.position.y).toBeGreaterThan(3000);
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeGreaterThan(GLIDER.trimSpeed);
    fly(s, 20);
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(GLIDER.trimSpeed, 0);
  });

  it('dives to pick up speed when deployed slow', () => {
    const s = glider(2);
    fly(s, 2);
    expect(s.velocity.y).toBeLessThan(-GLIDER.trimSink);
  });

  it('turns when banked, losing more height than flying straight', () => {
    const straight = glider(GLIDER.trimSpeed, -GLIDER.trimSink);
    const turning = glider(GLIDER.trimSpeed, -GLIDER.trimSink);
    fly(straight, 10);
    fly(turning, 10, { ...level, turn: 1 });
    expect(turning.heading).toBeGreaterThan(Math.PI / 2); // turned left a long way
    expect(turning.bank).toBeCloseTo(GLIDER.maxBank);
    expect(turning.position.y).toBeLessThan(straight.position.y - 3);
  });

  it('flies faster on the speed bar and slower on the brakes', () => {
    const bar = glider(GLIDER.trimSpeed);
    const brake = glider(GLIDER.trimSpeed);
    fly(bar, 15, { ...level, bar: true });
    fly(brake, 15, { ...level, brake: true });
    expect(Math.hypot(bar.velocity.x, bar.velocity.z)).toBeGreaterThan(13);
    expect(Math.hypot(brake.velocity.x, brake.velocity.z)).toBeLessThan(8.5);
  });

  it('reports landing when the feet reach the ground', () => {
    const s = glider(GLIDER.trimSpeed, -GLIDER.trimSink);
    s.position.y = 2010;
    expect(fly(s, 30, level, () => 2000)).toBe(true);
    expect(s.position.y).toBe(2000);
  });
});
