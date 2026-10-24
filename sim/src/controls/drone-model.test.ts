import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { Drone, DRONE_MAX_TILT, droneTilt } from './drone-model';
import { SkierModel } from './ski-model';
import { initialStance } from './ski-stance';

describe('droneTilt', () => {
  it('is level hovering, nose down flying forward, rolled toward a sideways drift', () => {
    expect(droneTilt(0, 0)).toEqual({ pitch: 0, roll: 0 });
    const forward = droneTilt(10, 0);
    expect(forward.pitch).toBeLessThan(-0.15);
    expect(forward.roll).toBeCloseTo(0, 6);
    expect(droneTilt(-10, 0).pitch).toBeCloseTo(-forward.pitch, 6); // nose up backing off
    const right = droneTilt(0, 10);
    expect(right.roll).toBeLessThan(-0.15);
    expect(right.pitch).toBeCloseTo(0, 6);
  });

  it('leans more the faster it goes, never past its limit', () => {
    let last = 0;
    for (const speed of [2, 8, 20, 60, 1500]) {
      const { pitch } = droneTilt(speed, 0);
      expect(-pitch).toBeGreaterThan(last);
      expect(-pitch).toBeLessThanOrEqual(DRONE_MAX_TILT);
      last = -pitch;
    }
    const diagonal = droneTilt(30, 30);
    expect(Math.hypot(diagonal.pitch, diagonal.roll)).toBeLessThanOrEqual(DRONE_MAX_TILT + 1e-9);
  });
});

describe('Drone', () => {
  it('tilts into its flight from the motion alone, and levels out when it stops', () => {
    const drone = new Drone();
    const at = new Vector3(0, 2000, 0);
    // Facing north (yaw 0, forward is -z), flying north at 10 m/s.
    for (let i = 0; i < 60; i++) {
      at.z -= 10 / 60;
      drone.update(1 / 60, at, 0);
    }
    expect(drone.root.visible).toBe(true);
    expect(drone.speed).toBeCloseTo(10, 0);
    expect(drone.tilt.pitch).toBeLessThan(-0.15);
    expect(Math.abs(drone.tilt.roll)).toBeLessThan(0.01);
    for (let i = 0; i < 120; i++) drone.update(1 / 60, at, 0);
    expect(Math.abs(drone.tilt.pitch)).toBeLessThan(0.02);
    // A teleport isn't a burst of speed.
    at.x += 5000;
    drone.update(1 / 60, at, 0);
    expect(drone.speed).toBeLessThan(1);
  });
});

describe('SkierModel flying the drone', () => {
  it('holds the controller in front of the chest, poles planted beside the boots', () => {
    const model = new SkierModel();
    model.apply(initialStance());
    const free = [...model.clearance.hands];
    model.setFlyingDrone(true);
    expect(model.isFlyingDrone).toBe(true);
    expect(model.root.getObjectByName('drone-controller')!.visible).toBe(true);
    // Hands come up to the controller, well clear of the snow and above where they hang.
    for (const [i, h] of model.clearance.hands.entries()) {
      expect(h).toBeGreaterThan(0.9);
      expect(h).toBeGreaterThan(free[i]!);
    }
    // The pole tips are in the snow.
    for (const tip of model.clearance.tips) expect(tip).toBeLessThan(0);
    model.setFlyingDrone(false);
    expect(model.root.getObjectByName('drone-controller')!.visible).toBe(false);
  });
});
