import { cameraSettings } from './camera-settings';

/**
 * Keyboard and mouse state shared by the fly and ski controllers. Keys only register
 * while the pointer is locked to the canvas; mouse motion, wheel and key presses are
 * accumulated between frames and cleared by endFrame().
 *
 * Touch play (`touch-controls.ts`) drives the same state: on-screen buttons hold keys
 * (`hold`), the thumbstick sets `stickX`/`stickY` (read through `turn`, `forward` and
 * `throttle`) and look drags add to the mouse motion. There's no pointer lock on a
 * touchscreen, so `lock()` there just starts playing.
 */
export class Input {
  mouseX = 0;
  mouseY = 0;
  wheel = 0;
  /** The touch thumbstick, -1..1: x right, y forward. 0 when it isn't held. */
  stickX = 0;
  stickY = 0;
  /** Touch controls are in use (no pointer lock; `locked` means playing). */
  touch = false;

  private readonly keys = new Set<string>();
  /** Keys held by on-screen buttons and by the stick. */
  private readonly held = new Set<string>();
  private readonly stickHeld = new Set<string>();
  /** Keys pressed since the last frame, latched so taps shorter than a frame still count. */
  private readonly pressed = new Set<string>();
  /** Playing on a touchscreen (the stand-in for pointer lock). */
  private playing = false;

  constructor(private readonly element: HTMLElement) {
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onLockChange);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', this.release);
  }

  /** Playing: the mouse is captured, or (touch) the game isn't paused. */
  get locked(): boolean {
    return document.pointerLockElement === this.element || this.playing;
  }

  async lock(): Promise<void> {
    if (this.touch) {
      this.setPlaying(true);
      return;
    }
    try {
      // Raw mouse input (no OS acceleration) feels closest to a game.
      await this.element.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try {
        await this.element.requestPointerLock();
      } catch {
        // Refused (e.g. no user gesture); the start overlay stays up instead.
      }
    }
  }

  /** Pause: release the mouse, or stop touch play. */
  unlock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    this.setPlaying(false);
  }

  down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c) || this.held.has(c) || this.stickHeld.has(c));
  }

  /** An on-screen button holds `code` down (or lets it go), like a key. */
  hold(code: string, on: boolean): void {
    if (on && !this.held.has(code)) this.pressed.add(code);
    if (on) this.held.add(code);
    else this.held.delete(code);
  }

  /** A tap of `code`: pressed this frame, never held. */
  tap(code: string): void {
    this.pressed.add(code);
  }

  /** The keys the stick holds this frame (`stickKeys`). */
  setStickKeys(codes: readonly string[]): void {
    for (const c of codes) if (!this.stickHeld.has(c)) this.pressed.add(c);
    this.stickHeld.clear();
    for (const c of codes) this.stickHeld.add(c);
  }

  /** A look drag on a touchscreen, in pixels (scaled like mouse motion). */
  look(dx: number, dy: number): void {
    if (!this.locked) return;
    this.mouseX += dx;
    this.mouseY += dy;
  }

  /** Steering, -1..1: +1 is full left (A), -1 full right (D), the stick anywhere between. */
  get turn(): number {
    return clamp1((this.down('KeyA') ? 1 : 0) - (this.down('KeyD') ? 1 : 0) - this.stickX);
  }

  /** Forward (W, stick up) to back (S, stick down), -1..1. */
  get forward(): number {
    return clamp1((this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0) + this.stickY);
  }

  /** Throttle 0..1: W, or the stick pushed forward. */
  get throttle(): number {
    return Math.max(this.down('KeyW') ? 1 : 0, Math.min(1, this.stickY));
  }

  /** Pressed at some point since the previous frame (even if already released). */
  wasPressed(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  endFrame(): void {
    this.pressed.clear();
    this.mouseX = 0;
    this.mouseY = 0;
    this.wheel = 0;
  }

  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mouseX += e.movementX;
    this.mouseY += e.movementY;
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.locked) return;
    // Stop Space scrolling and Ctrl+S/D/A etc. triggering browser shortcuts mid-flight.
    // (Ctrl+W can't be intercepted on Windows/Linux; main.ts guards against closing.)
    if (e.code === 'Space' || e.ctrlKey) e.preventDefault();
    if (!e.repeat) this.pressed.add(e.code);
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.locked) return;
    e.preventDefault();
    this.wheel += e.deltaY;
  };

  private readonly onLockChange = () => {
    // The real thing replaces touch play (a tablet's mouse was clicked to capture it).
    if (document.pointerLockElement === this.element) this.playing = false;
    if (!this.locked) this.release();
  };

  private setPlaying(on: boolean): void {
    if (on === this.playing) return;
    this.playing = on;
    // Everything listening for pointer lock (menus, HUD) hears about touch play too.
    document.dispatchEvent(new Event('pointerlockchange'));
  }

  private readonly release = () => {
    this.keys.clear();
    this.held.clear();
    this.stickHeld.clear();
    this.pressed.clear();
    this.stickX = 0;
    this.stickY = 0;
  };
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/** Yaw/pitch mouse look shared by both controllers. Yaw 0 faces north; positive turns left. */
export class Look {
  yaw = 0;
  pitch = 0;

  constructor(private readonly sensitivity: number) {}

  /** Heading in degrees clockwise from north. */
  get heading(): number {
    return ((((-this.yaw * 180) / Math.PI) % 360) + 360) % 360;
  }

  set heading(degrees: number) {
    this.yaw = (-degrees * Math.PI) / 180;
  }

  get pitchDegrees(): number {
    return (this.pitch * 180) / Math.PI;
  }

  set pitchDegrees(degrees: number) {
    this.pitch = (degrees * Math.PI) / 180;
  }

  apply(input: Input, pitchLimit = Math.PI / 2 - 0.001): void {
    const k = this.sensitivity * cameraSettings.sensitivity;
    this.yaw -= input.mouseX * k;
    this.pitch -= input.mouseY * k * (cameraSettings.invertY ? -1 : 1);
    this.pitch = Math.min(Math.max(this.pitch, -pitchLimit), pitchLimit);
  }
}
