import { Euler, Group, type PerspectiveCamera, Vector3 } from 'three/webgpu';

import { FLY } from '../config';
import type { Pose } from '../nav/pose';
import { cameraSettings } from './camera-settings';
import type { Bounds } from './fly-controls';
import { createWing, type WingSpec } from './glider-controls';
import { type Input, Look } from './input';
import { EYE_HEIGHT } from './ski-controls';
import { SkierModel } from './ski-model';
import { initialStance, type Stance } from './ski-stance';
import {
  createSkydiveState,
  inflation,
  openCanopy,
  type SkydiveState,
  stepSkydive,
} from './skydive-physics';

/**
 * A 170 ft² ram-air sport canopy: nine cells, ~6.3 m across, rectangular, on ~3.4 m of
 * lines (the paraglider's is 10.5 m, tapered, on 7 m).
 */
const CANOPY: WingSpec = {
  span: 6.3,
  chord: 2.5,
  height: 4.9,
  arc: 0.42,
  cells: 9,
  thickness: 0.32,
  taper: 0.05,
  band: 1,
  colours: [
    [0.85, 0.08, 0.1],
    [0.97, 0.97, 0.98],
    [0.08, 0.2, 0.55],
  ],
  hang: 1.5,
};
/** Body pivot (centre of mass) above the feet (m). */
const COM = 1.0;
/** Chase camera distance behind (m): close in freefall, further out under canopy. */
const CHASE = { freefall: 6.5, canopy: 11 };

/** A skydiver and canopy, posed by `poseSkydiver` (local and remote players share it). */
export interface SkydiveRig {
  root: Group;
  /** The body turns about its centre of mass. */
  pivot: Group;
  skier: SkierModel;
  canopy: Group;
}

export function createSkydiveRig(): SkydiveRig {
  const root = new Group();
  root.name = 'skydiver';
  const pivot = new Group();
  pivot.position.y = COM;
  const skier = new SkierModel();
  skier.root.position.y = -COM;
  pivot.add(skier.root);
  const canopy = new Group();
  canopy.name = 'canopy';
  canopy.add(createWing(CANOPY));
  canopy.visible = false;
  root.add(pivot, canopy);
  return { root, pivot, skier, canopy };
}

const E = new Euler(0, 0, 0, 'YXZ');

/**
 * Feet (the ground contact) at `position`; facing `heading`; the body pitched `pitch`
 * (0 upright, -π/2 belly to earth, -π head down); the canopy `open` (0..1) and banked
 * `bank` (rad, + left), the body swinging under it.
 */
export function poseSkydiver(
  rig: SkydiveRig,
  position: Vector3,
  heading: number,
  pitch: number,
  open: number,
  bank: number,
): void {
  rig.root.position.copy(position);
  rig.pivot.quaternion.setFromEuler(E.set(pitch, heading, bank, 'YXZ'));
  rig.canopy.visible = open > 0.02;
  if (rig.canopy.visible) {
    // Unfolding: from a narrow bundle to the full span as it fills.
    const s = 0.12 + 0.88 * open;
    rig.canopy.scale.set(s, 0.35 + 0.65 * open, 0.4 + 0.6 * open);
    rig.canopy.quaternion.setFromEuler(E.set(0, heading, bank, 'YXZ'));
  }
}

/** The skydiver's arms (grip, skier frame) for each body position; legs as when skiing. */
function pose(stance: Stance, s: SkydiveState): void {
  const open = s.canopy ? inflation(s.canopy.time) : 0;
  const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i]! - v) * t);
  // Belly: arms out to the sides at shoulder height, a little back (the arch).
  let hand = [0.62, 1.52, 0.08];
  hand = lerp(hand, [0.3, 0.95, 0.18], s.track); // tracking: arms back by the hips
  hand = lerp(hand, [0.72, 1.6, 0.02], s.flare * (1 - open)); // flared: spread wide
  hand = lerp(hand, [0.42, 1.72, -0.1], s.headDown); // head down: out for balance
  // Under canopy: hands up on the toggles, pulled down to the hips to flare.
  const toggles = lerp([0.32, 2.0, -0.05], [0.3, 1.05, -0.1], open > 0 ? s.flare : 0);
  hand = lerp(hand, toggles, open);
  stance.grip = { x: hand[0]!, y: hand[1]!, z: hand[2]! };
  // Knees bent a touch in the arch.
  stance.crouch = 0.15 * (1 - open) * (1 - s.track);
}

/**
 * Skydiving: freefall from an aircraft, then the canopy. A/D turn, W tracks, S flares
 * (spread out in freefall; both toggles down under canopy), E head down and Q back to
 * belly, Space opens the canopy. Mouse looks round. Touching down hands you to ski mode.
 */
export class SkydiveControls {
  readonly look = new Look(FLY.mouseSensitivity);
  readonly rig = createSkydiveRig();
  readonly root = this.rig.root;
  readonly pilot = this.rig.skier;
  view: 'first-person' | 'chase' = 'chase';
  readonly state: SkydiveState = createSkydiveState();
  /** The air: wind (world m/s) and temperature (°C or null). */
  air = { wind: new Vector3(), temperature: null as number | null };
  private readonly stance = initialStance();
  private headDown = 0;
  private bodyPitch = -Math.PI / 2;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly groundHeight: (x: number, z: number) => number,
    private readonly bounds: Bounds,
  ) {
    this.root.visible = false;
  }

  get position(): Vector3 {
    return this.state.position;
  }

  get velocity(): Vector3 {
    return this.state.velocity;
  }

  get speed(): number {
    return this.state.velocity.length();
  }

  get heading(): number {
    return this.look.heading;
  }

  get pitchDegrees(): number {
    return this.look.pitchDegrees;
  }

  /** Under an open (or opening) canopy. */
  get canopyOut(): boolean {
    return this.state.canopy !== null;
  }

  /** Canopy inflation 0..1, and its bank (rad). */
  get open(): number {
    return this.state.canopy ? inflation(this.state.canopy.time) : 0;
  }

  get bank(): number {
    return this.state.canopy?.bank ?? 0;
  }

  /** Which way the body faces (Look convention). */
  get bodyHeading(): number {
    return this.state.heading;
  }

  /** Height above the ground (m). */
  get agl(): number {
    const p = this.state.position;
    return p.y - this.groundHeight(p.x, p.z);
  }

  get airspeed(): number {
    return this.state.velocity.clone().sub(this.air.wind).length();
  }

  setActive(active: boolean): void {
    this.root.visible = active;
    this.pilot.setFlyingDrone(false);
    this.setView(this.view);
  }

  setView(view: 'first-person' | 'chase'): void {
    this.view = view;
    this.pilot.setFirstPerson(view === 'first-person' && this.root.visible);
  }

  /** Teleport: falling from the pose, belly to earth. */
  place(pose: Pose): void {
    const at = new Vector3(pose.east, pose.altitude - EYE_HEIGHT, -pose.north);
    this.jump(at, new Vector3(), (-pose.heading * Math.PI) / 180);
  }

  /** Out of the door at `at` (feet), carrying `velocity`, facing `heading` (Look yaw). */
  jump(at: Vector3, velocity: Vector3, heading: number): void {
    const s = this.state;
    s.position.copy(at);
    s.velocity.copy(velocity);
    s.heading = heading;
    s.headDown = 0;
    s.track = 0;
    s.flare = 0;
    s.canopy = null;
    s.aad = false;
    s.landed = null;
    this.headDown = 0;
    // Leaving the door upright, the body rolls belly-down into the airflow.
    this.bodyPitch = 0;
    this.look.yaw = heading;
    this.look.pitch = -0.35;
    this.update(0, null);
  }

  /** Pull: the canopy starts to open. */
  pull(): void {
    openCanopy(this.state);
  }

  /** Step; returns the landing (sink, crash) in the frame you touch down, else null. */
  update(dt: number, input: Input | null): SkydiveState['landed'] {
    const s = this.state;
    if (input) {
      this.look.apply(input);
      if (input.wasPressed('KeyE')) this.headDown = 1;
      if (input.wasPressed('KeyQ')) this.headDown = 0;
      if (input.wasPressed('Space')) this.pull();
      const headingBefore = s.heading;
      stepSkydive(
        s,
        {
          turn: input.turn,
          track: input.down('KeyW') || input.stickY > 0.5,
          flare: input.down('KeyS') || input.stickY < -0.5,
          headDown: this.headDown,
        },
        dt,
        this.groundHeight,
        this.air.wind,
        this.air.temperature,
      );
      // The view turns with you, so steering feels natural; mouse look is on top.
      this.look.yaw += s.heading - headingBefore;
      const p = s.position;
      p.x = Math.min(Math.max(p.x, this.bounds.minX), this.bounds.maxX);
      p.z = Math.min(Math.max(p.z, this.bounds.minZ), this.bounds.maxZ);
    }
    // Belly to earth, tipped head down or into a track; upright under the canopy.
    const open = this.open;
    const target = (-Math.PI / 2 - 0.2 * s.track - (Math.PI / 2) * s.headDown) * (1 - open);
    this.bodyPitch += (target - this.bodyPitch) * Math.min(1, 3 * dt);
    this.updateView();
    return s.landed;
  }

  /** The avatar mode others see. */
  get avatarMode(): 'freefall' | 'canopy' {
    return this.canopyOut ? 'canopy' : 'freefall';
  }

  /** Body pitch drawn (rad). */
  get pitch(): number {
    return this.bodyPitch;
  }

  private updateView(): void {
    const s = this.state;
    pose(this.stance, s);
    poseSkydiver(this.rig, s.position, s.heading, this.bodyPitch, this.open, this.bank);
    this.pilot.apply(this.stance);
    this.root.updateMatrixWorld(true);
    const p = s.position;
    if (this.view === 'first-person') {
      // From the head, wherever the body points.
      const eye = new Vector3(0, 1.62 - COM, -0.08).applyQuaternion(this.rig.pivot.quaternion);
      this.camera.position
        .copy(p)
        .add(eye)
        .setY(p.y + COM + eye.y);
      this.euler.set(this.look.pitch, this.look.yaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this.euler);
    } else {
      const chase = (this.canopyOut ? CHASE.canopy : CHASE.freefall) * cameraSettings.chaseDistance;
      const elevation = 0.25 - this.look.pitch;
      const back = chase * Math.cos(elevation);
      const target = new Vector3(p.x, p.y + COM + (this.canopyOut ? 1.5 * this.open : 0), p.z);
      const cam = this.camera.position;
      cam.set(
        target.x + Math.sin(this.look.yaw) * back,
        target.y + chase * Math.sin(elevation),
        target.z + Math.cos(this.look.yaw) * back,
      );
      cam.y = Math.max(cam.y, this.groundHeight(cam.x, cam.z) + 1);
      this.camera.lookAt(target);
    }
  }
}
