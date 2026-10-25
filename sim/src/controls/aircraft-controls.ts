import { Euler, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

import { FLY } from '../config';
import type { Pose } from '../nav/pose';
import { animateAircraft, type AircraftParts, createAircraft } from './aircraft-model';
import type { AircraftType, HeliType, PlaneType } from './aircraft-types';
import { cameraSettings } from './camera-settings';
import type { Bounds } from './fly-controls';
import {
  createHeliState,
  type HeliInput,
  heliOrientation,
  type HeliState,
  skidGround,
  stepHeli,
} from './heli-physics';
import { type Input, Look } from './input';
import {
  type AirConditions,
  type AirTerrain,
  CRASH_TIME,
  createPlaneState,
  groundOrientation,
  type PlaneInput,
  type PlaneState,
  planeYaw,
  STILL_AIR,
  stepPlane,
} from './plane-physics';
import { EYE_HEIGHT } from './ski-controls';
import { SkierModel } from './ski-model';
import { initialStance } from './ski-stance';

export interface AircraftTerrain extends AirTerrain {
  /** Does a sphere of `radius` at this world point hit a building, tower or lift cable? */
  hits?(point: Vector3, radius: number): string | null;
  /** Clear ground to park or put an aircraft down on (no buildings nearby)? */
  clear?(x: number, z: number, radius: number): boolean;
}

/** Where a parked aircraft stands: ground reference (east, ground, north) and heading (deg). */
export interface ParkedAt {
  east: number;
  north: number;
  ground: number;
  heading: number;
}

/** Mouse travel (px) for full stick, and how fast the stick centres once the mouse stops (1/s). */
const STICK_PX = 260;
const STICK_RETURN = 2.2;
/** The power lever moves this fast with W / S (per s); hold S at idle on the ground this long for reverse. */
const LEVER_RATE = 0.6;
const REVERSE_DELAY = 0.3;
/** Chase camera: distance behind and height above (m), and how fast it swings round (1/s). */
const CHASE = { plane: { distance: 21, height: 4.5 }, heli: { distance: 17, height: 4 } };
const CHASE_RATE = 2.5;
/** Within this of a parked aircraft (m), E or its key climbs in. */
export const BOARD_RANGE = 14;
/** Stopped enough to get out (m/s). */
const STOPPED = 0.8;
/** Body points checked against buildings, towers and cables (m, from the ground reference). */
const PLANE_PROBES: [number, number, number][] = [
  [0, 1.7, -3.4],
  [0, 1.9, 0],
  [0, 2.2, 7.3],
  [-7.6, 3.0, 0.1],
  [7.6, 3.0, 0.1],
  [-3.8, 2.9, 0.1],
  [3.8, 2.9, 0.1],
];
const PROBE_RADIUS = 0.7;

const UP = new Vector3(0, 1, 0);
const TMP = new Vector3();
const TMP2 = new Vector3();
const QT = new Quaternion();
const EULER = new Euler(0, 0, 0, 'YXZ');

/**
 * Flying the plane or helicopter (one controller per type): the pure physics
 * (`plane-physics.ts`, `heli-physics.ts`), the model with its pilot (a seated `SkierModel`,
 * skis stowed), the chase and cockpit cameras, collisions, crashes and their reset.
 *
 * Plane: W / S power (S at idle on the ground: reverse), mouse (or the arrow keys) is the
 * stick (pitch and roll, centring when you let go), A / D roll (and steer on the ground),
 * Q / E rudder, X flaps, Space brakes. Helicopter: W / S collective (climb / descend;
 * neither holds the height), mouse or the arrows the cyclic, A / D sideways, Q / E pedals.
 * Getting out (only stopped on the ground) leaves it parked where it is.
 */
export class AircraftControls {
  readonly look = new Look(FLY.mouseSensitivity);
  readonly parts: AircraftParts;
  readonly root;
  readonly pilot = new SkierModel();
  view: 'first-person' | 'chase' = 'chase';
  status: 'riding' | 'parked' | 'away' = 'away';
  /** Flap setting (0 up, 1 take-off, 2 landing). */
  flapSetting = 1;
  /** Power lever 0..1 (plane: below 0 is reverse). */
  lever = 0;
  /** Why it last crashed (cleared when you're reset), for a notice. */
  crashed: string | null = null;
  /** Set when a crash has just finished and you've been put back on the ground. */
  reset = false;
  private readonly plane: PlaneState | null;
  private readonly heli: HeliState | null;
  private readonly stance = initialStance();
  private stickX = 0;
  private stickY = 0;
  /** A stick position held by something other than the mouse (an autopilot in the tests). */
  private heldStick: { x: number; y: number } | null = null;
  private reverseFor = 0;
  private time = 0;
  /** Camera swing behind the aircraft (yaw, rad) and a touch orbit on top. */
  private chaseYaw = 0;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private readonly prev = new Vector3();
  air: AirConditions = STILL_AIR;
  /** Brakes held this frame (plane), for the HUD. */
  braking = false;

  constructor(
    readonly type: AircraftType,
    private readonly camera: PerspectiveCamera,
    private readonly terrain: AircraftTerrain,
    private readonly bounds: Bounds,
  ) {
    this.parts = createAircraft(type);
    this.root = this.parts.root;
    this.root.visible = false;
    this.plane = type.kind === 'plane' ? createPlaneState(type) : null;
    this.heli = type.kind === 'heli' ? createHeliState(type) : null;
    this.parts.seat.add(this.pilot.root);
    this.pilot.setStowed(true);
    const p = this.parts.pilot;
    for (const [pose, side] of [
      [this.stance.left, -1],
      [this.stance.right, 1],
    ] as const) {
      pose.x = side * 0.16;
      pose.z = p.feet - 0.05;
    }
    this.stance.sit = { amount: 1, height: p.hipHeight, back: p.hipBack };
    this.stance.grip = { x: p.grip.x, y: p.grip.y, z: p.grip.z };
  }

  get kind(): 'plane' | 'heli' {
    return this.type.kind;
  }

  /** The ground reference (main gear or skids): what the pose and the maps track. */
  get position(): Vector3 {
    return (this.plane ?? this.heli)!.position;
  }

  get velocity(): Vector3 {
    return (this.plane ?? this.heli)!.velocity;
  }

  get speed(): number {
    return this.velocity.length();
  }

  get airspeed(): number {
    return (this.plane ?? this.heli)!.airspeed;
  }

  get onGround(): boolean {
    return (this.plane ?? this.heli)!.onGround;
  }

  get crashing(): boolean {
    return (this.plane ?? this.heli)!.crash > 0;
  }

  /** Touchdown sink rate (m/s) this frame. */
  get impact(): number {
    return (this.plane ?? this.heli)!.impact;
  }

  get stallWarning(): boolean {
    return this.plane?.stallWarning ?? false;
  }

  get stalled(): boolean {
    return this.plane?.stall ?? false;
  }

  /** Prop or rotor revs, 0..1. */
  get rpm(): number {
    return this.plane ? this.plane.rpm : this.heli!.rotor;
  }

  /** Engine load, 0..1 (lever for the plane, power for the heli). */
  get load(): number {
    return this.plane ? Math.abs(this.lever) : Math.min(1, this.heli!.power);
  }

  get flaps(): number {
    return this.plane?.flaps ?? 0;
  }

  /** Which way the nose points (Look convention). */
  get yaw(): number {
    return this.plane ? planeYaw(this.plane) : this.heli!.yaw;
  }

  /** Nose heading (degrees clockwise from north). */
  get heading(): number {
    return ((((-this.yaw * 180) / Math.PI) % 360) + 360) % 360;
  }

  get pitchDegrees(): number {
    return 0;
  }

  /** Stopped on the ground: you can climb out. */
  get canExit(): boolean {
    return this.onGround && !this.crashing && this.speed < STOPPED;
  }

  /**
   * Hold the stick (plane) or cyclic (heli) at x right, y back (-1..1), as a joystick
   * would; null hands it back to the mouse.
   */
  setStick(stick: { x: number; y: number } | null): void {
    this.heldStick = stick;
  }

  setView(view: 'first-person' | 'chase'): void {
    this.view = view;
    this.pilot.setFirstPerson(view === 'first-person' && this.status === 'riding', true);
  }

  setActive(active: boolean): void {
    if (active) {
      this.status = 'riding';
      this.pilot.setFlyingDrone(false);
    } else if (this.status === 'riding') this.status = 'parked';
    this.root.visible = this.status !== 'away';
    this.pilot.root.visible = this.status === 'riding';
    this.setView(this.view);
  }

  /** Put away (another one came instead). */
  stow(): void {
    this.status = 'away';
    this.root.visible = false;
  }

  /** Out of body (flying the drone): left as it is with you in it, holding the controller. */
  showFrozen(): void {
    this.root.visible = true;
    this.pilot.root.visible = true;
    this.pilot.setFirstPerson(false, true);
    this.pilot.setFlyingDrone(true);
  }

  /** Teleport or restore: on the ground there (at rest), or flying if it's well above it. */
  place(pose: Pose): void {
    const at = new Vector3(pose.east, pose.altitude - EYE_HEIGHT, -pose.north);
    const yaw = (-pose.heading * Math.PI) / 180;
    const ground = this.terrain.height(at.x, at.z);
    if (at.y > ground + 5) {
      const v = this.type.kind === 'plane' ? 50 : 0;
      this.mount(at, new Vector3(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v), yaw, true);
    } else {
      this.mount(at.setY(ground), new Vector3(), yaw, true);
    }
  }

  /** Within reach of this aircraft, parked? */
  canBoard(at: Vector3): boolean {
    if (this.status !== 'parked') return false;
    const p = this.position;
    return Math.hypot(at.x - p.x, at.z - p.z) < BOARD_RANGE && Math.abs(at.y - p.y) < 6;
  }

  /** Climb into it where it's parked. */
  board(): void {
    this.lever = 0;
    this.setActive(true);
    this.updateView(0);
  }

  /** Into a parked one at an airfield (engine cold). */
  boardAt(spot: ParkedAt): void {
    const yaw = (-spot.heading * Math.PI) / 180;
    this.mount(new Vector3(spot.east, spot.ground, -spot.north), new Vector3(), yaw, false);
  }

  /**
   * Bring it to `at` (ground reference) heading `yaw`, moving at `velocity`: on the ground
   * at rest, or in the air flying (engine running). `running` starts the engine hot.
   */
  mount(at: Vector3, velocity: Vector3, yaw: number, running: boolean): void {
    const ground = this.terrain.height(at.x, at.z);
    const airborne = at.y > ground + 2;
    this.lever = airborne ? (this.plane ? 0.75 : 0) : 0;
    this.flapSetting = this.plane && !airborne ? 1 : 0;
    this.stickX = 0;
    this.stickY = 0;
    this.crashed = null;
    if (this.plane) {
      const s = this.plane;
      s.position.copy(at);
      s.velocity.copy(velocity);
      s.rates.set(0, 0, 0);
      s.crash = 0;
      s.crashed = null;
      s.onGround = !airborne;
      s.flaps = this.flapSetting;
      s.rpm = running || airborne ? 0.8 : 0;
      const t = this.type as PlaneType;
      if (s.onGround) {
        s.position.y = ground;
        s.velocity.set(0, 0, 0);
        s.groundPitch = t.ground.threePoint;
        groundOrientation(yaw, this.normal(at.x, at.z, TMP), s.groundPitch, s.orientation);
      } else {
        s.orientation.setFromEuler(EULER.set(0.05, yaw, 0, 'YXZ'));
      }
    } else {
      const s = this.heli!;
      s.position.copy(at);
      s.velocity.copy(velocity);
      s.yaw = yaw;
      s.yawRate = 0;
      s.pitch = 0;
      s.bank = 0;
      s.crash = 0;
      s.crashed = null;
      s.onGround = !airborne;
      s.rotor = running || airborne ? 1 : 0;
      s.thrust = airborne ? s.mass * 9.81 : 0;
      if (s.onGround) {
        s.position.y = skidGround(this.type as HeliType, this.terrain, at.x, at.z, yaw, TMP);
        s.velocity.set(0, 0, 0);
      }
    }
    this.chaseYaw = yaw;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.setActive(true);
    this.updateView(0);
  }

  /** Climb out beside it (pilot's side), onto your skis. It stays parked there. */
  dismount(): { feet: Vector3; velocity: Vector3 } {
    const side = this.parts.seat.position.x < 0 ? -1 : 1;
    const out = (this.type.kind === 'plane' ? 1.8 : 2.0) * side;
    const feet = TMP.set(out, 0, -0.6).applyAxisAngle(UP, this.yaw).add(this.position).clone();
    feet.y = this.terrain.height(feet.x, feet.z);
    this.lever = 0;
    this.setActive(false);
    return { feet, velocity: new Vector3() };
  }

  /** Parked: the prop or rotor runs down. */
  idle(dt: number): void {
    if (this.status !== 'parked') return;
    if (this.plane) this.plane.rpm = Math.max(0, this.plane.rpm - 0.25 * dt);
    else this.heli!.rotor = Math.max(0, this.heli!.rotor - 0.12 * dt);
    this.time += dt;
    animateAircraft(this.parts, this.type, this.rpm, this.time, dt, false);
  }

  update(dt: number, input: Input): void {
    this.time += dt;
    this.reset = false;
    const k = (cameraSettings.sensitivity * 1) / STICK_PX;
    // The mouse is the stick on a desktop; on a touchscreen a drag looks round instead.
    if (!input.touch) {
      this.stickX = clamp1(this.stickX + input.mouseX * k);
      this.stickY = clamp1(this.stickY + input.mouseY * k * (cameraSettings.invertY ? -1 : 1));
      const centre = Math.exp(-STICK_RETURN * dt);
      if (input.mouseX === 0) this.stickX *= centre;
      if (input.mouseY === 0) this.stickY *= centre;
    } else {
      // Heli: a sideways drag is the pedals (below); otherwise it swings the view.
      if (this.plane) this.orbitYaw -= input.mouseX * 0.004;
      this.orbitPitch = Math.max(-1, Math.min(0.6, this.orbitPitch - input.mouseY * 0.004));
    }
    if (input.mouseX === 0 && input.mouseY === 0) {
      // The view drifts back behind the nose once you let go.
      this.orbitYaw *= Math.exp(-1.5 * dt);
      this.orbitPitch *= Math.exp(-1.5 * dt);
    }
    if (this.heldStick) {
      this.stickX = this.heldStick.x;
      this.stickY = this.heldStick.y;
    }
    const arrowsX = (input.down('ArrowRight') ? 1 : 0) - (input.down('ArrowLeft') ? 1 : 0);
    const arrowsY = (input.down('ArrowDown') ? 1 : 0) - (input.down('ArrowUp') ? 1 : 0);
    const side = clamp1(this.stickX + arrowsX - input.turn);
    const back = clamp1(this.stickY + arrowsY - input.stickY);
    const pedal = (input.down('KeyE') ? 1 : 0) - (input.down('KeyQ') ? 1 : 0);
    this.prev.copy(this.position);
    const state = (this.plane ?? this.heli)!;
    const wasCrashing = state.crash > 0;

    if (this.plane) {
      const up = input.down('KeyW');
      const down = input.down('KeyS');
      if (up) this.lever = Math.min(1, Math.max(0, this.lever) + LEVER_RATE * dt);
      if (down) {
        // At idle on the ground, holding S goes on into reverse.
        if (this.lever > 0) this.lever = Math.max(0, this.lever - LEVER_RATE * dt);
        else if (this.plane.onGround) {
          this.reverseFor += dt;
          if (this.reverseFor > REVERSE_DELAY) this.lever = Math.max(-1, this.lever - 2 * dt);
        }
      } else {
        this.reverseFor = 0;
        if (this.lever < 0) this.lever = Math.min(0, this.lever + 2 * dt);
      }
      if (input.wasPressed('KeyX')) this.flapSetting = (this.flapSetting + 1) % 3;
      this.braking = input.down('Space');
      const plane: PlaneInput = {
        pitch: back,
        roll: side,
        yaw: pedal,
        throttle: this.lever,
        brake: this.braking,
        flaps: this.flapSetting,
      };
      stepPlane(this.plane, plane, dt, this.type as PlaneType, this.terrain, this.air);
    } else {
      const collective = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
      this.lever = collective;
      const heli: HeliInput = {
        collective,
        cyclicX: side,
        cyclicY: -back,
        pedal: input.touch ? clamp1(pedal + input.mouseX * 0.02) : pedal,
      };
      stepHeli(this.heli!, heli, dt, this.type as HeliType, this.terrain, this.air);
    }
    if (wasCrashing && state.crash === 0) this.recover();
    else if (state.crash === 0) this.collide();
    const p = state.position;
    p.x = Math.min(Math.max(p.x, this.bounds.minX), this.bounds.maxX);
    p.z = Math.min(Math.max(p.z, this.bounds.minZ), this.bounds.maxZ);
    if (state.crash > 0 && !this.crashed) this.crashed = state.crashed;
    this.look.yaw = this.yaw;
    this.updateView(dt);
  }

  /** Buildings, towers and lift cables: a bump taxiing, a crash at speed. */
  private collide(): void {
    const hits = this.terrain.hits;
    if (!hits) return;
    const state = (this.plane ?? this.heli)!;
    const probes = this.plane ? PLANE_PROBES : this.heliProbes();
    for (const [x, y, z] of probes) {
      this.toWorld(x, y, z, TMP2);
      const what = hits(TMP2, PROBE_RADIUS);
      if (!what) continue;
      if (this.speed > 4) {
        state.crash = CRASH_TIME;
        state.crashed = what;
      } else {
        // Nudged into a wall at a crawl: stop short of it.
        state.position.copy(this.prev);
        state.velocity.set(0, 0, 0);
      }
      return;
    }
  }

  private heliProbes(): [number, number, number][] {
    const t = this.type as HeliType;
    const R = t.rotorRadius;
    const out: [number, number, number][] = [
      [0, 1.4, -2.6],
      [0, 1.3, 0],
      [0, 2.1, t.length - R - t.tailRadius],
    ];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      out.push([Math.cos(a) * R * 0.95, t.ground.hub, Math.sin(a) * R * 0.95]);
    }
    return out;
  }

  private toWorld(x: number, y: number, z: number, out: Vector3): Vector3 {
    out.set(x, y, z).applyQuaternion(this.orientation(QT)).add(this.position);
    return out;
  }

  private orientation(out: Quaternion): Quaternion {
    return this.plane ? out.copy(this.plane.orientation) : heliOrientation(this.heli!, out);
  }

  /** After a crash: back upright on open ground nearby, at rest, engine running. */
  private recover(): void {
    const p = this.position;
    const spot = this.flatSpot(p.x, p.z);
    // The plane faces along the slope's contour so it doesn't roll away.
    const n = this.normal(spot.x, spot.z, TMP2);
    const contour = Math.hypot(n.x, n.z) > 0.02 ? Math.atan2(-n.z, n.x) : this.yaw;
    const yaw = this.plane ? contour : this.yaw;
    this.mount(
      new Vector3(spot.x, this.terrain.height(spot.x, spot.z), spot.z),
      new Vector3(),
      yaw,
      true,
    );
    this.reset = true;
  }

  /** Nearest ground flat and clear enough to stand on, searching outward. */
  private flatSpot(x: number, z: number): { x: number; z: number } {
    const limit = this.plane ? 0.12 : 0.15;
    const reach = this.plane ? 9 : 6;
    for (let r = 0; r <= 300; r += 12) {
      const steps = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 12);
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const cx = x + Math.cos(a) * r;
        const cz = z + Math.sin(a) * r;
        const n = this.normal(cx, cz, TMP2, reach);
        if (Math.hypot(n.x, n.z) > limit) continue;
        if (this.terrain.clear && !this.terrain.clear(cx, cz, reach + 4)) continue;
        return { x: cx, z: cz };
      }
    }
    return { x, z };
  }

  private normal(x: number, z: number, out: Vector3, d = 3): Vector3 {
    const h = this.terrain.height.bind(this.terrain);
    return out.set(h(x - d, z) - h(x + d, z), 2 * d, h(x, z - d) - h(x, z + d)).normalize();
  }

  /** Model, pilot and camera for this frame. */
  private updateView(dt: number): void {
    const root = this.parts.root;
    root.position.copy(this.position);
    this.orientation(root.quaternion);
    animateAircraft(this.parts, this.type, this.rpm, this.time, dt, true);
    this.pilot.apply(this.stance, UP);
    root.updateMatrixWorld(true);
    if (this.status !== 'riding') return;
    if (this.view === 'first-person') {
      this.camera.position.copy(this.parts.eye).applyMatrix4(root.matrixWorld);
      // Looking out along the nose, a little down over the panel.
      EULER.set(-0.03 + this.orbitPitch, this.orbitYaw, 0, 'YXZ');
      this.camera.quaternion.copy(root.quaternion).multiply(QT.setFromEuler(EULER));
    } else {
      const chase = this.type.kind === 'plane' ? CHASE.plane : CHASE.heli;
      // Swing round behind the nose (or behind the way it's going, fast).
      const v = this.velocity;
      const target = Math.hypot(v.x, v.z) > 15 ? Math.atan2(-v.x, -v.z) : this.yaw;
      let d = target - this.chaseYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.chaseYaw += dt > 0 ? d * Math.min(1, CHASE_RATE * dt) : d;
      const yaw = this.chaseYaw + this.orbitYaw;
      const distance = chase.distance * cameraSettings.chaseDistance;
      const elevation = Math.atan2(chase.height, chase.distance) - this.orbitPitch;
      const cam = this.camera.position;
      const p = root.position;
      cam.set(
        p.x + Math.sin(yaw) * Math.cos(elevation) * distance,
        p.y + 2 + Math.sin(elevation) * distance,
        p.z + Math.cos(yaw) * Math.cos(elevation) * distance,
      );
      cam.y = Math.max(cam.y, this.terrain.height(cam.x, cam.z) + 1.5);
      this.camera.lookAt(p.x, p.y + 2, p.z);
    }
  }
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
