import { cameraSettings } from './camera-settings';

/**
 * Keyboard and mouse state shared by the fly and ski controllers. Keys only register
 * while the pointer is locked to the canvas; mouse motion, wheel and key presses are
 * accumulated between frames and cleared by endFrame().
 */
export class Input {
  mouseX = 0;
  mouseY = 0;
  wheel = 0;

  private readonly keys = new Set<string>();
  /** Keys pressed since the last frame, latched so taps shorter than a frame still count. */
  private readonly pressed = new Set<string>();

  constructor(private readonly element: HTMLElement) {
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onLockChange);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', this.release);
  }

  get locked(): boolean {
    return document.pointerLockElement === this.element;
  }

  async lock(): Promise<void> {
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

  down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
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
    if (!this.locked) this.release();
  };

  private readonly release = () => {
    this.keys.clear();
    this.pressed.clear();
  };
}

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
