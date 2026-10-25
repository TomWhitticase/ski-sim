import { beforeEach, describe, expect, it } from 'vitest';
import {
  cameraSettings,
  DEFAULT_CAMERA,
  keyStick,
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

describe('keyboard stick', () => {
  const hold = (from: number, dir: number, seconds: number) => {
    let v = from;
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) v = keyStick(v, dir, 1 / 60);
    return v;
  };

  it('ramps to full deflection over ~0.6 s, so a tap is a small correction', () => {
    expect(hold(0, 1, 0.1)).toBeCloseTo(0.167, 1);
    expect(hold(0, 1, 0.3)).toBeCloseTo(0.5, 1);
    expect(hold(0, 1, 0.7)).toBe(1);
    expect(hold(0, -1, 2)).toBe(-1);
  });

  it('reverses three times as fast and springs back to centre when let go', () => {
    expect(hold(1, -1, 0.2)).toBeLessThan(0.05);
    expect(hold(0.8, 0, 0.1)).toBeCloseTo(0.4, 1);
    expect(hold(0.8, 0, 0.3)).toBe(0);
  });

  it('keeps the fly-with choice, defaulting to the mouse', () => {
    expect(sanitizeCamera({}).flyWith).toBe('mouse');
    expect(sanitizeCamera({ flyWith: 'arrows' }).flyWith).toBe('arrows');
    expect(sanitizeCamera({ flyWith: 'joystick' }).flyWith).toBe('mouse');
  });
});
