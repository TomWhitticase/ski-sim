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
import { SKI, type SkiState, type SkiTerrain, stepSki, surfaceNormal } from './ski-physics';

export const EYE_HEIGHT = 1.7;
const EYE_HEIGHT_TUCK = 1.15;
const TURN_RATE = 1.8; // rad/s with A/D
const CHASE_DISTANCE = 7;
const UP = new Vector3(0, 1, 0);
const ZERO = new Vector3();

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
    this.updateCamera(0);
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
    this.skier.getObjectByName('body')!.visible = this.view === 'chase';
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
    this.skier.getObjectByName('body')!.scale.y = this.eye / EYE_HEIGHT;
  }
}

/**
 * A simple skier facing -z like the camera: a body (hidden in first person, where the
 * camera sits inside it) and the kit you see when you look down: skis and boots.
 */
function createSkier(): Group {
  const jacket = new MeshStandardNodeMaterial({ color: 0xd6336c, roughness: 0.7 });
  const helmet = new MeshStandardNodeMaterial({ color: 0x212529, roughness: 0.4 });
  const trousers = new MeshStandardNodeMaterial({ color: 0x343a40, roughness: 0.8 });
  const skiBase = new MeshStandardNodeMaterial({ color: 0x1c7ed6, roughness: 0.35 });
  const skiTip = new MeshStandardNodeMaterial({ color: 0xf1f3f5, roughness: 0.35 });
  const bootMat = new MeshStandardNodeMaterial({ color: 0x212529, roughness: 0.5 });
  const bindingMat = new MeshStandardNodeMaterial({
    color: 0xadb5bd,
    metalness: 0.6,
    roughness: 0.4,
  });

  const body = new Group();
  body.name = 'body';
  const torso = new Mesh(new CapsuleGeometry(0.22, 0.5, 4, 8), jacket);
  torso.position.y = 1.15;
  const head = new Mesh(new SphereGeometry(0.15, 12, 8), helmet);
  head.position.y = 1.62;
  const legGeometry = new CapsuleGeometry(0.09, 0.55, 4, 8);
  const legs = [-0.13, 0.13].map((x) => {
    const leg = new Mesh(legGeometry, trousers);
    leg.position.set(x, 0.62, 0);
    return leg;
  });
  body.add(torso, head, ...legs);

  // Skis 1.7 m long, mounted slightly behind centre, with upturned white tips.
  const kit = new Group();
  kit.name = 'kit';
  const skiGeometry = new BoxGeometry(0.1, 0.025, 1.45);
  const tipGeometry = new BoxGeometry(0.1, 0.02, 0.28);
  const bootGeometry = new BoxGeometry(0.13, 0.26, 0.32);
  const bindingGeometry = new BoxGeometry(0.11, 0.04, 0.42);
  const meshes: Mesh[] = [...legs, torso, head];
  for (const x of [-0.13, 0.13]) {
    const ski = new Mesh(skiGeometry, skiBase);
    ski.position.set(x, 0.015, 0.05);
    const tip = new Mesh(tipGeometry, skiTip);
    tip.position.set(x, 0.05, -0.79);
    tip.rotation.x = 0.35; // turned up at the front (-z)
    const binding = new Mesh(bindingGeometry, bindingMat);
    binding.position.set(x, 0.045, 0.02);
    const boot = new Mesh(bootGeometry, bootMat);
    boot.position.set(x, 0.19, 0.02);
    kit.add(ski, tip, binding, boot);
    meshes.push(ski, tip, binding, boot);
  }

  const skier = new Group();
  skier.add(body, kit);
  for (const mesh of meshes) mesh.castShadow = true;
  return skier;
}
