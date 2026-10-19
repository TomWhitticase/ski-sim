import { beforeEach, describe, expect, it } from 'vitest';
import {
  cameraSettings,
  DEFAULT_CAMERA,
  loadCamera,
  sanitizeCamera,
  saveCamera,
} from './camera-settings';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

describe('camera settings', () => {
  beforeEach(() => Object.assign(cameraSettings, DEFAULT_CAMERA));

  it('defaults when nothing is stored or it is garbage', () => {
    expect(loadCamera(memory())).toEqual(DEFAULT_CAMERA);
    const s = memory();
    s.setItem('ski-sim.camera', '{not json');
    expect(loadCamera(s)).toEqual(DEFAULT_CAMERA);
  });

  it('defaults first person wider than third person', () => {
    expect(DEFAULT_CAMERA.fovFirst).toBeGreaterThan(DEFAULT_CAMERA.fovThird);
  });

  it('clamps out-of-range values and ignores wrong types', () => {
    const c = sanitizeCamera({ fovThird: 500, speedFov: -3, sensitivity: 'fast', invertY: 1 });
    expect(c.fovThird).toBe(110);
    expect(c.speedFov).toBe(0);
    expect(c.sensitivity).toBe(DEFAULT_CAMERA.sensitivity);
    expect(c.invertY).toBe(false);
  });

  it('round-trips through storage into the live settings', () => {
    const s = memory();
    Object.assign(cameraSettings, { fovFirst: 90, invertY: true, chaseDistance: 1.5 });
    saveCamera(s);
    Object.assign(cameraSettings, DEFAULT_CAMERA);
    loadCamera(s);
    expect(cameraSettings).toMatchObject({ fovFirst: 90, invertY: true, chaseDistance: 1.5 });
  });
});
