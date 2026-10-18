import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  SphereGeometry,
} from 'three/webgpu';

import type { SkiPose, Stance } from './ski-stance';

type RGB = [number, number, number];

/** A 170 cm all-mountain ski, 124/100/116 mm (tip/waist/tail), skier-local -z = forward. */
const SKI = {
  length: 1.7,
  /** Distance from the boot centre to the tail; the mount point sits a bit behind centre. */
  tail: 0.8,
  tipWidth: 0.124,
  waistWidth: 0.1,
  tailWidth: 0.116,
  tipRise: 0.07,
  tailRise: 0.025,
  stations: 64,
};

const TOPSHEET: RGB = [0.05, 0.12, 0.32];
const ACCENT: RGB = [0.95, 0.42, 0.08];
const TIP: RGB = [0.92, 0.93, 0.95];
const BASE: RGB = [0.04, 0.04, 0.05];
const EDGE: RGB = [0.62, 0.64, 0.67];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Shape of the ski at fraction t along it (0 = tail end, 1 = tip end). */
export function skiProfile(t: number): { halfWidth: number; rise: number; thickness: number } {
  // Sidecut: a smooth curve through tail contact, waist and shovel...
  const waistT = 0.48;
  const w =
    t < waistT
      ? SKI.waistWidth + (SKI.tailWidth - SKI.waistWidth) * ((waistT - t) / waistT) ** 2
      : SKI.waistWidth + (SKI.tipWidth - SKI.waistWidth) * ((t - waistT) / (0.86 - waistT)) ** 2;
  // ...rounded off at the very tip and tail.
  const tipRound = t > 0.86 ? Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2)) : 1;
  const tailRound = t < 0.04 ? Math.sqrt(Math.max(0, 1 - ((0.04 - t) / 0.04) ** 2)) : 1;
  const width =
    Math.min(w, t > 0.86 ? SKI.tipWidth : Infinity) * (0.35 + 0.65 * tipRound * tailRound);
  // Rocker: the shovel curves up over the last fifth; a small tail kick.
  const rise =
    SKI.tipRise * smoothstep(0.8, 1, t) ** 1.6 + SKI.tailRise * smoothstep(0.07, 0, t) ** 1.6;
  // Thickest underfoot, thin at the ends.
  const thickness = 0.007 + 0.011 * Math.exp(-(((t - 0.47) / 0.22) ** 2));
  return { halfWidth: width / 2, rise, thickness };
}

function topsheetColour(t: number): RGB {
  if (t > 0.83) return TIP;
  if (t > 0.62 && t < 0.68) return ACCENT;
  if (t < 0.05) return TIP;
  return TOPSHEET;
}

/** Ski with separate top, base and edge faces (sharp creases, vertex-coloured). */
export function createSkiGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const n = SKI.stations;

  // Each face strip: two rails of vertices along the ski, triangulated between them.
  const strip = (
    railA: (t: number) => [number, number, number],
    railB: (t: number) => [number, number, number],
    colour: (t: number) => RGB,
  ) => {
    const start = positions.length / 3;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      for (const p of [railA(t), railB(t)]) {
        positions.push(...p);
        colours.push(...colour(t));
      }
    }
    for (let i = 0; i < n; i++) {
      const a = start + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };

  const z = (t: number) => SKI.tail - t * SKI.length;
  const at = (t: number, side: -1 | 1, top: boolean): [number, number, number] => {
    const p = skiProfile(t);
    return [side * p.halfWidth, p.rise + (top ? p.thickness : 0), z(t)];
  };
  // Wound so each face's front points outward.
  strip(
    (t) => at(t, -1, true),
    (t) => at(t, 1, true),
    topsheetColour,
  ); // top, faces up
  strip(
    (t) => at(t, 1, false),
    (t) => at(t, -1, false),
    () => BASE,
  ); // base, faces down
  strip(
    (t) => at(t, 1, true),
    (t) => at(t, 1, false),
    () => EDGE,
  ); // right edge
  strip(
    (t) => at(t, -1, false),
    (t) => at(t, -1, true),
    () => EDGE,
  ); // left edge

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const UNDERFOOT = skiProfile(SKI.tail / SKI.length).thickness;

interface SkiRig {
  group: Group;
}

/**
 * Skier model: skis with bindings and boots (always visible, including in first person
 * when you look down), poles, and a body shown in the chase camera.
 */
export class SkierModel {
  readonly root = new Group();
  private readonly figure = new Group();
  private readonly upper = new Group();
  private readonly poles: Group[] = [];
  private readonly skis: { left: SkiRig; right: SkiRig };
  private readonly legs: Mesh[] = [];

  constructor() {
    const mat = (color: number, roughness: number, metalness = 0) =>
      new MeshStandardNodeMaterial({ color, roughness, metalness });
    const skiMat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.3 });
    const binding = mat(0x2b2d31, 0.45, 0.3);
    const bindingMetal = mat(0xb8bcc2, 0.35, 0.8);
    const shell = mat(0x1f2124, 0.45);
    const cuff = mat(0xe8590c, 0.45);
    const buckle = mat(0xced4da, 0.3, 0.8);
    const jacket = mat(0xd6336c, 0.7);
    const trousers = mat(0x343a40, 0.8);
    const helmet = mat(0xf1f3f5, 0.35);
    const goggles = mat(0xf59f00, 0.1, 0.6);
    const glove = mat(0x212529, 0.7);
    const poleShaft = mat(0xadb5bd, 0.3, 0.8);
    const poleGrip = mat(0x212529, 0.8);

    const skiGeometry = createSkiGeometry();
    const plate = new BoxGeometry(0.072, 0.014, 0.42);
    const toe = new BoxGeometry(0.068, 0.045, 0.085);
    const heel = new BoxGeometry(0.07, 0.06, 0.11);
    const brake = new BoxGeometry(0.115, 0.008, 0.012);
    const sole = new BoxGeometry(0.105, 0.03, 0.31);
    const lower = new BoxGeometry(0.105, 0.11, 0.27);
    const upperCuff = new BoxGeometry(0.11, 0.17, 0.15);
    const buckleGeometry = new BoxGeometry(0.115, 0.012, 0.03);

    const makeSki = (side: -1 | 1): SkiRig => {
      const group = new Group();
      const parts: Mesh[] = [];
      const add = (
        geometry: BufferGeometry,
        material: MeshStandardNodeMaterial,
        x: number,
        y: number,
        z: number,
      ) => {
        const mesh = new Mesh(geometry, material);
        mesh.position.set(x, y, z);
        group.add(mesh);
        parts.push(mesh);
        return mesh;
      };
      add(skiGeometry, skiMat, 0, 0, 0);
      const top = UNDERFOOT;
      add(plate, binding, 0, top + 0.007, 0);
      add(toe, binding, 0, top + 0.035, -0.2);
      add(heel, binding, 0, top + 0.042, 0.19);
      add(brake, bindingMetal, 0, top + 0.02, 0.13);
      // Boot: sole, lower shell, then a forward-leaning cuff with buckles.
      const bootBase = top + 0.026;
      add(sole, shell, 0, bootBase + 0.015, 0);
      add(lower, shell, 0, bootBase + 0.085, 0.015);
      const c = add(upperCuff, cuff, 0, bootBase + 0.215, 0.045);
      c.rotation.x = -0.25; // forward lean
      for (const y of [0.12, 0.19, 0.26]) {
        const b = add(buckleGeometry, buckle, 0, bootBase + y, -0.02 + (y - 0.12) * 0.35);
        b.rotation.x = -0.25;
      }
      for (const p of parts) p.castShadow = true;
      group.position.x = side * 0.11;
      group.name = side === -1 ? 'ski-left' : 'ski-right';
      this.root.add(group);
      return { group };
    };
    this.skis = { left: makeSki(-1), right: makeSki(1) };

    // Body for the chase camera. `figure` holds what first person hides.
    const add = (parent: Group, mesh: Mesh, x: number, y: number, z: number) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    for (const x of [-0.11, 0.11]) {
      this.legs.push(
        add(this.figure, new Mesh(new CapsuleGeometry(0.075, 0.5, 4, 8), trousers), x, 0.62, 0.02),
      );
    }
    add(this.upper, new Mesh(new CapsuleGeometry(0.19, 0.38, 4, 10), jacket), 0, 0.33, 0);
    add(this.upper, new Mesh(new SphereGeometry(0.135, 14, 10), helmet), 0, 0.74, -0.02);
    add(this.upper, new Mesh(new BoxGeometry(0.2, 0.06, 0.06), goggles), 0, 0.74, -0.13);
    for (const x of [-0.25, 0.25]) {
      const arm = add(
        this.upper,
        new Mesh(new CapsuleGeometry(0.055, 0.38, 4, 8), jacket),
        x,
        0.32,
        -0.08,
      );
      arm.rotation.x = 0.5;
    }
    this.upper.position.y = 0.9; // hips
    this.figure.add(this.upper);
    this.figure.name = 'body';
    this.root.add(this.figure);

    // Poles hang from the hands; their pivot is the grip.
    for (const side of [-1, 1] as const) {
      const pole = new Group();
      add(pole, new Mesh(new CylinderGeometry(0.009, 0.006, 1.15, 6), poleShaft), 0, -0.575, 0);
      add(pole, new Mesh(new CylinderGeometry(0.016, 0.014, 0.13, 8), poleGrip), 0, 0.02, 0);
      add(pole, new Mesh(new CylinderGeometry(0.045, 0.045, 0.006, 12), poleGrip), 0, -1.05, 0);
      add(pole, new Mesh(new SphereGeometry(0.03, 8, 6), glove), 0, 0.05, 0);
      pole.position.set(side * 0.3, 0.98, -0.2);
      this.root.add(pole);
      this.poles.push(pole);
    }
  }

  /** In first person the camera sits in the head: hide the body, keep skis and poles. */
  setFirstPerson(firstPerson: boolean): void {
    this.figure.visible = !firstPerson;
  }

  apply(stance: Stance): void {
    const place = (rig: SkiRig, pose: SkiPose) => {
      // Rolling about the centreline would sink one edge into the snow; rest it on top.
      const edgeLift = Math.abs(Math.sin(pose.roll)) * 0.06;
      rig.group.position.set(pose.x, pose.lift + edgeLift, pose.z);
      rig.group.rotation.set(0, pose.yaw, pose.roll, 'YXZ');
    };
    place(this.skis.left, stance.left);
    place(this.skis.right, stance.right);

    // Crouch: hips drop, upper body folds forward; the whole body leans into turns.
    const c = stance.crouch;
    this.upper.position.set(0, 0.9 - 0.4 * c, 0.12 * c);
    this.upper.rotation.x = -0.15 - 0.9 * c;
    for (const leg of this.legs) {
      leg.scale.y = 1 - 0.45 * c;
      leg.position.y = 0.62 - 0.2 * c;
      leg.rotation.x = 0.35 * c;
    }
    this.figure.rotation.z = stance.lean;

    // Hands come in and down in a tuck; poles sweep back under the arms.
    const leanX = Math.sin(stance.lean) * 0.9;
    this.poles.forEach((pole, i) => {
      const side = i === 0 ? -1 : 1;
      pole.position.set(side * (0.3 - 0.12 * c) - leanX, 0.98 - 0.35 * c, -0.2 - 0.15 * c);
      pole.rotation.set(-stance.poleSweep, 0, side * 0.12 + stance.lean * 0.6);
    });
  }
}
