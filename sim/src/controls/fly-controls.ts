import { Euler, type PerspectiveCamera, Vector3 } from 'three/webgpu';

import { FLY } from '../config';

export interface FlyBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Minecraft-style creative flight: WASD moves horizontally relative to where you face
 * (pitch doesn't affect it), Space rises, Shift descends, mouse looks around.
 * Ctrl sprints (and keeps sprinting until you stop flying forward, as in Minecraft);
 * the mouse wheel changes fly speed.
 */
export class FlyControls {
  /** Radians; 0 faces north, positive turns left (counter-clockwise from above). */
  yaw = 0;
  pitch = 0;
  speed = FLY.speed;
  sprinting = false;

  private readonly velocity = new Vector3();
  private readonly target = new Vector3();
  private readonly keys = new Set<string>();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private ctrlTapped = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly element: HTMLElement,
    private readonly groundHeight: (x: number, z: number) => number,
    private readonly bounds: FlyBounds,
  ) {
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onLockChange);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', this.releaseKeys);
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
        // Refused (e.g. no user gesture); the "Click to fly" overlay stays up instead.
      }
    }
  }

  /** Heading in degrees clockwise from north. */
  get heading(): number {
    return ((((-this.yaw * 180) / Math.PI) % 360) + 360) % 360;
  }

  setHeading(degrees: number): void {
    this.yaw = (-degrees * Math.PI) / 180;
    this.applyRotation();
  }

  /** Degrees; negative looks down. */
  get pitchDegrees(): number {
    return (this.pitch * 180) / Math.PI;
  }

  /** Kill any momentum, e.g. after a teleport. */
  stop(): void {
    this.velocity.set(0, 0, 0);
    this.sprinting = false;
  }

  setPitch(degrees: number): void {
    this.pitch = (degrees * Math.PI) / 180;
    this.applyRotation();
  }

  update(dt: number): void {
    const forward = (this.key('KeyW') ? 1 : 0) - (this.key('KeyS') ? 1 : 0);
    const strafe = (this.key('KeyD') ? 1 : 0) - (this.key('KeyA') ? 1 : 0);
    const lift = (this.key('Space') ? 1 : 0) - (this.shiftDown() ? 1 : 0);
    if (forward <= 0) this.sprinting = false;
    else if (this.ctrlDown() || this.ctrlTapped) this.sprinting = true;
    this.ctrlTapped = false;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Facing (-sin, -cos) in x/z; right is (cos, -sin).
    this.target.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe);
    if (this.target.lengthSq() > 1) this.target.normalize();
    this.target.y = lift;
    this.target.multiplyScalar(this.speed * (this.sprinting ? FLY.sprintMultiplier : 1));

    this.velocity.lerp(this.target, 1 - Math.exp(-FLY.responsiveness * dt));
    const pos = this.camera.position;
    pos.addScaledVector(this.velocity, dt);

    pos.x = Math.min(Math.max(pos.x, this.bounds.minX), this.bounds.maxX);
    pos.z = Math.min(Math.max(pos.z, this.bounds.minZ), this.bounds.maxZ);
    const floor = this.groundHeight(pos.x, pos.z) + FLY.minHeightAboveGround;
    if (pos.y < floor) {
      pos.y = floor;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
  }

  dispose(): void {
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.element.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.releaseKeys);
  }

  private key(code: string): boolean {
    return this.keys.has(code);
  }

  private ctrlDown(): boolean {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight');
  }

  private shiftDown(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  private applyRotation(): void {
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
  }

  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.yaw -= e.movementX * FLY.mouseSensitivity;
    this.pitch -= e.movementY * FLY.mouseSensitivity;
    const limit = Math.PI / 2 - 0.001;
    this.pitch = Math.min(Math.max(this.pitch, -limit), limit);
    this.applyRotation();
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.locked) return;
    // Stop Space scrolling and Ctrl+S/D/A etc. triggering browser shortcuts mid-flight.
    // (Ctrl+W can't be intercepted on Windows/Linux; main.ts guards against closing.)
    if (e.code === 'Space' || e.ctrlKey) e.preventDefault();
    // Latch so a tap shorter than a frame still counts.
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') this.ctrlTapped = true;
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.locked) return;
    e.preventDefault();
    const factor = Math.pow(1.15, -Math.sign(e.deltaY));
    this.speed = Math.min(Math.max(this.speed * factor, FLY.minSpeed), FLY.maxSpeed);
  };

  private readonly onLockChange = () => {
    if (!this.locked) this.releaseKeys();
  };

  private readonly releaseKeys = () => {
    this.keys.clear();
    this.sprinting = false;
  };
}
