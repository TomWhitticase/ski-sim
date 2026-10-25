import { Box3, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { createHelicopter, createPlane, viewBlocked } from './aircraft-model';
import { H125, PC6 } from './aircraft-types';

/** The model's extent (m), without the turning prop or rotors and their discs. */
function size(parts: ReturnType<typeof createPlane>, withRotor = false): Vector3 {
  parts.rotor.visible = withRotor;
  if (parts.tailRotor) parts.tailRotor.visible = withRotor;
  parts.root.updateMatrixWorld(true);
  const box = new Box3();
  parts.root.traverseVisible((o) => {
    if (
      'geometry' in o &&
      o !== parts.lights.nav &&
      o !== parts.lights.strobes &&
      o !== parts.lights.beacon
    ) {
      box.expandByObject(o, true);
    }
  });
  return box.getSize(new Vector3());
}

describe('aircraft models are to scale', () => {
  it('builds the Porter at 15.87 m span and 10.9 m long, ~3.2 m high sat on its tailwheel', () => {
    const plane = createPlane(PC6);
    // Tail down on its tailwheel, as it sits on the ground.
    plane.root.rotation.x = PC6.ground.threePoint;
    const s = size(plane);
    expect(s.x).toBeGreaterThan(PC6.span * 0.98);
    expect(s.x).toBeLessThan(PC6.span * 1.03);
    expect(s.z).toBeGreaterThan(PC6.length * 0.95);
    expect(s.z).toBeLessThan(PC6.length * 1.06);
    expect(s.y).toBeGreaterThan(PC6.height * 0.88);
    expect(s.y).toBeLessThan(PC6.height * 1.1);
  });

  it('builds the H125 at 12.94 m long with its rotors and 10.69 m across them', () => {
    const heli = createHelicopter(H125);
    const s = size(heli, true);
    expect(s.z).toBeGreaterThan(H125.length * 0.97);
    expect(s.z).toBeLessThan(H125.length * 1.04);
    expect(s.x).toBeGreaterThan(2 * H125.rotorRadius * 0.98);
    expect(s.y).toBeGreaterThan(H125.height * 0.9);
    expect(s.y).toBeLessThan(H125.height * 1.1);
  });
});

describe('the cockpit view', () => {
  /** The camera at the pilot's eye, looking along the nose and `lookDown` below it. */
  function cockpit(parts: ReturnType<typeof createPlane>, yaw = 0, pitch = 0): PerspectiveCamera {
    const camera = new PerspectiveCamera(85, 16 / 9, 0.05, 1000);
    camera.position.copy(parts.eye);
    camera.rotation.set(pitch - parts.lookDown, yaw, 0, 'YXZ');
    return camera;
  }

  for (const [name, make] of [
    ['Porter', () => createPlane(PC6)],
    ['H125', () => createHelicopter(H125)],
  ] as const) {
    it(`sees out of the ${name}'s windscreen: mostly sky and ground, the panel below`, () => {
      const parts = make();
      // Running, the prop or rotor is a see-through blur.
      parts.rotor.visible = false;
      const ahead = viewBlocked(parts.root, cockpit(parts));
      // Panel, glareshield and frame, never a wall of fuselage.
      expect(ahead).toBeGreaterThan(0.05);
      expect(ahead).toBeLessThan(0.4);
      // The middle of the view, straight ahead, is clear.
      const camera = new PerspectiveCamera(20, 1, 0.05, 1000);
      camera.position.copy(parts.eye);
      camera.rotation.set(0, 0, 0, 'YXZ');
      expect(viewBlocked(parts.root, camera, 8)).toBeLessThan(0.25);
    });

    it(`sits the ${name}'s eye inside the cabin, behind the windscreen`, () => {
      const parts = make();
      // Looking the other way: the cabin's lining and seats all round, close by.
      const behind = viewBlocked(parts.root, cockpit(parts, Math.PI), 16, 6);
      expect(behind).toBeGreaterThan(0.45);
    });
  }
});
