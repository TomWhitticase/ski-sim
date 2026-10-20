import { cameraSettings } from '../controls/camera-settings';
import { Euler, Matrix4, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

import { CAMERA, FLY } from '../config';
import { type Input, Look } from '../controls/input';
import type { SkiControls } from '../controls/ski-controls';
import { CabinView } from './cabin-view';
import { backBench, type CabinLayout, cabinLayout, floorBelowGrip } from './carriers';
import { type LiftLine, type LiftSystem, nextDeparture } from './lift-system';

const UP = new Vector3(0, 1, 0);
const FAST_FORWARD = 8;
const CHASE_DISTANCE = 6;
/** Seconds to settle into the seat once the carrier reaches you. */
const BOARD_BLEND = 0.5;
/** Seconds to step in through a cabin's door and sit down (or find your spot). */
const CABIN_BLEND = 1.8;
/** Seated on a cabin bench: hips above the bench top, and behind the feet (m). */
const HIP_ABOVE_SEAT = 0.1;
const SEAT_REACH = 0.42;
/** Seated eye above the hips; standing eye above the feet (m). */
const SEATED_EYE = 0.7;
const STANDING_EYE = 1.62;
/** Near plane inside a cabin, so walls an arm's length away aren't clipped (m). */
const CABIN_NEAR = 0.05;

export type RidePhase = 'waiting' | 'boarding' | 'riding';

/**
 * Getting on, riding and getting off a lift:
 * - waiting: E puts you straight on the loading point, where you wait for the next
 *   carrier (you can also ski into the loading zone yourself; LiftSystem.scoop() starts
 *   you at `boarding`);
 * - boarding: settle into the seat/cabin as it carries you along;
 * - riding: until your carrier passes the unloading point, where you're released.
 * Gondolas and cable cars run both ways: boarding at the top (`down`) rides the down
 * track and lets you off at the bottom.
 * Hold W to fast-forward the lift clock; S skips straight to the end.
 */
export class RideControls {
  readonly look = new Look(FLY.mouseSensitivity);
  line = 0;
  carrier = 0;
  phase: RidePhase = 'waiting';
  /** Riding down (boarded at the top station). */
  down = false;
  /** Hold W to run the lift clock faster (off in multiplayer, where the clock is shared). */
  fastForward = true;
  readonly velocity = new Vector3();
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
  /** The cabin you're in (gondolas and cable cars), from boarding until you're off. */
  private readonly cabinView = new CabinView();
  private cabin: CabinLayout | null = null;
  /** Inside a cabin: where you started boarding, in the cabin's frame. */
  private readonly fromLocal = new Vector3();
  private lookFrom = 0;
  /** Seated amount (0 standing, 1 on the bench). */
  private sit = 0;
  private skipped = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly lifts: LiftSystem,
    private readonly skier: SkiControls,
  ) {
    lifts.root.add(this.cabinView.root);
  }

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
    return line.nextToLoad(this.lifts.time, this.down).inSeconds;
  }

  /** How far from the loading point you are (m, for tower clacks): 0 until riding. */
  get distance(): number {
    return this.phase === 'riding' ? this.feet.distanceTo(this.lineObj.loadPoint) : 0;
  }

  /** Teleports end the ride first (see main.ts), so there's nothing to place here. */
  place(): void {}

  /**
   * Press-E boarding: step straight onto the loading point, facing along the line, and
   * wait. `down`: at the top station, to ride down.
   */
  approach(line: number, down = false): void {
    this.setLine(line);
    this.down = down && this.lineObj.down !== null;
    const l = this.lineObj;
    const t = this.startTerminal;
    this.feet.copy(l.loadingSpot(this.down));
    this.feet.y = this.skier.groundAt(this.feet.x, this.feet.z);
    this.lastFeet.copy(this.feet);
    this.bodyYaw = Math.atan2(-t.dir[0], t.dir[1]);
    this.look.yaw = this.bodyYaw;
    this.look.pitch = 0;
    this.phase = 'waiting';
    this.velocity.set(0, 0, 0);
  }

  /** Start boarding a specific carrier from where you are (skied into the loading zone). */
  boardFrom(line: number, carrier: number, from: Vector3, lookYaw: number): void {
    this.setLine(line);
    this.down = false;
    this.feet.copy(from);
    this.lastFeet.copy(from);
    this.look.yaw = lookYaw;
    this.look.pitch = 0;
    this.startBoarding(carrier);
  }

  /** Returns true once you've been released at the end (or S skipped there). */
  update(dt: number, input: Input): boolean {
    this.look.apply(input);
    const lifts = this.lifts;
    // The rate the lift clock just ran at (this frame's carriers), before W changes it.
    const rate = lifts.rate;
    lifts.rate = this.fastForward && input.down('KeyW') ? FAST_FORWARD : 1;
    if (input.wasPressed('KeyS')) {
      this.skipToEnd();
      return true;
    }
    const line = this.lineObj;

    if (this.phase === 'waiting') {
      const t = this.startTerminal;
      this.bodyYaw = Math.atan2(-t.dir[0], t.dir[1]);
      if (line.tracks) {
        if (nextDeparture(line.op, lifts.time) === 0) this.startBoarding(this.down ? 1 : 0);
      } else {
        const { carrier } = line.nextToLoad(lifts.previousTime, this.down);
        const mark = this.down ? line.down!.loadTime : line.loadTime;
        if (line.passed(carrier, mark, lifts.previousTime, lifts.time)) {
          this.startBoarding(carrier);
        }
      }
    }

    if (this.phase === 'boarding' || this.phase === 'riding') {
      const pose = lifts.carrierMatrix(this.line, this.carrier, this.grip);
      this.grip.decompose(this.gripPos, this.gripQ, new Vector3());
      this.travel.set(0, 0, -1).applyQuaternion(this.gripQ);
      const yaw = new Euler().setFromQuaternion(this.gripQ, 'YXZ').y;
      if (this.cabin) {
        this.lifts.hidden = [this.line, this.carrier];
        this.cabinView.show(`${line.op.kind}-${line.seats}-${line.op.hang}`, this.cabin, this.grip);
        this.inCabin(dt, yaw);
      } else {
        this.seatPosition(pose.side);
        if (this.phase === 'boarding') {
          this.blend = Math.min(1, this.blend + dt / BOARD_BLEND);
          const k = this.blend * this.blend * (3 - 2 * this.blend);
          this.feet.copy(this.blendFrom).lerp(this.seat, k);
          if (this.blend >= 1) this.phase = 'riding';
        } else {
          this.feet.copy(this.seat);
        }
        this.bodyYaw = yaw;
      }
      if (pose.moving) this.moved = true;
    }

    // Real speed, not fast-forwarded: jumping off keeps it.
    if (dt > 0)
      this.velocity
        .copy(this.feet)
        .sub(this.lastFeet)
        .divideScalar(dt * rate);
    this.lastFeet.copy(this.feet);
    this.pose();

    if (this.phase !== 'riding') return false;
    if (line.tracks) {
      const p = line.pose(this.carrier, lifts.time, new Vector3(), new Vector3());
      const atTop = p.distance > line.op.length / 2;
      return this.moved && !p.moving && atTop !== this.down;
    }
    const mark = this.down ? line.down!.unloadTime : line.unloadTime;
    return line.passed(this.carrier, mark, lifts.previousTime, lifts.time);
  }

  /** The station you board at: the bottom, or the top riding down. */
  private get startTerminal() {
    return this.down ? this.lineObj.topTerminal : this.lineObj.bottomTerminal;
  }

  /** Where to put you when you get off, and how you're moving. */
  release(): { feet: Vector3; velocity: Vector3; heading: number } {
    const line = this.lineObj;
    if (this.down) {
      // Off on the down track's platform, then out the way you'd come in to ride up.
      const t = line.bottomTerminal;
      const feet = line.loadingSpot();
      feet.y = this.skier.groundAt(feet.x, feet.z);
      const out = new Vector3(-t.dir[0], 0, t.dir[1]); // behind the bullwheel
      const velocity =
        t.entrance === 'back' ? out.multiplyScalar(2) : line.across.clone().multiplyScalar(2);
      const heading = (Math.atan2(velocity.x, -velocity.z) * 180) / Math.PI;
      return { feet, velocity, heading };
    }
    const t = line.topTerminal;
    const out = new Vector3(-t.dir[0], 0, t.dir[1]); // onward, past the bullwheel
    const velocity = new Vector3();
    if (this.cabin) {
      // Out through the station's exit door (side wall, or round the back), from the
      // cabin's doorway.
      if (!this.skipped) this.toWorld(this.feet.set(this.cabin.w / 2 - 0.2, this.cabin.floor, 0));
      if (t.entrance === 'back') velocity.copy(out).multiplyScalar(2);
      else velocity.copy(line.across).multiplyScalar(2).addScaledVector(out, 0.3);
    } else {
      const speed = Math.max(Math.hypot(this.velocity.x, this.velocity.z), 2.5);
      velocity.copy(out).multiplyScalar(speed);
    }
    const heading = (Math.atan2(velocity.x, -velocity.z) * 180) / Math.PI;
    return { feet: this.feet.clone(), velocity, heading };
  }

  /** Lift clock back to normal speed, your cabin back to the others (call when leaving). */
  leave(): void {
    this.lifts.rate = 1;
    this.lifts.hidden = null;
    this.cabinView.hide();
    this.setNear(CAMERA.near);
  }

  private setLine(line: number): void {
    this.line = line;
    const { kind, hang } = this.lineObj.op;
    this.cabin =
      kind === 'gondola' || kind === 'cabin' ? cabinLayout(kind, this.lineObj.seats, hang) : null;
  }

  private startBoarding(carrier: number): void {
    this.carrier = carrier;
    this.blendFrom.copy(this.feet);
    this.blend = 0;
    this.moved = false;
    this.skipped = false;
    this.phase = 'boarding';
    if (this.cabin) {
      // Where you're standing, in the cabin's frame as it arrives.
      this.lifts.carrierMatrix(this.line, carrier, this.grip);
      this.fromLocal.copy(this.feet).applyMatrix4(this.grip.clone().invert());
      this.lookFrom = this.look.yaw;
      this.sit = 0;
    }
  }

  /** S: off at the unloading point (top, or bottom riding down), as if you'd ridden it. */
  private skipToEnd(): void {
    this.feet.copy(this.down ? this.lineObj.down!.unloadPoint : this.lineObj.unloadPoint);
    this.velocity.set(0, 0, 0);
    this.phase = 'riding';
    this.skipped = true;
  }

  /** Cabin-frame point to world (in place). */
  private toWorld(p: Vector3): Vector3 {
    return p.applyMatrix4(this.grip);
  }

  /**
   * In a cabin: step in through the door, then sit on the back bench facing the way
   * you're going (gondola) or stand at the front window (cable car). Boarding blends
   * along that path in the cabin's frame, so you move with it and never cross a wall.
   */
  private inCabin(dt: number, yaw: number): void {
    const c = this.cabin!;
    const bench = backBench(c);
    const door = new Vector3(c.w / 2 - 0.4, c.floor, 0);
    const spot = bench
      ? new Vector3(-c.w / 4, c.floor, bench.z - SEAT_REACH)
      : new Vector3(-c.w / 6, c.floor, -c.d / 2 + 0.8);
    let k = 1;
    if (this.phase === 'boarding') {
      this.blend = Math.min(1, this.blend + dt / CABIN_BLEND);
      k = this.blend;
      if (this.blend >= 1) this.phase = 'riding';
    }
    const smooth = (x: number) => {
      const t = Math.min(Math.max(x, 0), 1);
      return t * t * (3 - 2 * t);
    };
    // First 40%: in through the door, facing in (-x). Then over to your spot.
    const local =
      k < 0.4
        ? this.fromLocal.clone().lerp(door, smooth(k / 0.4))
        : door.clone().lerp(spot, smooth((k - 0.4) / 0.6));
    local.y = c.floor;
    this.feet.copy(this.toWorld(local));
    const turn = (Math.PI / 2) * (1 - smooth((k - 0.4) / 0.5));
    this.bodyYaw = yaw + turn;
    this.sit = bench ? smooth((k - 0.6) / 0.4) : 0;
    if (this.phase === 'boarding') {
      // Turn your head with your body as you sit down.
      let d = yaw - this.lookFrom;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.look.yaw = this.lookFrom + d * smooth(k / 0.9);
    }
  }

  private setNear(near: number): void {
    if (this.camera.near === near) return;
    this.camera.near = near;
    this.camera.updateProjectionMatrix();
  }

  /** Your feet on the carrier (chair seat, or behind a platter on the snow). */
  private seatPosition(side: 1 | -1): void {
    const line = this.lineObj;
    const { kind, hang } = line.op;
    const local = new Vector3();
    if (kind === 'chair') {
      local.set(line.seats * 0.25 - 0.35, -(floorBelowGrip(kind, line.seats, hang) + 0.5), -0.12);
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
    const inside = this.cabin !== null && (this.phase === 'boarding' || this.phase === 'riding');
    const bench = inside ? backBench(this.cabin!) : null;
    const sit = bench
      ? { amount: this.sit, height: bench.top + HIP_ABOVE_SEAT, back: SEAT_REACH }
      : undefined;
    this.skier.showRiding(this.feet, this.bodyYaw, crouch, inside ? { sit } : undefined);
    // Eye above the feet, or (seated) above the hips on the bench, in the body's frame.
    const eye = new Vector3(0, STANDING_EYE - 0.7 * Math.max(0, crouch - 0.15), 0);
    if (sit) eye.lerp(new Vector3(0, sit.height + SEATED_EYE, sit.back - 0.05), sit.amount);
    eye.applyAxisAngle(UP, this.bodyYaw);
    this.setNear(inside && this.skier.view === 'first-person' ? CABIN_NEAR : CAMERA.near);
    if (this.skier.view === 'first-person') {
      this.camera.position.copy(this.feet).add(eye);
      this.euler.set(this.look.pitch, this.look.yaw, 0);
      this.camera.quaternion.setFromEuler(this.euler);
    } else {
      // Far enough back to frame the whole cabin you're in.
      const distance = CHASE_DISTANCE * cameraSettings.chaseDistance + (inside ? this.cabin!.d : 0);
      const elevation = 0.25 - this.look.pitch;
      const back = distance * Math.cos(elevation);
      this.camera.position.set(
        this.feet.x + Math.sin(this.look.yaw) * back,
        this.feet.y + 1 + distance * Math.sin(elevation),
        this.feet.z + Math.cos(this.look.yaw) * back,
      );
      this.camera.lookAt(this.feet.x, this.feet.y + 1, this.feet.z);
    }
  }
}
