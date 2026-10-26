import { describe, expect, it } from 'vitest';

import {
  classifyPress,
  detectTouch,
  nextKind,
  pinchScale,
  PRESS,
  STICK,
  stickKnob,
  stickKeys,
  stickVector,
  stopSide,
} from './touch-input';

const env = { coarse: false, anyFine: true, maxTouchPoints: 0, override: null };

describe('detectTouch', () => {
  it('is touch on a phone or tablet: a touchscreen whose main pointer is a finger', () => {
    expect(detectTouch({ ...env, coarse: true, anyFine: false, maxTouchPoints: 5 })).toBe(true);
    // An iPad with a trackpad attached still starts on touch; using it switches.
    expect(detectTouch({ ...env, coarse: true, anyFine: true, maxTouchPoints: 5 })).toBe(true);
  });

  it('is desktop with a mouse, even on a touchscreen laptop', () => {
    expect(detectTouch(env)).toBe(false);
    expect(detectTouch({ ...env, maxTouchPoints: 10 })).toBe(false);
    // A coarse pointer with no touch points (a TV remote, an emulator quirk).
    expect(detectTouch({ ...env, coarse: true })).toBe(false);
  });

  it('follows ?touch= in the link either way', () => {
    expect(detectTouch({ ...env, override: '1' })).toBe(true);
    expect(
      detectTouch({ ...env, coarse: true, maxTouchPoints: 5, anyFine: false, override: '0' }),
    ).toBe(false);
  });
});

describe('nextKind', () => {
  it('switches to touch on a finger and back on a mouse click or a key', () => {
    expect(nextKind('desktop', { type: 'pointerdown', pointerType: 'touch' })).toBe('touch');
    expect(nextKind('touch', { type: 'pointerdown', pointerType: 'mouse' })).toBe('desktop');
    expect(nextKind('touch', { type: 'keydown' })).toBe('desktop');
  });

  it("ignores typing in a field and pens (they're either)", () => {
    expect(nextKind('touch', { type: 'keydown', typing: true })).toBe('touch');
    expect(nextKind('touch', { type: 'pointerdown', pointerType: 'pen' })).toBe('touch');
    expect(nextKind('desktop', { type: 'pointerdown', pointerType: 'pen' })).toBe('desktop');
  });
});

describe('stickVector', () => {
  it('is still inside the dead zone', () => {
    const r = STICK.radius;
    expect(stickVector(100, 100, 100 + r * STICK.deadZone * 0.9, 100)).toEqual({
      x: 0,
      y: 0,
      magnitude: 0,
    });
  });

  it('reads up as forward (screen y runs down) and right as +x', () => {
    const up = stickVector(100, 100, 100, 100 - STICK.radius);
    expect(up.y).toBeCloseTo(1);
    expect(up.x).toBeCloseTo(0);
    const right = stickVector(100, 100, 100 + STICK.radius, 100);
    expect(right.x).toBeCloseTo(1);
  });

  it('never leaves the unit circle, and ramps from 0 at the dead zone', () => {
    const far = stickVector(0, 0, 300, -400);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(1);
    expect(far.x).toBeCloseTo(0.6);
    expect(far.y).toBeCloseTo(0.8);
    const half = stickVector(0, 0, STICK.radius * (STICK.deadZone + (1 - STICK.deadZone) / 2), 0);
    expect(half.magnitude).toBeCloseTo(0.5);
  });
});

describe('stickKnob', () => {
  it('keeps the knob on its ring, and the base where the thumb landed', () => {
    expect(stickKnob(0, 0, 10, 0, 50)).toEqual({ x: 10, y: 0 });
    const out = stickKnob(0, 0, 80, 0, 50);
    expect(out.x).toBeCloseTo(50);
    expect(out.y).toBeCloseTo(0);
    const diagonal = stickKnob(100, 100, 400, 500, 50);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(50);
    expect(diagonal.x / diagonal.y).toBeCloseTo(0.75);
    // Still full deflection from the unmoved base, and pulling back responds at once.
    expect(stickVector(0, 0, 80, 0, 50).x).toBeCloseTo(1);
    expect(stickVector(0, 0, 20, 0, 50).x).toBeLessThan(0.5);
  });
});

describe('classifyPress', () => {
  it('tells a tap, a long press and a drag apart', () => {
    expect(classifyPress(120, 2, true)).toBe('tap');
    expect(classifyPress(120, 2, false)).toBeNull();
    expect(classifyPress(PRESS.longMs, 3, false)).toBe('long-press');
    expect(classifyPress(80, PRESS.slop + 1, false)).toBe('drag');
    // Moving at any point makes it a drag, however long it's held.
    expect(classifyPress(2000, PRESS.slop + 1, true)).toBe('drag');
  });
});

describe('pinchScale', () => {
  it('zooms in as the fingers spread, within the limits', () => {
    expect(pinchScale(8, 100, 200, 0.5, 40)).toBe(4);
    expect(pinchScale(8, 200, 100, 0.5, 40)).toBe(16);
    expect(pinchScale(1, 100, 1000, 0.5, 40)).toBe(0.5);
    expect(pinchScale(8, 0, 100, 0.5, 40)).toBe(8);
  });
});

describe('stick keys', () => {
  it('skates forward and ploughs back when skiing', () => {
    expect(stickKeys('ski', 0.8)).toEqual(['KeyW']);
    expect(stickKeys('ski', -0.8)).toEqual(['ShiftLeft']);
    expect(stickKeys('ski', 0.2)).toEqual([]);
  });

  it('is the speed bar and brakes on the glider, the brake on the sled', () => {
    expect(stickKeys('glide', 0.9)).toEqual(['KeyW']);
    expect(stickKeys('glide', -0.9)).toEqual(['KeyS']);
    expect(stickKeys('sled', -0.9)).toEqual(['KeyS']);
    expect(stickKeys('sled', 0.9)).toEqual([]); // the throttle is analog
    expect(stickKeys('fly', 1)).toEqual([]);
  });

  it('makes Stop a hockey stop to the side the stick points, else a plough', () => {
    expect(stopSide(0, 0)).toBe(0);
    expect(stopSide(0, 0.2)).toBe(0); // a wobble isn't a side
    expect(stopSide(0, -0.7)).toBe(1); // stick left: skis swing left (+1, as Input.turn)
    expect(stopSide(0, 0.7)).toBe(-1);
  });

  it('keeps the hockey stop once chosen, until the stick goes the other way', () => {
    expect(stopSide(1, 0)).toBe(1); // thumb eased back or left the stick
    expect(stopSide(1, -0.2)).toBe(1);
    expect(stopSide(1, 0.7)).toBe(-1);
  });
});
