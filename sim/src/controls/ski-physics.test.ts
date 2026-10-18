import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { SKI, type SkiIntent, type SkiState, type SkiTerrain, stepSki } from './ski-physics';

const RAD = Math.PI / 180;
const idle: SkiIntent = { tuck: false, push: false, brake: false, jump: false };

/** Plane falling away to the south (+z) at `degrees`. */
function slope(degrees: number): SkiTerrain {
  const grade = Math.tan(degrees * RAD);
  return { height: (_x, z) => 2000 - z * grade };
}

function skier(terrain: SkiTerrain, yaw: number): SkiState {
  return {
    position: new Vector3(0, terrain.height(0, 0), 0),
    velocity: new Vector3(),
    yaw,
    airborne: false,
  };
}

function run(state: SkiState, terrain: SkiTerrain, seconds: number, intent = idle) {
  for (let t = 0; t < seconds; t += 1 / 60) stepSki(state, intent, 1 / 60, terrain);
  return state;
}

// Yaw π faces south (downhill on these slopes); yaw π/2 faces west (across the slope).
const DOWNHILL = Math.PI;
const ACROSS = Math.PI / 2;

describe('stepSki', () => {
  it('stays put on the flat and on gentle slopes below the friction angle', () => {
    expect(run(skier(slope(0), DOWNHILL), slope(0), 5).velocity.length()).toBe(0);
    expect(run(skier(slope(2), DOWNHILL), slope(2), 5).velocity.length()).toBeLessThan(0.01);
  });

  it('accelerates down the fall line toward the drag-limited speed', () => {
    const t = slope(20);
    const state = run(skier(t, DOWNHILL), t, 60);
    const theta = 20 * RAD;
    const terminal = Math.sqrt(
      (SKI.gravity * Math.sin(theta) - SKI.snowFriction * SKI.gravity * Math.cos(theta)) /
        SKI.dragUpright,
    );
    expect(state.velocity.length()).toBeGreaterThan(terminal * 0.95);
    expect(state.velocity.length()).toBeLessThan(terminal * 1.02);
    expect(state.velocity.z).toBeGreaterThan(0); // heading south
  });

  it('goes faster in a tuck, but never past the speed cap', () => {
    const t = slope(25);
    const upright = run(skier(t, DOWNHILL), t, 60).velocity.length();
    const tuck = run(skier(t, DOWNHILL), t, 60, { ...idle, tuck: true }).velocity.length();
    expect(tuck).toBeGreaterThan(upright);
    const steep = slope(45);
    const capped = run(skier(steep, DOWNHILL), steep, 60, { ...idle, tuck: true });
    expect(capped.velocity.length()).toBeLessThanOrEqual(SKI.maxSpeed + 1e-6);
  });

  it('holds still when the skis are across a moderate slope', () => {
    const t = slope(20);
    expect(run(skier(t, ACROSS), t, 5).velocity.length()).toBeLessThan(0.5);
  });

  it('carves: turning the skis redirects the velocity and a hockey stop stops you', () => {
    const t = slope(15);
    const state = run(skier(t, DOWNHILL), t, 6);
    const before = state.velocity.length();
    state.yaw = DOWNHILL - 30 * RAD; // turn 30° right (facing south, right is west)
    run(state, t, 2);
    expect(state.velocity.x).toBeLessThan(-0.2 * state.velocity.length()); // now heading SSW
    expect(state.velocity.length()).toBeGreaterThan(before * 0.6);

    state.yaw = ACROSS; // skis sideways
    run(state, t, 4, { ...idle, brake: true });
    expect(state.velocity.length()).toBeLessThan(1);
  });

  it('skates on the flat up to a walking-pace limit', () => {
    const state = run(skier(slope(0), DOWNHILL), slope(0), 10, { ...idle, push: true });
    expect(state.velocity.length()).toBeGreaterThan(SKI.pushMaxSpeed * 0.9);
    expect(state.velocity.length()).toBeLessThan(SKI.pushMaxSpeed * 1.1);
  });

  it('flies off a drop and lands back on the snow', () => {
    // 15° slope with a 5 m step down at z = 30.
    const t: SkiTerrain = { height: (_x, z) => 2000 - z * Math.tan(15 * RAD) - (z > 30 ? 5 : 0) };
    const state = skier(t, DOWNHILL);
    state.velocity.set(0, -15 * Math.sin(15 * RAD), 15 * Math.cos(15 * RAD));
    let wasAirborne = false;
    for (let i = 0; i < 300; i++) {
      stepSki(state, idle, 1 / 60, t);
      wasAirborne ||= state.airborne;
    }
    expect(wasAirborne).toBe(true);
    expect(state.airborne).toBe(false);
    expect(state.position.y).toBeCloseTo(t.height(state.position.x, state.position.z), 3);
    expect(state.velocity.length()).toBeGreaterThan(5);
  });

  it('jumps', () => {
    const t = slope(0);
    const state = skier(t, DOWNHILL);
    stepSki(state, { ...idle, jump: true }, 1 / 60, t);
    expect(state.airborne).toBe(true);
    expect(state.position.y).toBeGreaterThan(t.height(0, 0));
  });
});
