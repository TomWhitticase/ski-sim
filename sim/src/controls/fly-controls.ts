import { Euler, type PerspectiveCamera, Vector3 } from 'three/webgpu';

import { FLY } from '../config';
import type { Pose } from '../nav/pose';
import { type Input, Look } from './input';

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Minecraft-style creative flight: WASD moves horizontally relative to where you face
 * (pitch doesn't affect it), Space rises, Shift descends, mouse looks around.
 * The mouse wheel changes fly speed. There's no body: you're a free camera (the skier
 * you flew out of stays where you left it; see main.ts).
 */
export class FlyControls {
  readonly look = new Look(FLY.mouseSensitivity);
  speed = FLY.speed;

  /** Where you are (eye position); the camera sits here. */
  readonly position = new Vector3();
  private readonly velocity = new Vector3();
  private readonly target = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly groundHeight: (x: number, z: number) => number,
    private readonly bounds: Bounds,
  ) {}

  /** Current flight velocity (m/s, world axes). */
  get currentVelocity(): Vector3 {
    return this.velocity;
  }

  get heading(): number {
    return this.look.heading;
  }

  get pitchDegrees(): number {
    return this.look.pitchDegrees;
  }

  /** Put the camera at a pose with no momentum. */
  place(pose: Pose): void {
    this.position.set(pose.east, pose.altitude, -pose.north);
    this.look.heading = pose.heading;
    this.look.pitchDegrees = pose.pitch;
    this.velocity.set(0, 0, 0);
    this.applyRotation();
  }

  update(dt: number, input: Input): void {
    this.look.apply(input);
    this.applyRotation();
    if (input.wheel !== 0) {
      const factor = Math.pow(1.15, -Math.sign(input.wheel));
      this.speed = Math.min(Math.max(this.speed * factor, FLY.minSpeed), FLY.maxSpeed);
    }

    const forward = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const strafe = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const lift = (input.down('Space') ? 1 : 0) - (input.down('ShiftLeft', 'ShiftRight') ? 1 : 0);

    const yaw = this.look.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Facing (-sin, -cos) in x/z; right is (cos, -sin).
    this.target.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe);
    if (this.target.lengthSq() > 1) this.target.normalize();
    this.target.y = lift;
    this.target.multiplyScalar(this.speed);

    this.velocity.lerp(this.target, 1 - Math.exp(-FLY.responsiveness * dt));
    const pos = this.position;
    pos.addScaledVector(this.velocity, dt);

    pos.x = Math.min(Math.max(pos.x, this.bounds.minX), this.bounds.maxX);
    pos.z = Math.min(Math.max(pos.z, this.bounds.minZ), this.bounds.maxZ);
    const floor = this.groundHeight(pos.x, pos.z) + FLY.minHeightAboveGround;
    if (pos.y < floor) {
      pos.y = floor;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
    this.applyRotation();
  }

  private applyRotation(): void {
    const cam = this.camera;
    cam.position.copy(this.position);
    this.euler.set(this.look.pitch, this.look.yaw, 0);
    cam.quaternion.setFromEuler(this.euler);
  }
}
