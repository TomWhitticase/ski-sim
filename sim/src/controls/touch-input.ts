/**
 * The pure parts of touch play (unit-tested): spotting a touch device, the virtual
 * thumbstick's maths, telling taps from long presses and drags, and what the stick means in
 * each mode. `touch-controls.ts` wires them to the screen.
 */

/** What the browser says about its pointers (`matchMedia`, `navigator.maxTouchPoints`). */
export interface PointerEnv {
  /** `(pointer: coarse)`: the primary pointer is a finger. */
  coarse: boolean;
  /** `(any-pointer: fine)`: a mouse or trackpad is attached too. */
  anyFine: boolean;
  maxTouchPoints: number;
  /** `?touch=` in the link: `1` forces touch controls, `0` the keyboard and mouse. */
  override: string | null;
}

/**
 * Start in touch mode? Only on a touchscreen whose primary pointer is a finger (phones,
 * tablets), not a laptop that also has one. The user agent isn't consulted: an iPad says it's
 * a Mac. A tablet with a mouse or keyboard switches as soon as they're used (`nextKind`).
 */
export function detectTouch(env: PointerEnv): boolean {
  if (env.override === '1' || env.override === 'true') return true;
  if (env.override === '0' || env.override === 'false') return false;
  return env.maxTouchPoints > 0 && env.coarse;
}

export type InputKind = 'touch' | 'desktop';

/**
 * The controls to show after an input event: a finger means touch, a real mouse button or
 * a key (not typed into a field) means keyboard and mouse. Anything else changes nothing.
 */
export function nextKind(
  current: InputKind,
  event: { type: string; pointerType?: string; typing?: boolean },
): InputKind {
  if (event.type === 'pointerdown' || event.type === 'touchstart') {
    if (event.type === 'touchstart' || event.pointerType === 'touch') return 'touch';
    if (event.pointerType === 'mouse') return 'desktop';
    return current; // a pen could be either
  }
  if (event.type === 'keydown' && !event.typing) return 'desktop';
  return current;
}

/** The thumbstick: radius of its travel and the dead zone at its centre (fraction). */
export const STICK = { radius: 56, deadZone: 0.14 };

/**
 * Stick deflection from where the thumb landed (`ox`, `oy`) to where it is: x right and
 * y up (forward), each -1..1, inside the unit circle. The dead zone is cut out and the rest
 * rescaled, so a small wobble is still and full travel is exactly 1.
 */
export function stickVector(
  ox: number,
  oy: number,
  x: number,
  y: number,
  radius = STICK.radius,
  deadZone = STICK.deadZone,
): { x: number; y: number; magnitude: number } {
  const dx = (x - ox) / radius;
  const dy = (oy - y) / radius; // screen y runs down
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= deadZone) return { x: 0, y: 0, magnitude: 0 };
  const magnitude = Math.min(1, (length - deadZone) / (1 - deadZone));
  return { x: (dx / length) * magnitude, y: (dy / length) * magnitude, magnitude };
}

/**
 * Where the stick's knob is drawn (px from its origin), clamped to its ring. The base stays
 * where the thumb landed: a thumb that runs past the ring holds full deflection there, and
 * the stick never creeps across the screen after it.
 */
export function stickKnob(
  ox: number,
  oy: number,
  x: number,
  y: number,
  radius = STICK.radius,
): { x: number; y: number } {
  const dx = x - ox;
  const dy = y - oy;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= radius) return { x: dx, y: dy };
  return { x: (dx / length) * radius, y: (dy / length) * radius };
}

/** Thresholds for one finger on the map: how far is a drag, how long is a long press. */
export const PRESS = { slop: 10, longMs: 550 };

/**
 * One finger's press: a tap (short and still), a long press (held still), or a drag
 * (moved further than the slop at any point). `null` while it's still undecided.
 */
export function classifyPress(
  ms: number,
  travel: number,
  released: boolean,
): 'tap' | 'long-press' | 'drag' | null {
  if (travel > PRESS.slop) return 'drag';
  if (ms >= PRESS.longMs) return 'long-press';
  return released ? 'tap' : null;
}

/**
 * Two-finger pinch: the new metres per pixel (zooming about the midpoint) from the
 * fingers' spread when the pinch started and now, clamped to the map's range.
 */
export function pinchScale(
  mppStart: number,
  spreadStart: number,
  spread: number,
  min: number,
  max: number,
): number {
  if (spreadStart <= 0 || spread <= 0) return mppStart;
  return Math.min(max, Math.max(min, mppStart * (spreadStart / spread)));
}

export type TouchMode = 'fly' | 'ski' | 'glide' | 'ride' | 'sled' | 'plane' | 'heli' | 'skydive';

/**
 * The keys the stick holds down in each mode, on top of its analog axes (`Input.stickX/Y`,
 * which steer, fly and drive directly). Skiing: push forward to skate and pole, pull back
 * to snowplough. Paragliding: forward is the speed bar, back the brakes. Snowmobile: back
 * brakes (held at a standstill it reverses, as S does). Fly mode, the plane and the
 * helicopter are all analog (the stick is the control stick or cyclic).
 */
export function stickKeys(mode: TouchMode, y: number): string[] {
  const forward = y > 0.5;
  const back = y < -0.5;
  if (mode === 'ski') return forward ? ['KeyW'] : back ? ['ShiftLeft'] : [];
  if (mode === 'glide') return forward ? ['KeyW'] : back ? ['KeyS'] : [];
  if (mode === 'sled') return back ? ['KeyS'] : [];
  return [];
}

/** How far sideways the stick goes before Stop becomes a hockey stop (fraction). */
export const HOCKEY_STICK = 0.3;

/**
 * The Stop button while skiing: a snowplough (0), or with the stick pushed sideways a
 * hockey stop to that side (+1 left, -1 right, like `Input.turn`). Once chosen, the side
 * holds until Stop is let go, even if the thumb eases back or leaves the stick; pushing
 * the other way swaps it. `side` is last frame's answer.
 */
export function stopSide(side: number, stickX: number): number {
  if (stickX < -HOCKEY_STICK) return 1;
  if (stickX > HOCKEY_STICK) return -1;
  return side;
}

/** Looking around by dragging: radians per pixel are this many times the mouse's. */
export const TOUCH_LOOK_GAIN = 1.6;
