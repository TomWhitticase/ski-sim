import { Euler, Matrix4, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

import { FLY } from '../config';
import { type Input, Look } from '../controls/input';
import type { SkiControls } from '../controls/ski-controls';
import type { LiftSystem } from './lift-system';
import { nextDeparture } from './operation';

const FAST_FORWARD = 8;
const CHASE_DISTANCE = 6;

/**
 * Riding a lift. You're attached to one carrier and move with it; at the top you're
 * handed back to ski mode. Hold W to fast-forward the lift clock; S skips to the top.
 */
export class RideControls {
  readonly look = new Look(FLY.mouseSensitivity);
  line = 0;
  carrier = 0;
  /** Waiting at a jig-back station for the cabin to leave. */
  waiting = false;
  private moved = false;
  private readonly grip = new Matrix4();
  private readonly gripPos = new Vector3();
  private readonly gripQ = new Quaternion();
  private readonly feet = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly offset = new Vector3();
  private readonly lastFeet = new Vector3();
  readonly velocity = new Vector3();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly lifts: LiftSystem,
    private readonly skier: SkiControls,
  ) {}

  get heading(): number {
    return this.look.heading;
  }

  get pitchDegrees(): number {
    return this.look.pitchDegrees;
  }

  get position(): Vector3 {
    return this.feet;
  }

  get name(): string {
    return this.lifts.lines[this.line]!.name;
  }

  /** How far up the line you are (m); 0 while waiting. */
  get distance(): number {
    return this.waiting ? 0 : this.lifts.carrierState(this.line, this.carrier).distance;
  }

  /** Seconds until departure while waiting for a cable car, else 0. */
  get departsIn(): number {
    const op = this.lifts.lines[this.line]!.op;
    return op.reversible ? nextDeparture(op, this.lifts.time) : 0;
  }

  /** Teleports end the ride first (see main.ts), so there's nothing to place here. */
  place(): void {}

  board(line: number, lookYaw: number): void {
    this.line = line;
    const op = this.lifts.lines[line]!.op;
    this.carrier = op.reversible ? 0 : this.lifts.nextCarrier(line);
    this.waiting = op.reversible && nextDeparture(op, this.lifts.time) > 0;
    this.moved = false;
    this.look.yaw = lookYaw;
    this.look.pitch = 0;
    this.attach();
    this.lastFeet.copy(this.feet);
    this.velocity.set(0, 0, 0);
  }

  /** Returns true when you've arrived at the top. */
  update(dt: number, input: Input): boolean {
    this.look.apply(input);
    this.lifts.rate = input.down('KeyW') ? FAST_FORWARD : 1;
    // S skips the rest of the ride: straight off at the top.
    if (input.wasPressed('KeyS')) return true;
    const op = this.lifts.lines[this.line]!.op;

    if (this.waiting) {
      // Stand by the bottom station until the cabin is boarding.
      if (nextDeparture(op, this.lifts.time) === 0) this.waiting = false;
    }
    const state = this.lifts.carrierState(this.line, this.carrier);
    if (state.moving) this.moved = true;
    this.attach();
    if (dt > 0)
      this.velocity
        .copy(this.feet)
        .sub(this.lastFeet)
        .divideScalar(dt * this.lifts.rate);
    this.lastFeet.copy(this.feet);

    if (op.reversible) return this.moved && !state.moving && state.distance > op.length / 2;
    return state.side === -1;
  }

  /** Lift clock back to normal speed (call when leaving). */
  release(): void {
    this.lifts.rate = 1;
  }

  /** Put you in or on the carrier and place the camera. */
  private attach(): void {
    const line = this.lifts.lines[this.line]!;
    const { kind, hang } = line.op;
    let crouch = 0.15;
    if (this.waiting) {
      // On the platform below the bottom station, facing up the line.
      line.cablePoint(0, 1, this.gripPos);
      this.gripPos.y -= hang;
      const ahead = line.top.clone().sub(line.bottom).setY(0).normalize();
      this.gripQ.setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(-ahead.x, -ahead.z));
    } else {
      this.lifts.carrierMatrix(this.line, this.carrier, this.grip);
      this.grip.decompose(this.gripPos, this.gripQ, new Vector3());
    }

    if (kind === 'chair') {
      // Seated on the right-hand end of the chair.
      this.offset.set(line.seats * 0.25 - 0.35, -hang - 0.5, -0.12);
      crouch = 0.62;
    } else if (kind === 'gondola') {
      this.offset.set(0.3, -hang - 0.85, 0.2);
    } else if (kind === 'cabin') {
      this.offset.set(0.8, -hang - 1.35, -1.5);
    } else {
      this.offset.set(0, 0, 0.9);
    }
    if (this.waiting) this.offset.set(0, 0, 0);
    this.feet.copy(this.offset).applyQuaternion(this.gripQ).add(this.gripPos);
    if (kind === 'platter' || kind === 'tbar') {
      // Towed along the snow under the line.
      this.feet.y = this.skierGround(this.feet);
    }
    const yaw = new Euler().setFromQuaternion(this.gripQ, 'YXZ').y;
    this.skier.showRiding(this.feet, yaw, crouch);

    const eye = crouch > 0.5 ? 1.18 : 1.62;
    if (this.camera && this.skier.view === 'first-person') {
      this.camera.position.set(this.feet.x, this.feet.y + eye, this.feet.z);
      this.euler.set(this.look.pitch, this.look.yaw, 0);
      this.camera.quaternion.setFromEuler(this.euler);
    } else {
      const elevation = 0.25 - this.look.pitch;
      const back = CHASE_DISTANCE * Math.cos(elevation);
      this.camera.position.set(
        this.feet.x + Math.sin(this.look.yaw) * back,
        this.feet.y + 1 + CHASE_DISTANCE * Math.sin(elevation),
        this.feet.z + Math.cos(this.look.yaw) * back,
      );
      this.camera.lookAt(this.feet.x, this.feet.y + 1, this.feet.z);
    }
  }

  private skierGround(p: Vector3): number {
    return this.skier.groundAt(p.x, p.z);
  }
}
