import { Euler, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

import { FLY } from '../config';
import type { Pose } from '../nav/pose';
import type { Bounds } from './fly-controls';
import { type Input, Look } from './input';
import { SkierModel } from './ski-model';
import { SKI, type SkiState, type SkiTerrain, stepSki, surfaceNormal } from './ski-physics';
import { initialStance, updateStance } from './ski-stance';

export const EYE_HEIGHT = 1.7;
/** How far the eye drops in a full tuck (m). */
const CROUCH_DROP = 0.6;
/** Skating animates up to this speed; above it you're gliding, not striding. */
const SKATE_ANIM_MAX = 8;
const TURN_RATE = 1.8; // rad/s with A/D
const CHASE_DISTANCE = 7;
const UP = new Vector3(0, 1, 0);
const ZERO = new Vector3();

export type SkiCamera = 'first-person' | 'chase';

/**
 * Ski mode: mouse looks and steers (skis point where you look), A/D also turn,
 * W skates, Ctrl tucks, Shift (or S) snowploughs, Space jumps, V swaps camera.
 */
export class SkiControls {
  readonly look = new Look(FLY.mouseSensitivity);
  private readonly model = new SkierModel();
  readonly skier = this.model.root;
  private readonly stance = initialStance();
  view: SkiCamera = 'first-person';

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

  /** Where the skis are (the camera may be behind, in chase view). */
  get feet(): Vector3 {
    return this.state.position;
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
    this.state.yaw = this.look.yaw;
    this.updateCamera();
  }

  setActive(active: boolean): void {
    this.skier.visible = active;
    this.applyView();
  }

  toggleView(): void {
    this.view = this.view === 'first-person' ? 'chase' : 'first-person';
    this.applyView();
  }

  /** First person shows only your skis and boots below you; chase shows the whole skier. */
  private applyView(): void {
    this.model.setFirstPerson(this.view === 'first-person');
  }

  update(dt: number, input: Input): void {
    this.look.apply(input, (80 * Math.PI) / 180);
    const turn = (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0);
    this.look.yaw += turn * TURN_RATE * dt;
    this.state.yaw = this.look.yaw;

    const tuck = input.down('ControlLeft', 'ControlRight');
    const plough = input.down('ShiftLeft', 'ShiftRight', 'KeyS');
    const skate = input.down('KeyW') && !tuck && !plough;
    stepSki(
      this.state,
      {
        tuck,
        push: skate,
        brake: plough,
        jump: input.wasPressed('Space') && !this.state.airborne,
      },
      dt,
      this.terrain,
    );

    const p = this.state.position;
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
    updateStance(
      this.stance,
      {
        speed,
        turnRate: this.turnRate,
        plough,
        skate: skate && speed < SKATE_ANIM_MAX,
        tuck,
        airborne: this.state.airborne,
      },
      dt,
    );
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

    // Stand on the slope, facing the skis.
    surfaceNormal(this.terrain, p.x, p.z, this.normal);
    this.q.setFromUnitVectors(UP, this.normal);
    this.qYaw.setFromAxisAngle(UP, this.look.yaw);
    this.skier.position.copy(p);
    this.skier.quaternion.copy(this.q).multiply(this.qYaw);
    this.model.apply(this.stance);
  }
}
