import { Euler, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

import { FLY } from '../config';
import type { Pose } from '../nav/pose';
import type { Bounds } from './fly-controls';
import { type Input, Look } from './input';
import { SkierModel } from './ski-model';
import { SKI, type SkiState, type SkiTerrain, stepSki, surfaceNormal } from './ski-physics';
import { DEFAULT_HANDLING, type SkiSetup, skiHandling } from './ski-setup';
import { initialStance, updateStance } from './ski-stance';
import type { SnowContact } from '../fx/intensity';

export const EYE_HEIGHT = 1.7;
/** How far the eye drops in a full tuck (m). */
const CROUCH_DROP = 0.6;
/** Below this W skates (or walks); above it W double-poles instead (m/s, ~16 km/h). */
const SKATE_MAX = 4.5;
/** Slower than this, skating strides are really steps, so they sound like steps (m/s). */
const WALK_MAX = 2.5;
const TURN_RATE = 1.8; // rad/s with A/D
/** How fast A/D swing the skis while S holds the upper body (rad/s). */
const PIVOT_RATE = 3.5;
/** How quickly the skis swing back under you when S is released (1/s). */
const REALIGN_RATE = 6;
/** Most the skis can be twisted away from where you face (rad). */
const MAX_TWIST = (110 * Math.PI) / 180;
const CHASE_DISTANCE = 4.5;
const UP = new Vector3(0, 1, 0);
/** Largest acceleration the body leans against (m/s²); filters landing spikes. */
const MAX_BALANCE_ACCEL = 1.3 * SKI.gravity;
/** How quickly the body's balance follows changes in acceleration (1/s). */
const BALANCE_RATE = 6;
const ZERO = new Vector3();
const FLYING_STANCE = initialStance();
const RIDING_STANCE = initialStance();
/** In fly mode your character is shown see-through. */
const FLYING_OPACITY = 0.45;

export type SkiCamera = 'first-person' | 'chase';

/**
 * Ski mode: mouse looks and steers (skis point where you look), A/D also turn,
 * W skates, Ctrl tucks, Shift snowploughs, Space jumps, V swaps camera.
 * Holding S locks the upper body to where you face and lets A/D swing just the skis,
 * e.g. sideways across your path for a hockey stop.
 */
export class SkiControls {
  readonly look = new Look(FLY.mouseSensitivity);
  private readonly model = new SkierModel();
  readonly skier = this.model.root;
  private readonly stance = initialStance();
  view: SkiCamera = 'first-person';
  /** How the current skis handle (see `setSetup`). */
  private handling = DEFAULT_HANDLING;

  private readonly state: SkiState = {
    position: new Vector3(),
    velocity: new Vector3(),
    yaw: 0,
    airborne: false,
  };
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly normal = new Vector3();
  private readonly q = new Quaternion();
  private readonly qYaw = new Quaternion();
  /** Smoothed rate the direction of travel is turning (rad/s, > 0 = left). */
  private turnRate = 0;
  private travelYaw = 0;
  /** Direction the skis point (Look.yaw convention); can differ from the view while S is held. */
  private skiYaw = 0;
  private readonly prevVelocity = new Vector3();
  /** Smoothed acceleration of the skier (m/s², world). */
  private readonly accel = new Vector3();
  /** Direction the body balances along, in the skier's slope-aligned frame. */
  private readonly bodyUp = new Vector3(0, 1, 0);
  private readonly inverse = new Quaternion();
  /** What the skis are doing to the snow this frame (for spray, trails and sound). */
  readonly contact: SnowContact = { speed: 0, sideslip: 0, edge: 0, onSnow: false, groomed: true };
  /** Impact speed (m/s) if you landed this frame, else 0. */
  landingImpact = 0;
  /** A foot stepped this frame (walking, climbing or slow skating). */
  footstep = false;
  /** Poles planted this frame. */
  polePlant = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly terrain: SkiTerrain,
    private readonly bounds: Bounds,
  ) {
    this.skier.visible = false;
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

  get velocity(): Vector3 {
    return this.state.velocity;
  }

  /** Where the skis are (the camera may be behind, in chase view). */
  get feet(): Vector3 {
    return this.state.position;
  }

  /** Walking uphill (W on a slope too steep to skate). */
  get climbing(): boolean {
    return this.state.climbing ?? false;
  }

  get airborne(): boolean {
    return this.state.airborne;
  }

  /**
   * Put the skier at a pose whose altitude is eye height. If that's above the snow you
   * start in the air and fall (keeping `velocity`, e.g. momentum carried over from flying);
   * below it, you're placed on the surface.
   */
  place(pose: Pose, velocity?: Vector3): void {
    const p = this.state.position;
    p.set(pose.east, 0, -pose.north);
    const ground = this.terrain.height(p.x, p.z);
    p.y = Math.max(ground, pose.altitude - EYE_HEIGHT);
    this.state.airborne = p.y > ground + SKI.airThreshold;
    this.state.velocity.copy(velocity ?? ZERO);
    if (!this.state.airborne) {
      // On the snow: keep only the motion along the slope.
      surfaceNormal(this.terrain, p.x, p.z, this.normal);
      this.state.velocity.addScaledVector(this.normal, -this.state.velocity.dot(this.normal));
    }
    this.look.heading = pose.heading;
    this.look.pitchDegrees = Math.min(pose.pitch, 10);
    this.skiYaw = this.look.yaw;
    this.state.yaw = this.skiYaw;
    this.prevVelocity.copy(this.state.velocity);
    this.accel.set(0, 0, 0);
    this.updateCamera();
  }

  /** Change skis: handling and the visible skis follow the setup. */
  setSetup(setup: SkiSetup): void {
    this.handling = skiHandling(setup);
    this.model.setSkiSetup(setup);
  }

  setActive(active: boolean): void {
    this.skier.visible = active;
    this.model.setOpacity(1);
    this.applyView();
  }

  setView(view: SkiCamera): void {
    this.view = view;
    this.applyView();
  }

  groundAt(x: number, z: number): number {
    return this.terrain.height(x, z);
  }

  /** Pose the skier riding a lift: `crouch` ~0.6 seated on a chair, ~0.15 standing. */
  showRiding(feet: Vector3, yaw: number, crouch: number): void {
    this.skier.visible = true;
    this.model.setOpacity(1);
    this.model.setFirstPerson(this.view === 'first-person');
    this.skier.position.copy(feet);
    this.skier.quaternion.setFromAxisAngle(UP, yaw);
    RIDING_STANCE.crouch = crouch;
    RIDING_STANCE.poleSweep = crouch > 0.5 ? 1.1 : 0.4;
    this.model.apply(RIDING_STANCE, UP);
  }

  /** World positions of the two skis (after this frame's pose). */
  skiPositions(left: Vector3, right: Vector3): void {
    this.skier.updateMatrixWorld(true);
    this.model.skiPosition('left', left);
    this.model.skiPosition('right', right);
  }

  /** Show the skier hovering upright at a fly-mode eye position (third-person flying). */
  showFlying(eye: Vector3, yaw: number): void {
    this.skier.visible = true;
    this.model.setFirstPerson(false);
    this.model.setOpacity(FLYING_OPACITY);
    this.skier.position.set(eye.x, eye.y - EYE_HEIGHT, eye.z);
    this.skier.quaternion.setFromAxisAngle(UP, yaw);
    this.model.apply(FLYING_STANCE, UP);
  }

  /** First person shows only your skis and boots below you; chase shows the whole skier. */
  private applyView(): void {
    this.model.setFirstPerson(this.view === 'first-person');
  }

  update(dt: number, input: Input): void {
    this.look.apply(input, (80 * Math.PI) / 180);
    const turn = (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0);
    const pivot = input.down('KeyS');
    if (pivot) {
      // Upper body stays put; only the skis swing.
      const twist = wrapAngle(
        this.skiYaw + turn * PIVOT_RATE * this.handling.pivotRate * dt - this.look.yaw,
      );
      this.skiYaw = this.look.yaw + Math.max(-MAX_TWIST, Math.min(MAX_TWIST, twist));
    } else {
      this.look.yaw += turn * TURN_RATE * this.handling.turnRate * dt;
      const twist = wrapAngle(this.skiYaw - this.look.yaw);
      this.skiYaw = this.look.yaw + twist * Math.exp(-REALIGN_RATE * dt);
    }
    this.state.yaw = this.skiYaw;

    const tuck = input.down('ControlLeft', 'ControlRight');
    const plough = input.down('ShiftLeft', 'ShiftRight');
    const forward = input.down('KeyW') && !tuck && !plough;
    const flatSpeed = Math.hypot(this.state.velocity.x, this.state.velocity.z);
    const skate = forward && (flatSpeed < SKATE_MAX || this.climbing);
    const pole = forward && !skate;
    const wasAirborne = this.state.airborne;
    const fallSpeed = -this.state.velocity.y;
    stepSki(
      this.state,
      {
        tuck,
        push: skate,
        pole,
        brake: plough,
        jump: input.wasPressed('Space') && !this.state.airborne,
      },
      dt,
      this.terrain,
      this.handling,
    );

    const p = this.state.position;
    this.terrain.collide?.(p, this.state.velocity);
    p.x = Math.min(Math.max(p.x, this.bounds.minX), this.bounds.maxX);
    p.z = Math.min(Math.max(p.z, this.bounds.minZ), this.bounds.maxZ);

    // Edging follows how sharply the path is actually curving, not where you look.
    const v = this.state.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed > 0.5 && dt > 0) {
      const yaw = Math.atan2(-v.x, -v.z);
      let d = yaw - this.travelYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.travelYaw = yaw;
      this.turnRate += (d / dt - this.turnRate) * Math.min(1, dt * 6);
    } else {
      this.turnRate *= Math.exp(-dt * 6);
    }
    // Sideways slide relative to the skis (m/s, > 0 = sliding toward the skis' right).
    const sideslip = v.x * Math.cos(this.skiYaw) - v.z * Math.sin(this.skiYaw);

    // Balance: the body lines up with the force the snow pushes back with, which is
    // gravity plus the acceleration. Standing on a side slope you stay vertical (so you
    // tilt uphill relative to the snow); carving you lean into the turn; in a hockey
    // stop you lean back against the mountain. In the air there's nothing to push on.
    if (dt > 0) {
      const raw = this.state.airborne
        ? ZERO
        : this.prevVelocity
            .sub(v)
            .multiplyScalar(-1 / dt)
            .clampLength(0, MAX_BALANCE_ACCEL);
      this.accel.lerp(raw, 1 - Math.exp(-BALANCE_RATE * dt));
    }
    this.prevVelocity.copy(v);
    this.orient();
    this.inverse.copy(this.skier.quaternion).invert();
    this.bodyUp
      .set(this.accel.x, this.accel.y + SKI.gravity, this.accel.z)
      .normalize()
      .applyQuaternion(this.inverse);
    // Edge angle: how far the balance line tips across the skis from the slope normal.
    const balanceEdge = Math.atan2(-this.bodyUp.x, this.bodyUp.y);

    this.landingImpact = wasAirborne && !this.state.airborne ? Math.max(0, fallSpeed) : 0;
    Object.assign(this.contact, {
      speed,
      sideslip,
      edge: balanceEdge,
      onSnow: !this.state.airborne,
      groomed: this.terrain.groomed?.(p.x, p.z) ?? true,
    });
    const events = updateStance(
      this.stance,
      {
        speed,
        sideslip,
        twist: wrapAngle(this.look.yaw - this.skiYaw),
        turnRate: this.turnRate,
        balanceEdge,
        plough,
        skate,
        pole,
        climb: this.state.climbing ?? false,
        tuck,
        airborne: this.state.airborne,
        edgeRate: this.handling.edgeRate,
      },
      dt,
    );
    this.footstep = events.step && (this.climbing || speed < WALK_MAX);
    this.polePlant = events.plant;
    this.updateCamera();
  }

  private updateCamera(): void {
    const p = this.state.position;
    const eye = EYE_HEIGHT - CROUCH_DROP * this.stance.crouch;

    if (this.view === 'first-person') {
      // Head follows the body's lean a little, and bobs with skating strides.
      const bob = Math.abs(Math.sin(this.stance.skatePhase)) * 0.04 * (1 - this.stance.crouch);
      this.camera.position.set(p.x, p.y + eye - bob, p.z);
      this.euler.set(this.look.pitch, this.look.yaw, this.stance.lean * 0.3);
      this.camera.quaternion.setFromEuler(this.euler);
    } else {
      // Orbit behind the skier; looking down raises the camera.
      const elevation = 0.25 - this.look.pitch;
      const back = CHASE_DISTANCE * Math.cos(elevation);
      const cam = this.camera.position;
      cam.set(
        p.x + Math.sin(this.look.yaw) * back,
        p.y + 1.2 + CHASE_DISTANCE * Math.sin(elevation),
        p.z + Math.cos(this.look.yaw) * back,
      );
      cam.y = Math.max(cam.y, this.terrain.height(cam.x, cam.z) + 1);
      this.camera.lookAt(p.x, p.y + 1.0, p.z);
    }

    this.orient();
    this.model.apply(this.stance, this.bodyUp);
  }

  /** Skis flat on the slope, pointing where the skis point. */
  private orient(): void {
    const p = this.state.position;
    surfaceNormal(this.terrain, p.x, p.z, this.normal);
    this.q.setFromUnitVectors(UP, this.normal);
    this.qYaw.setFromAxisAngle(UP, this.skiYaw);
    this.skier.position.copy(p);
    this.skier.quaternion.copy(this.q).multiply(this.qYaw);
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
