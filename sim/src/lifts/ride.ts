import { Euler, Matrix4, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

import { FLY } from '../config';
import { type Input, Look } from '../controls/input';
import type { SkiControls } from '../controls/ski-controls';
import { floorBelowGrip } from './carriers';
import { type LiftLine, type LiftSystem, nextDeparture } from './lift-system';

const FAST_FORWARD = 8;
const CHASE_DISTANCE = 6;
/** Walking pace on the way to the loading point after pressing E (m/s). */
const WALK_SPEED = 3;
/** Seconds to settle into the seat once the carrier reaches you. */
const BOARD_BLEND = 0.5;

export type RidePhase = 'approach' | 'waiting' | 'boarding' | 'riding';

/**
 * Getting on, riding and getting off a lift, with no teleports:
 * - approach (after pressing E): walk to the loading point;
 * - waiting: stand on the loading point until the next carrier reaches you (you can also
 *   ski into the loading zone yourself; LiftSystem.scoop() starts you at `boarding`);
 * - boarding: settle into the seat/cabin as it carries you along;
 * - riding: until your carrier passes the unloading point, where you're released.
 * Hold W to fast-forward the lift clock; S skips straight to the top.
 */
export class RideControls {
  readonly look = new Look(FLY.mouseSensitivity);
  line = 0;
  carrier = 0;
  phase: RidePhase = 'waiting';
  readonly velocity = new Vector3();
  private readonly waypoints: Vector3[] = [];
  private blend = 0;
  private moved = false;
  private readonly blendFrom = new Vector3();
  private readonly grip = new Matrix4();
  private readonly gripPos = new Vector3();
  private readonly gripQ = new Quaternion();
  private readonly travel = new Vector3();
  private readonly feet = new Vector3();
  private readonly seat = new Vector3();
  private readonly lastFeet = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private bodyYaw = 0;

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
    return this.lineObj.name;
  }

  private get lineObj(): LiftLine {
    return this.lifts.lines[this.line]!;
  }

  /** Seconds until you're picked up while waiting (cable car: until it departs). */
  get departsIn(): number {
    const line = this.lineObj;
    if (line.tracks) return nextDeparture(line.op, this.lifts.time);
    return line.nextToLoad(this.lifts.time).inSeconds;
  }

  /** How far from the loading point you are (m, for tower clacks): 0 until riding. */
  get distance(): number {
    return this.phase === 'riding' ? this.feet.distanceTo(this.lineObj.loadPoint) : 0;
  }

  /** Teleports end the ride first (see main.ts), so there's nothing to place here. */
  place(): void {}

  /** Press-E boarding: walk from `from` to the loading point, then wait there. */
  approach(line: number, from: Vector3, lookYaw: number): void {
    this.line = line;
    const l = this.lineObj;
    this.waypoints.length = 0;
    this.waypoints.push(...l.entryPath());
    this.feet.copy(from);
    this.lastFeet.copy(from);
    this.look.yaw = lookYaw;
    this.look.pitch = 0;
    this.phase = 'approach';
    this.velocity.set(0, 0, 0);
  }

  /** Start boarding a specific carrier from where you are (skied into the loading zone). */
  boardFrom(line: number, carrier: number, from: Vector3, lookYaw: number): void {
    this.line = line;
    this.feet.copy(from);
    this.lastFeet.copy(from);
    this.look.yaw = lookYaw;
    this.look.pitch = 0;
    this.startBoarding(carrier);
  }

  /** Returns true once you've been released at the top (or S skipped there). */
  update(dt: number, input: Input): boolean {
    this.look.apply(input);
    const lifts = this.lifts;
    lifts.rate = input.down('KeyW') && this.phase !== 'approach' ? FAST_FORWARD : 1;
    if (input.wasPressed('KeyS')) {
      this.skipToTop();
      return true;
    }
    const line = this.lineObj;

    if (this.phase === 'approach') {
      const target = this.waypoints[0]!;
      const step = WALK_SPEED * dt;
      const to = target.clone().sub(this.feet).setY(0);
      if (to.length() <= step) {
        this.feet.copy(target);
        this.waypoints.shift();
        if (!this.waypoints.length) this.phase = 'waiting';
      } else {
        to.setLength(step);
        this.feet.add(to);
        this.bodyYaw = Math.atan2(-to.x, -to.z);
      }
      this.feet.y = this.skier.groundAt(this.feet.x, this.feet.z);
    } else if (this.phase === 'waiting') {
      const t = line.bottomTerminal;
      this.bodyYaw = Math.atan2(-t.dir[0], t.dir[1]);
      if (line.tracks) {
        if (nextDeparture(line.op, lifts.time) === 0) this.startBoarding(0);
      } else {
        const { carrier } = line.nextToLoad(lifts.previousTime);
        if (line.passed(carrier, line.loadTime, lifts.previousTime, lifts.time)) {
          this.startBoarding(carrier);
        }
      }
    }

    if (this.phase === 'boarding' || this.phase === 'riding') {
      const pose = lifts.carrierMatrix(this.line, this.carrier, this.grip);
      this.grip.decompose(this.gripPos, this.gripQ, new Vector3());
      this.travel.set(0, 0, -1).applyQuaternion(this.gripQ);
      this.seatPosition(pose.side);
      if (this.phase === 'boarding') {
        this.blend = Math.min(1, this.blend + dt / BOARD_BLEND);
        const k = this.blend * this.blend * (3 - 2 * this.blend);
        this.feet.copy(this.blendFrom).lerp(this.seat, k);
        if (this.blend >= 1) this.phase = 'riding';
      } else {
        this.feet.copy(this.seat);
      }
      this.bodyYaw = new Euler().setFromQuaternion(this.gripQ, 'YXZ').y;
      if (pose.moving) this.moved = true;
    }

    if (dt > 0) this.velocity.copy(this.feet).sub(this.lastFeet).divideScalar(dt);
    this.lastFeet.copy(this.feet);
    this.pose();

    if (this.phase !== 'riding') return false;
    if (line.tracks) {
      const p = line.pose(this.carrier, lifts.time, new Vector3(), new Vector3());
      return this.moved && !p.moving && p.distance > line.op.length / 2;
    }
    return line.passed(this.carrier, line.unloadTime, lifts.previousTime, lifts.time);
  }

  /** Where to put you when you get off, and how you're moving. */
  release(): { feet: Vector3; velocity: Vector3; heading: number } {
    const line = this.lineObj;
    const t = line.topTerminal;
    const out = new Vector3(-t.dir[0], 0, t.dir[1]); // onward, past the bullwheel
    const velocity = new Vector3();
    if (line.op.kind === 'gondola' || line.op.kind === 'cabin') {
      // Out through the station's exit door: in its side wall, or round the back.
      if (t.entrance === 'back') velocity.copy(out).multiplyScalar(2);
      else velocity.copy(line.across).multiplyScalar(2).addScaledVector(out, 0.3);
    } else {
      const speed = Math.max(Math.hypot(this.velocity.x, this.velocity.z) / this.lifts.rate, 2.5);
      velocity.copy(out).multiplyScalar(speed);
    }
    const heading = (Math.atan2(velocity.x, -velocity.z) * 180) / Math.PI;
    return { feet: this.feet.clone(), velocity, heading };
  }

  /** Lift clock back to normal speed (call when leaving). */
  releaseClock(): void {
    this.lifts.rate = 1;
  }

  private startBoarding(carrier: number): void {
    this.carrier = carrier;
    this.blendFrom.copy(this.feet);
    this.blend = 0;
    this.moved = false;
    this.phase = 'boarding';
  }

  /** S: off at the top unloading point, as if you'd ridden it. */
  private skipToTop(): void {
    this.feet.copy(this.lineObj.unloadPoint);
    this.velocity.set(0, 0, 0);
    this.phase = 'riding';
  }

  /** Your feet on the carrier (seat, cabin floor, or behind a platter on the snow). */
  private seatPosition(side: 1 | -1): void {
    const line = this.lineObj;
    const { kind, hang } = line.op;
    const local = new Vector3();
    if (kind === 'chair') {
      local.set(line.seats * 0.25 - 0.35, -(floorBelowGrip(kind, line.seats, hang) + 0.5), -0.12);
    } else if (kind === 'gondola') {
      local.set(0.3, -floorBelowGrip(kind, line.seats, hang) + 0.02, 0.2);
    } else if (kind === 'cabin') {
      local.set(0.8, -floorBelowGrip(kind, line.seats, hang) + 0.02, -1.5);
    } else {
      const { platter } = this.lifts.platterPose(this.gripPos, this.travel, side);
      this.seat.set(platter.x, this.skier.groundAt(platter.x, platter.z), platter.z);
      return;
    }
    this.seat.copy(local).applyQuaternion(this.gripQ).add(this.gripPos);
  }

  /** Pose the skier model and camera. */
  private pose(): void {
    const kind = this.lineObj.op.kind;
    const crouch =
      kind === 'chair' && this.phase === 'riding'
        ? 0.62
        : kind === 'chair' && this.phase === 'boarding'
          ? 0.15 + 0.47 * this.blend
          : 0.15;
    this.skier.showRiding(this.feet, this.bodyYaw, crouch);
    const eye = 1.62 - 0.7 * Math.max(0, crouch - 0.15);
    if (this.skier.view === 'first-person') {
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
}
