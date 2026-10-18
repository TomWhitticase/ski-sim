import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
  Mesh,
  MeshStandardNodeMaterial,
  type PerspectiveCamera,
  Vector3,
} from 'three/webgpu';

import { FLY } from '../config';
import type { Pose } from '../nav/pose';
import type { Bounds } from './fly-controls';
import { type Input, Look } from './input';
import { SkierModel } from './ski-model';
import { EYE_HEIGHT } from './ski-controls';
import { type GliderState, stepGlider } from './glider-physics';
import { initialStance } from './ski-stance';

/** Wing: an arched canopy ~10 m across, ~7 m above the pilot. */
const WING = { span: 10.5, chord: 2.6, height: 7, arc: 0.85, cells: 28, thickness: 0.18 };
const CELL_COLOURS: [number, number, number][] = [
  [0.95, 0.42, 0.08], // orange
  [0.97, 0.97, 0.98], // white
  [0.04, 0.45, 0.52], // teal (matches the jacket)
];
const CHASE_DISTANCE = 13;
/** Seconds after launch before touching the snow counts as landing. */
const LAUNCH_GRACE = 1.2;
const HANG_POINT = 1.45; // risers clip in around chest height

/** Point on the wing's arc at spanwise s ∈ [-1, 1], in the pilot's frame. */
function wingPoint(s: number, chordFrac: number): Vector3 {
  const radius = WING.span / 2 / Math.sin(WING.arc);
  const theta = s * WING.arc;
  const chord = WING.chord * (1 - 0.45 * s * s); // tapered tips
  return new Vector3(
    radius * Math.sin(theta),
    WING.height - radius * (1 - Math.cos(theta)),
    -chord * 0.45 + chord * chordFrac, // leading edge forward (-z)
  );
}

function createWing(): Group {
  const positions: number[] = [];
  const colours: number[] = [];
  const index: number[] = [];
  const rows = 6; // along the chord
  for (let c = 0; c < WING.cells; c++) {
    const colour = CELL_COLOURS[Math.floor(((c + 1) % 9) / 3)]!;
    const s0 = -1 + (2 * c) / WING.cells;
    const s1 = -1 + (2 * (c + 1)) / WING.cells;
    for (const top of [true, false]) {
      const start = positions.length / 3;
      for (let r = 0; r <= rows; r++) {
        const f = r / rows;
        // Airfoil-ish: top surface bulges, thickest near the front third.
        const bulge = top ? WING.thickness * Math.sin(Math.PI * Math.min(1, f * 1.4)) : 0;
        for (const s of [s0, s1]) {
          const p = wingPoint(s, f);
          p.y += bulge;
          positions.push(p.x, p.y, p.z);
          const shade = top ? 1 : 0.75;
          colours.push(colour[0] * shade, colour[1] * shade, colour[2] * shade);
        }
      }
      for (let r = 0; r < rows; r++) {
        const a = start + r * 2;
        if (top) index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        else index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const canopy = new Mesh(
    geometry,
    new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide }),
  );
  canopy.castShadow = true;

  // Lines: from the wing's underside, cascading down to a riser at each shoulder.
  const line: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const s = -0.95 + (1.9 * i) / 10;
    for (const f of [0.15, 0.5, 0.85]) {
      const p = wingPoint(s, f);
      const riser = new Vector3(Math.sign(s || 1) * 0.22, HANG_POINT, 0);
      line.push(p.x, p.y, p.z, riser.x, riser.y, riser.z);
    }
  }
  const lineGeometry = new BufferGeometry();
  lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(line), 3));
  const lines = new LineSegments(lineGeometry, new LineBasicNodeMaterial({ color: 0x2b2d31 }));

  const wing = new Group();
  wing.add(canopy, lines);
  return wing;
}

/**
 * Paragliding: A/D bank and turn, W speed bar, S brakes, mouse looks around freely.
 * Touching the ground hands you back to ski mode.
 */
export class GliderControls {
  readonly look = new Look(FLY.mouseSensitivity);
  readonly root = new Group();
  view: 'first-person' | 'chase' = 'first-person';

  private readonly pilot = new SkierModel();
  private readonly stance = initialStance();
  private readonly state: GliderState = {
    position: new Vector3(),
    velocity: new Vector3(),
    heading: 0,
    bank: 0,
  };
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly swing = new Group();
  /** Seconds since launch: touching the snow while the wing inflates isn't a landing. */
  private airTime = 0;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly groundHeight: (x: number, z: number) => number,
    private readonly bounds: Bounds,
  ) {
    this.root.name = 'glider';
    this.stance.crouch = 0.3; // seated in the harness
    this.stance.poleSweep = 1.2;
    this.swing.add(this.pilot.root, createWing());
    this.root.add(this.swing);
    this.root.visible = false;
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

  setActive(active: boolean): void {
    this.root.visible = active;
  }

  setView(view: 'first-person' | 'chase'): void {
    this.view = view;
    this.pilot.setFirstPerson(view === 'first-person');
  }

  /** Teleport: hang at the pose (eye altitude) with no momentum. */
  place(pose: Pose): void {
    const feet = new Vector3(pose.east, pose.altitude - EYE_HEIGHT, -pose.north);
    this.launch(feet, new Vector3(), (-pose.heading * Math.PI) / 180, (pose.pitch * Math.PI) / 180);
  }

  /** Deploy at `feet` carrying `velocity`; the wing points along your travel if moving. */
  launch(feet: Vector3, velocity: Vector3, lookYaw: number, lookPitch: number): void {
    this.state.position.copy(feet);
    this.state.velocity.copy(velocity);
    // Launching off the snow: the wing lifts you clear rather than "landing" at once.
    const ground = this.groundHeight(feet.x, feet.z);
    if (this.state.position.y < ground + 0.6) {
      this.state.position.y = ground + 0.6;
      this.state.velocity.y = Math.max(this.state.velocity.y, 1);
    }
    this.airTime = 0;
    this.state.bank = 0;
    const horizontal = Math.hypot(velocity.x, velocity.z);
    this.state.heading = horizontal > 1 ? Math.atan2(-velocity.x, -velocity.z) : lookYaw;
    this.look.yaw = lookYaw;
    this.look.pitch = lookPitch;
    this.updateView();
  }

  /** Returns true when you've touched down. */
  update(dt: number, input: Input): boolean {
    const headingBefore = this.state.heading;
    this.look.apply(input);
    const turn = (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0);
    this.airTime += dt;
    const touched = stepGlider(
      this.state,
      { turn, bar: input.down('KeyW'), brake: input.down('KeyS') },
      dt,
      this.groundHeight,
    );
    const landed = touched && this.airTime > LAUNCH_GRACE;
    if (touched && !landed) {
      // Still inflating: skim the snow and keep going.
      const p = this.state.position;
      p.y = this.groundHeight(p.x, p.z) + 0.3;
      this.state.velocity.y = Math.max(this.state.velocity.y, 0.5);
    }
    // The view turns with the wing, so steering feels natural; mouse look is on top.
    this.look.yaw += this.state.heading - headingBefore;

    const p = this.state.position;
    p.x = Math.min(Math.max(p.x, this.bounds.minX), this.bounds.maxX);
    p.z = Math.min(Math.max(p.z, this.bounds.minZ), this.bounds.maxZ);
    this.updateView();
    return landed;
  }

  private updateView(): void {
    const p = this.state.position;
    // Pilot and wing swing out together around the wing in a turn.
    this.root.position.copy(p);
    this.root.rotation.set(0, this.state.heading, 0);
    this.swing.position.set(0, WING.height, 0);
    this.swing.rotation.set(0, 0, this.state.bank);
    this.swing.children.forEach((c) => c.position.set(0, -WING.height, 0));
    this.pilot.apply(this.stance);

    if (this.view === 'first-person') {
      // Eye, rotated with the swing of the bank.
      const eye = new Vector3(0, EYE_HEIGHT - 0.3 - WING.height, 0)
        .applyEuler(new Euler(0, 0, this.state.bank))
        .add(new Vector3(0, WING.height, 0))
        .applyEuler(new Euler(0, this.state.heading, 0))
        .add(p);
      this.camera.position.copy(eye);
      this.euler.set(this.look.pitch, this.look.yaw, this.state.bank * 0.6);
      this.camera.quaternion.setFromEuler(this.euler);
    } else {
      const elevation = 0.2 - this.look.pitch;
      const back = CHASE_DISTANCE * Math.cos(elevation);
      const target = new Vector3(p.x, p.y + 3, p.z);
      const cam = this.camera.position;
      cam.set(
        target.x + Math.sin(this.look.yaw) * back,
        target.y + CHASE_DISTANCE * Math.sin(elevation),
        target.z + Math.cos(this.look.yaw) * back,
      );
      cam.y = Math.max(cam.y, this.groundHeight(cam.x, cam.z) + 1);
      this.camera.lookAt(target);
    }
  }
}
