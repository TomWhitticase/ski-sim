import {
  BoxGeometry,
  CapsuleGeometry,
  Euler,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  type PerspectiveCamera,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

import { FLY } from '../config';
import type { Pose } from '../nav/pose';
import type { Bounds } from './fly-controls';
import { type Input, Look } from './input';
import { type SkiState, type SkiTerrain, stepSki, surfaceNormal } from './ski-physics';

const EYE_HEIGHT = 1.7;
const EYE_HEIGHT_TUCK = 1.15;
const TURN_RATE = 1.8; // rad/s with A/D
const CHASE_DISTANCE = 7;
const UP = new Vector3(0, 1, 0);

export type SkiCamera = 'first-person' | 'chase';

/**
 * Ski mode: mouse looks and steers (skis point where you look), A/D also turn,
 * W tucks (or skates when slow), S snowploughs, Space jumps, V swaps camera.
 */
export class SkiControls {
  readonly look = new Look(FLY.mouseSensitivity);
  readonly skier = createSkier();
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
  private roll = 0;
  private eye = EYE_HEIGHT;
  private tucking = false;

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

  /** Stand on the snow below the pose, at rest, facing its heading. */
  place(pose: Pose): void {
    const p = this.state.position;
    p.set(pose.east, 0, -pose.north);
    p.y = this.terrain.height(p.x, p.z);
    this.state.velocity.set(0, 0, 0);
    this.state.airborne = false;
    this.look.heading = pose.heading;
    this.look.pitchDegrees = Math.min(pose.pitch, 10);
    this.state.yaw = this.look.yaw;
    this.updateCamera(0);
  }

  setActive(active: boolean): void {
    this.skier.visible = active && this.view === 'chase';
  }

  toggleView(): void {
    this.view = this.view === 'first-person' ? 'chase' : 'first-person';
    this.skier.visible = this.view === 'chase';
  }

  update(dt: number, input: Input): void {
    const yawBefore = this.look.yaw;
    this.look.apply(input, (80 * Math.PI) / 180);
    const turn = (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0);
    this.look.yaw += turn * TURN_RATE * dt;
    this.state.yaw = this.look.yaw;

    const slow = this.speed < 4;
    this.tucking = input.down('KeyW') && !slow;
    stepSki(
      this.state,
      {
        tuck: this.tucking,
        push: input.down('KeyW') && slow,
        brake: input.down('KeyS'),
        jump: input.wasPressed('Space') && !this.state.airborne,
      },
      dt,
      this.terrain,
    );

    const p = this.state.position;
    p.x = Math.min(Math.max(p.x, this.bounds.minX), this.bounds.maxX);
    p.z = Math.min(Math.max(p.z, this.bounds.minZ), this.bounds.maxZ);

    // Lean into turns, more at speed.
    const yawRate = dt > 0 ? (this.look.yaw - yawBefore) / dt : 0;
    const targetRoll = Math.max(-0.3, Math.min(0.3, yawRate * Math.min(this.speed / 15, 1) * 0.2));
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 5);
    this.updateCamera(dt);
  }

  private updateCamera(dt: number): void {
    const p = this.state.position;
    const targetEye = this.tucking ? EYE_HEIGHT_TUCK : EYE_HEIGHT;
    this.eye += (targetEye - this.eye) * (dt > 0 ? Math.min(1, dt * 6) : 1);

    if (this.view === 'first-person') {
      this.camera.position.set(p.x, p.y + this.eye, p.z);
      this.euler.set(this.look.pitch, this.look.yaw, this.roll);
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
      this.camera.lookAt(p.x, p.y + 1.2, p.z);
    }

    // Skier model: stand on the slope, face the skis, crouch when tucking.
    surfaceNormal(this.terrain, p.x, p.z, this.normal);
    this.q.setFromUnitVectors(UP, this.normal);
    this.qYaw.setFromAxisAngle(UP, this.look.yaw);
    this.skier.position.copy(p);
    this.skier.quaternion.copy(this.q).multiply(this.qYaw);
    this.skier.children[0]!.scale.y = this.eye / EYE_HEIGHT;
  }
}

/** A simple skier: jacket, helmet and two skis. Faces -z like the camera. */
function createSkier(): Group {
  const jacket = new MeshStandardNodeMaterial({ color: 0xd6336c, roughness: 0.7 });
  const helmet = new MeshStandardNodeMaterial({ color: 0x212529, roughness: 0.4 });
  const skiMat = new MeshStandardNodeMaterial({ color: 0x1c7ed6, roughness: 0.5 });

  const trousers = new MeshStandardNodeMaterial({ color: 0x343a40, roughness: 0.8 });

  const body = new Group();
  const torso = new Mesh(new CapsuleGeometry(0.22, 0.5, 4, 8), jacket);
  torso.position.y = 1.15;
  const head = new Mesh(new SphereGeometry(0.15, 12, 8), helmet);
  head.position.y = 1.62;
  const legGeometry = new CapsuleGeometry(0.09, 0.7, 4, 8);
  const legs = [-0.13, 0.13].map((x) => {
    const leg = new Mesh(legGeometry, trousers);
    leg.position.set(x, 0.45, 0);
    return leg;
  });
  body.add(torso, head, ...legs);

  const skiGeometry = new BoxGeometry(0.09, 0.03, 1.7);
  const left = new Mesh(skiGeometry, skiMat);
  const right = new Mesh(skiGeometry, skiMat);
  left.position.set(-0.13, 0.02, -0.1);
  right.position.set(0.13, 0.02, -0.1);

  const skier = new Group();
  skier.add(body, left, right);
  for (const mesh of [torso, head, ...legs, left, right]) mesh.castShadow = true;
  return skier;
}
