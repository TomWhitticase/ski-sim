import { cameraSettings } from './camera-settings';
import {
  Color,
  Euler,
  Matrix4,
  type PerspectiveCamera,
  Quaternion,
  SpotLight,
  Vector3,
} from 'three/webgpu';

import { FLY } from '../config';
import type { SnowContact } from '../fx/intensity';
import type { Pose } from '../nav/pose';
import type { Bounds } from './fly-controls';
import { type Input, Look } from './input';
import { EYE_HEIGHT } from './ski-controls';
import { SkierModel } from './ski-model';
import type { SkiTerrain } from './ski-physics';
import { initialStance } from './ski-stance';
import { createSnowmobile, SLED_LAYOUT, type SnowmobileParts } from './snowmobile-model';
import {
  createSledState,
  heading,
  SLED,
  type SledState,
  sledSurface,
  stepSled,
} from './snowmobile-physics';

export interface SledTerrain extends SkiTerrain {
  /** Push a circle of `radius` out of solid things; adjusts velocity. Returns whether it hit. */
  collideSled?(position: Vector3, velocity: Vector3, radius: number): boolean;
}

const CHASE_DISTANCE = 6.5;
const CHASE_HEIGHT = 1.1;
/** Thumb throttle: how fast it opens and closes (1/s). */
const THROTTLE_RATE = 6;
/** Hold S this long at a standstill and the reverse gear engages (s). */
const REVERSE_DELAY = 0.35;
/** Without Shift the rider still leans into turns a little. */
const AUTO_LEAN = 0.35;
/** Collision circles along the sled: offsets ahead of the contact centre (m) and radius. */
const COLLIDERS = [1.1, 0, -1.0];
const COLLIDER_RADIUS = 0.6;
/** Largest step between collision checks, so a fast sled can't skip through a wall (s). */
const COLLIDE_STEP = 1 / 120;
/** Rider steps off this far to the left of the sled (m). */
const STEP_OFF = 1.2;
/** Most momentum you keep jumping off onto your skis (m/s, ~90 km/h). */
const STEP_OFF_SPEED = 25;
/** Within this of the parked sled, B climbs back on it rather than bringing a new one (m). */
const REMOUNT_RANGE = 15;
/** How quickly the drawn sled follows the terrain's tilt (1/s): smooths small bumps. */
const TILT_RATE = 14;
/** Share of the powder sinkage that's drawn: the snow under the track packs down. */
const VISIBLE_SINK = 0.3;
const UP = new Vector3(0, 1, 0);
const ZERO = new Vector3();
/**
 * Headlight beam. A real lamp's reflector throws more light far ahead than down at the
 * snow just in front; a spotlight can't, so instead of inverse-square falloff (which
 * burns out the first few metres and leaves the rest dark) it lights evenly out to
 * `range` and fades there.
 */
const HEADLIGHT = { intensity: 28, range: 90, angle: 0.65, penumbra: 0.7 };
/** Lamp lenses: brighter than white so they bloom through tone mapping; dark when off. */
const HEADLAMP_ON = new Color(3, 3, 2.6);
const HEADLAMP_OFF = new Color(0x26282c);
const TAIL_ON = new Color(0.9, 0.05, 0.03);
const TAIL_BRAKE = new Color(3.5, 0.15, 0.1);
const TAIL_OFF = new Color(0x2a0805);

/**
 * Snowmobile: W throttle, S brake (held at a standstill: reverse), A/D steer, Shift
 * hangs off the side (tighter turns, side-hilling). Mouse looks around freely; the view
 * turns with the sled. Getting off (B) leaves it parked where it is.
 */
export class SnowmobileControls {
  readonly look = new Look(FLY.mouseSensitivity);
  readonly root;
  view: 'first-person' | 'chase' = 'first-person';
  /** Riding it, parked (visible, settling under its own weight), or not out at all. */
  status: 'riding' | 'parked' | 'away' = 'away';

  readonly parts: SnowmobileParts;
  readonly rider = new SkierModel();
  private readonly stance = initialStance();
  private readonly state: SledState = createSledState();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly normal = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly drawn = new Quaternion();
  private readonly target = new Quaternion();
  private readonly tilt = new Quaternion();
  private readonly back = new Vector3();
  private readonly basis = new Matrix4();
  private readonly riderUp = new Vector3();
  private readonly sledUp = new Vector3();
  private readonly probe = new Vector3();
  private readonly before = new Vector3();
  /** Thumb throttle position, 0..1. */
  throttle = 0;
  private reverse = false;
  private stoppedFor = 0;
  private lean = 0;
  /** How far the track has turned (m), for the paddles' scroll. */
  private trackTravel = 0;
  /** Seconds the parked sled has been still (it stops simulating once settled). */
  private still = 0;
  /**
   * The headlight beam. Add it (and its target) to the scene once and leave it there:
   * it's switched by intensity, because changing the scene's lights recompiles every
   * lit material.
   */
  readonly headlight = new SpotLight(
    0xfff4e0,
    0,
    HEADLIGHT.range,
    HEADLIGHT.angle,
    HEADLIGHT.penumbra,
    0,
  );
  /** 0 in daylight, 1 at night: how much the headlight beam is needed. */
  private darkness = 0;
  private braking = false;
  /** What the track is doing to the snow this frame (for trails, spray and sound). */
  readonly contact: SnowContact = { speed: 0, sideslip: 0, edge: 0, onSnow: false, groomed: true };

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly terrain: SledTerrain,
    private readonly bounds: Bounds,
  ) {
    this.parts = createSnowmobile();
    this.root = this.parts.root;
    this.root.visible = false;
    this.parts.seat.add(this.rider.root);
    this.rider.setStowed(true); // skis on the rack, poles away
    const L = SLED_LAYOUT;
    for (const [pose, side] of [
      [this.stance.left, -1],
      [this.stance.right, 1],
    ] as const) {
      pose.x = side * L.footX;
      pose.z = L.footZ;
    }
    this.stance.sit = { amount: 1, height: L.hipHeight, back: L.hipBack };
    this.stance.grip = {
      x: L.grip.x,
      y: L.grip.y - L.boardHeight,
      z: L.grip.z,
    };
  }

  get position(): Vector3 {
    return this.state.position;
  }

  get velocity(): Vector3 {
    return this.state.velocity;
  }

  get heading(): number {
    return this.look.heading;
  }

  get pitchDegrees(): number {
    return this.look.pitchDegrees;
  }

  get speed(): number {
    return this.state.velocity.length();
  }

  /** Which way the sled points (degrees clockwise from north). */
  get sledHeading(): number {
    return ((((-this.state.yaw * 180) / Math.PI) % 360) + 360) % 360;
  }

  /** Steering angle of the skis (rad). */
  get steer(): number {
    return this.state.steer;
  }

  get airborne(): boolean {
    return this.state.airborne;
  }

  get rpm(): number {
    return this.state.rpm;
  }

  /** Track spinning on the snow (0..1). */
  get slip(): number {
    return this.state.slip;
  }

  /** Vertical impact (m/s) if it landed this frame. */
  get impact(): number {
    return this.state.impact;
  }

  get inPowder(): boolean {
    return !this.contact.groomed;
  }

  setActive(active: boolean): void {
    if (active) this.status = 'riding';
    else if (this.status === 'riding') this.status = 'parked';
    this.root.visible = this.status !== 'away';
    this.rider.root.visible = this.status === 'riding';
    this.applyView();
    this.updateLights();
  }

  /**
   * Out of body (fly mode): the sled stays where you left it with you sat on it, drawn
   * whole. Still 'riding', so it isn't parked and doesn't coast; it just isn't updated.
   */
  showFrozen(): void {
    this.root.visible = true;
    this.rider.root.visible = true;
    this.rider.setFirstPerson(false, true);
  }

  /** How dark it is (0 day … 1 night); the headlight comes on as it gets dark. */
  setDarkness(darkness: number): void {
    if (darkness === this.darkness) return;
    this.darkness = darkness;
    this.updateLights();
  }

  /**
   * Lamps glow while the engine runs (the tail light brightens under braking); the beam
   * lights the snow ahead once it's getting dark. Parked, everything's off.
   */
  private updateLights(): void {
    const on = this.status === 'riding';
    this.parts.headlamp.color.copy(on ? HEADLAMP_ON : HEADLAMP_OFF);
    this.parts.tailLamp.color.copy(!on ? TAIL_OFF : this.braking ? TAIL_BRAKE : TAIL_ON);
    this.headlight.intensity = on ? HEADLIGHT.intensity * this.darkness : 0;
    if (this.headlight.intensity > 0) {
      this.parts.beamFrom.getWorldPosition(this.headlight.position);
      this.parts.beamTo.getWorldPosition(this.headlight.target.position);
      this.headlight.target.updateMatrixWorld();
    }
  }

  setView(view: 'first-person' | 'chase'): void {
    this.view = view;
    this.applyView();
  }

  private applyView(): void {
    // Seated in first person you see your knees and the bars, not your own head.
    this.rider.setFirstPerson(this.view === 'first-person', true);
  }

  /** Teleport: sit on the sled at the pose (eye altitude), at rest. */
  place(pose: Pose): void {
    const feet = new Vector3(pose.east, pose.altitude - EYE_HEIGHT, -pose.north);
    this.mount(feet, ZERO, (-pose.heading * Math.PI) / 180, (pose.pitch * Math.PI) / 180);
  }

  /** Within reach of the parked sled? */
  canRemount(at: Vector3): boolean {
    if (this.status !== 'parked') return false;
    const p = this.state.position;
    return Math.hypot(at.x - p.x, at.z - p.z) < REMOUNT_RANGE && Math.abs(at.y - p.y) < 5;
  }

  /** Climb back onto the parked sled where it is. */
  remount(lookPitch: number): void {
    this.look.yaw = this.state.yaw;
    this.look.pitch = lookPitch;
    this.throttle = 0;
    this.reverse = false;
    this.setActive(true);
    this.updateView(0);
  }

  /**
   * Bring the sled to `feet` carrying `velocity` (pointing along it if moving, else the
   * way you look). Above the snow it falls and lands.
   */
  mount(feet: Vector3, velocity: Vector3, lookYaw: number, lookPitch: number): void {
    const s = this.state;
    const horizontal = Math.hypot(velocity.x, velocity.z);
    s.yaw = horizontal > 1 ? Math.atan2(-velocity.x, -velocity.z) : lookYaw;
    s.position.copy(feet);
    s.velocity.copy(velocity);
    const ground = sledSurface(this.terrain, feet.x, feet.z, s.yaw, this.normal);
    s.position.y = Math.max(feet.y, ground);
    s.airborne = s.position.y > ground + SLED.airThreshold;
    if (!s.airborne) {
      s.position.y = ground;
      s.velocity.addScaledVector(this.normal, -s.velocity.dot(this.normal));
    }
    s.steer = 0;
    s.pitch = s.airborne ? Math.atan2(velocity.y, Math.max(horizontal, 1)) : 0;
    s.pitchRate = 0;
    s.suspension = 0;
    s.suspensionRate = 0;
    s.sink = 0;
    s.rpm = SLED.idleRpm;
    this.throttle = 0;
    this.reverse = false;
    this.look.yaw = lookYaw;
    this.look.pitch = lookPitch;
    this.drawn.copy(this.orientation(this.target));
    this.setActive(true);
    this.updateView(0);
  }

  /**
   * Step off to the left onto your skis, keeping (most of) the sled's momentum. The sled
   * stays where it is, parked, and coasts to a stop if it was moving.
   */
  dismount(): { feet: Vector3; velocity: Vector3 } {
    const s = this.state;
    heading(s.yaw, this.fwd);
    const feet = s.position
      .clone()
      .add(new Vector3(this.fwd.z, 0, -this.fwd.x).multiplyScalar(STEP_OFF));
    feet.y = Math.max(s.position.y, this.terrain.height(feet.x, feet.z));
    const velocity = s.velocity.clone().clampLength(0, STEP_OFF_SPEED);
    this.throttle = 0;
    this.setActive(false);
    return { feet, velocity };
  }

  /** The parked sled settles under its own weight (parking brake on) until it's still. */
  idle(dt: number): void {
    if (this.status !== 'parked') return;
    if (this.still > 1) return;
    this.simulate(dt, { throttle: 0, brake: true, steer: 0 });
    const moving = this.state.velocity.length() > 0.05 || this.state.airborne;
    this.still = moving ? 0 : this.still + dt;
    this.updateModel(dt);
  }

  update(dt: number, input: Input): void {
    this.still = 0;
    const yawBefore = this.state.yaw;
    this.look.apply(input);
    const steer = input.turn;
    const want = input.throttle;
    this.throttle += (want - this.throttle) * Math.min(1, THROTTLE_RATE * dt);
    if (this.throttle < 0.01) this.throttle = 0;

    // S brakes; held at a standstill it drops into reverse until you let go.
    heading(this.state.yaw, this.fwd);
    const forward = this.state.velocity.dot(this.fwd);
    const brakeHeld = input.down('KeyS') && !input.down('KeyW');
    if (!brakeHeld) {
      this.reverse = false;
      this.stoppedFor = 0;
    } else if (!this.reverse) {
      this.stoppedFor = Math.abs(forward) < 0.5 ? this.stoppedFor + dt : 0;
      if (this.stoppedFor > REVERSE_DELAY) this.reverse = true;
    }
    // Shift: hang off the side into the turn (or uphill on a traverse).
    const hangOff = input.down('ShiftLeft', 'ShiftRight');
    const wantLean = steer * (hangOff ? 1 : AUTO_LEAN);
    this.lean += (wantLean - this.lean) * Math.min(1, 5 * dt);

    this.braking = brakeHeld && !this.reverse;
    this.simulate(dt, {
      throttle: this.throttle,
      brake: this.braking,
      reverse: this.reverse,
      steer,
      lean: this.lean,
    });

    // The view turns with the sled, so steering feels natural; mouse look is on top.
    this.look.yaw += this.state.yaw - yawBefore;
    this.updateView(dt);
  }

  /** Physics in short steps, with collisions between them. */
  private simulate(dt: number, input: Parameters<typeof stepSled>[1]): void {
    const s = this.state;
    let remaining = dt;
    while (remaining > 1e-6) {
      const h = Math.min(remaining, COLLIDE_STEP);
      stepSled(s, input, h, this.terrain);
      this.collide();
      remaining -= h;
    }
    const p = s.position;
    p.x = Math.min(Math.max(p.x, this.bounds.minX), this.bounds.maxX);
    p.z = Math.min(Math.max(p.z, this.bounds.minZ), this.bounds.maxZ);

    heading(s.yaw, this.fwd);
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    const v = s.velocity;
    this.trackTravel += v.dot(this.fwd) * dt;
    Object.assign(this.contact, {
      speed: v.length(),
      sideslip: v.dot(this.right),
      edge: 0,
      onSnow: !s.airborne,
      groomed: this.terrain.groomed?.(p.x, p.z) ?? true,
    });
  }

  /** Buildings, terminals and towers: push circles along the sled's length out of them. */
  private collide(): void {
    const collide = this.terrain.collideSled;
    if (!collide) return;
    const s = this.state;
    heading(s.yaw, this.fwd);
    for (const offset of COLLIDERS) {
      this.probe.copy(s.position).addScaledVector(this.fwd, offset);
      this.before.copy(this.probe);
      if (collide(this.probe, s.velocity, COLLIDER_RADIUS)) {
        s.position.x += this.probe.x - this.before.x;
        s.position.z += this.probe.z - this.before.z;
      }
    }
  }

  /**
   * Where the sled marks the snow, each on the snow surface: the back of the track (its
   * trench, and where roost flies from) and the two front skis.
   */
  snowMarks(track: Vector3, leftSki: Vector3, rightSki: Vector3): void {
    const L = SLED_LAYOUT;
    const p = this.state.position;
    heading(this.state.yaw, this.fwd);
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    const onSnow = (out: Vector3, ahead: number, side: number) => {
      out.copy(p).addScaledVector(this.fwd, ahead).addScaledVector(this.right, side);
      out.y = this.terrain.height(out.x, out.z);
    };
    onSnow(track, -L.trackRear + 0.15, 0);
    onSnow(leftSki, -L.skiZ, -L.skiX);
    onSnow(rightSki, -L.skiZ, L.skiX);
  }

  /** The sled's forward direction (horizontal). */
  forward(out: Vector3): Vector3 {
    return heading(this.state.yaw, out);
  }

  /** Orientation the sled would be drawn at right now (before smoothing). */
  private orientation(out: Quaternion): Quaternion {
    const s = this.state;
    const p = s.position;
    if (s.airborne) {
      // In the air: heading and nose pitch, wings level.
      this.euler.set(s.pitch, s.yaw, 0, 'YXZ');
      return out.setFromEuler(this.euler);
    }
    sledSurface(this.terrain, p.x, p.z, s.yaw, this.normal);
    heading(s.yaw, this.fwd);
    this.fwd.addScaledVector(this.normal, -this.fwd.dot(this.normal)).normalize();
    this.right.crossVectors(this.fwd, this.normal);
    // Basis: x = right, y = up, z = back.
    this.back.copy(this.fwd).negate();
    this.basis.makeBasis(this.right, this.normal, this.back);
    return out.setFromRotationMatrix(this.basis);
  }

  /** Sled, bars, skis, paddles and rider. */
  private updateModel(dt: number): void {
    const s = this.state;
    this.orientation(this.target);
    if (dt > 0) this.drawn.slerp(this.target, 1 - Math.exp(-TILT_RATE * dt));
    else this.drawn.copy(this.target);
    const root = this.parts.root;
    // Settled into powder (the snow packs down under it, so not the whole sinkage).
    root.position.copy(s.position);
    root.position.y -= s.airborne ? 0 : VISIBLE_SINK * s.sink;
    root.quaternion.copy(this.drawn);
    // Sprung mass rides the suspension; the rider leans the sled a touch with them.
    this.parts.body.position.y = -0.6 * s.suspension;
    this.parts.body.rotation.z = 0.08 * this.lean;
    this.parts.bars.rotation.y = s.steer * 0.8;
    for (const ski of this.parts.skis) ski.rotation.y = s.steer;
    const phase =
      ((this.trackTravel % SLED_LAYOUT.lugSpacing) + SLED_LAYOUT.lugSpacing) %
      SLED_LAYOUT.lugSpacing;
    // The bottom run is still on the snow, so it moves back past the sled; the top forward.
    this.parts.lugs[0].position.z = phase;
    this.parts.lugs[1].position.z = -phase;

    // Rider: leaning into turns and forward over the bars.
    this.riderUp.set(-Math.sin(0.35 * this.lean), 1, -0.22).normalize();
    this.rider.apply(this.stance, this.riderUp);
    root.updateMatrixWorld(true);
    this.updateLights(); // the beam follows the nose
  }

  private updateView(dt: number): void {
    this.updateModel(dt);
    const root = this.parts.root;
    if (this.view === 'first-person') {
      this.camera.position.copy(SLED_LAYOUT.eye).applyMatrix4(this.parts.body.matrixWorld);
      // The view pitches and rolls with the sled; mouse look on top.
      this.tilt.setFromUnitVectors(UP, this.sledUp.copy(UP).applyQuaternion(this.drawn));
      this.euler.set(this.look.pitch, this.look.yaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this.euler).premultiply(this.tilt);
    } else {
      const p = root.position;
      const chase = CHASE_DISTANCE * cameraSettings.chaseDistance;
      const elevation = 0.18 - this.look.pitch;
      const back = chase * Math.cos(elevation);
      const cam = this.camera.position;
      cam.set(
        p.x + Math.sin(this.look.yaw) * back,
        p.y + CHASE_HEIGHT + chase * Math.sin(elevation),
        p.z + Math.cos(this.look.yaw) * back,
      );
      cam.y = Math.max(cam.y, this.terrain.height(cam.x, cam.z) + 1);
      this.camera.lookAt(p.x, p.y + 1, p.z);
    }
  }
}
