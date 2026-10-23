import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';

import { DEFAULT_SETUP, type SkiDimensions, type SkiSetup, skiDimensions } from './ski-setup';
import type { SkiPose, Stance } from './ski-stance';

type RGB = [number, number, number];

/** Default: a 178 cm all-mountain ski, ~122/88/113 mm. Skier-local -z = forward. */
const DEFAULT_DIMENSIONS = skiDimensions(DEFAULT_SETUP);
const STATIONS = 64;

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
export function skiProfile(
  t: number,
  d: SkiDimensions = DEFAULT_DIMENSIONS,
): { halfWidth: number; rise: number; thickness: number } {
  // Sidecut: a smooth curve through tail contact, waist and shovel...
  const waistT = 0.48;
  const w =
    t < waistT
      ? d.waistWidth + (d.tailWidth - d.waistWidth) * ((waistT - t) / waistT) ** 2
      : d.waistWidth + (d.tipWidth - d.waistWidth) * ((t - waistT) / (0.86 - waistT)) ** 2;
  // ...rounded off at the very tip and tail.
  const tipRound = t > 0.86 ? Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2)) : 1;
  const tailRound = t < 0.04 ? Math.sqrt(Math.max(0, 1 - ((0.04 - t) / 0.04) ** 2)) : 1;
  const width =
    Math.min(w, t > 0.86 ? d.tipWidth : Infinity) * (0.35 + 0.65 * tipRound * tailRound);
  // Rocker: the shovel curves up from the rocker line (further back on rockered skis);
  // a tail kick, bigger on twin tips.
  const rise =
    d.tipRise * smoothstep(d.rockerStart, 1, t) ** 1.6 + d.tailRise * smoothstep(0.07, 0, t) ** 1.6;
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
export function createSkiGeometry(d: SkiDimensions = DEFAULT_DIMENSIONS): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const n = STATIONS;

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

  const z = (t: number) => d.tail - t * d.length;
  const at = (t: number, side: -1 | 1, top: boolean): [number, number, number] => {
    const p = skiProfile(t, d);
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

const UNDERFOOT = skiProfile(DEFAULT_DIMENSIONS.tail / DEFAULT_DIMENSIONS.length).thickness;

interface SkiRig {
  group: Group;
  ski: Mesh;
}

/**
 * Skier model: skis with bindings and boots (always visible, including in first person
 * when you look down), poles, and a body shown in the chase camera.
 */
export class SkierModel {
  readonly root = new Group();
  private opacity = 1;
  private readonly figure = new Group();
  private readonly chest = new Group();
  private readonly poles: Group[] = [];
  private readonly limbs: {
    thigh: Mesh;
    shin: Mesh;
    knee: Mesh;
    upperArm: Mesh;
    forearm: Mesh;
    elbow: Mesh;
    cuff: Mesh;
  }[] = [];
  private readonly skis: { left: SkiRig; right: SkiRig };
  private skiGeometry = createSkiGeometry();
  /** Skis and bindings without the boots (stowed in a cabin's rack). */
  private readonly skiParts: Mesh[] = [];
  private stowed = false;
  /** The stance and balance line last applied (what a remote copy needs to match it). */
  lastStance: Stance | null = null;
  readonly lastUp = new Vector3(0, 1, 0);

  constructor() {
    const mat = (color: number, roughness: number, metalness = 0) =>
      new MeshStandardNodeMaterial({ color, roughness, metalness });
    const skiMat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.3 });
    const binding = mat(0x2b2d31, 0.45, 0.3);
    const bindingMetal = mat(0xb8bcc2, 0.35, 0.8);
    const shell = mat(0x30353b, 0.35, 0.1);
    const cuff = mat(0xe8590c, 0.45);
    const buckle = mat(0xced4da, 0.3, 0.8);
    const glove = mat(0x353a40, 0.85);
    const poleShaft = mat(0xadb5bd, 0.3, 0.8);
    const poleGrip = mat(0x212529, 0.8);

    const plate = new BoxGeometry(0.072, 0.014, 0.42);
    const toe = new BoxGeometry(0.068, 0.045, 0.085);
    const heel = new BoxGeometry(0.07, 0.06, 0.11);
    const brake = new BoxGeometry(0.115, 0.008, 0.012);
    const sole = bootPiece(BOOT_SOLE_PROFILE, 0.1, 0.004);
    const lower = bootPiece(BOOT_SHELL_PROFILE, 0.104, 0.012);
    const upperCuff = bootPiece(BOOT_CUFF_PROFILE, 0.112, 0.012);
    const strapGeometry = bootPiece(BOOT_STRAP_PROFILE, 0.118, 0.004);
    const buckleGeometry = new BoxGeometry(0.03, 0.012, 0.04);

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
      const ski = add(this.skiGeometry, skiMat, 0, 0, 0);
      const top = UNDERFOOT;
      add(plate, binding, 0, top + 0.007, 0);
      add(toe, binding, 0, top + 0.035, -0.2);
      add(heel, binding, 0, top + 0.042, 0.19);
      add(brake, bindingMetal, 0, top + 0.02, 0.13);
      this.skiParts.push(...parts);
      // Boot (side profiles extruded across, edges rounded): a rubber sole with toe and
      // heel lugs, the shell round the foot, a forward-leaning cuff with a power strap,
      // and buckles on the outside of the instep and cuff.
      const bootBase = BOOT_SOLE;
      add(sole, binding, 0, bootBase, 0);
      add(lower, shell, 0, bootBase, 0);
      add(upperCuff, cuff, 0, bootBase, 0);
      add(strapGeometry, binding, 0, bootBase, 0);
      for (const [y, z, tilt] of BOOT_BUCKLES) {
        const b = add(buckleGeometry, buckle, side * 0.058, bootBase + y, z);
        b.rotation.x = tilt;
      }
      for (const p of parts) p.castShadow = true;
      group.position.x = side * 0.11;
      group.name = side === -1 ? 'ski-left' : 'ski-right';
      this.root.add(group);
      return { group, ski };
    };
    this.skis = { left: makeSki(-1), right: makeSki(1) };

    this.buildFigure(mat, poleShaft, poleGrip, glove);
  }

  private buildFigure(
    mat: (color: number, roughness: number, metalness?: number) => MeshStandardNodeMaterial,
    poleShaft: MeshStandardNodeMaterial,
    poleGrip: MeshStandardNodeMaterial,
    glove: MeshStandardNodeMaterial,
  ): void {
    const jacket = mat(0x0b7285, 0.65); // deep teal shell
    const jacketDark = mat(0x16191d, 0.7);
    const accent = mat(0xff7a1a, 0.5);
    const pants = mat(0x25282c, 0.85);
    const helmet = mat(0x1a1c1f, 0.55);
    const gaiter = mat(0x495057, 0.95);
    const frame = mat(0x101113, 0.4);
    const lens = new MeshStandardNodeMaterial({
      color: 0xff8a2a,
      emissive: 0x4a1800,
      metalness: 0.7,
      roughness: 0.12,
    });
    const shade = (m: Mesh) => {
      m.castShadow = true;
      return m;
    };
    const put = (parent: Group, m: Mesh, x = 0, y = 0, z = 0) => {
      m.position.set(x, y, z);
      parent.add(shade(m));
      return m;
    };

    // Torso (chest group pivots at the pelvis).
    put(this.chest, new Mesh(new SphereGeometry(0.17, 16, 12), pants), 0, 0.02, 0.01).scale.set(
      1,
      0.75,
      0.8,
    );
    const torso = put(
      this.chest,
      new Mesh(new CapsuleGeometry(0.15, 0.28, 6, 16), jacket),
      0,
      0.28,
      0,
    );
    torso.scale.set(1.25, 1, 0.82);
    const yoke = put(
      this.chest,
      new Mesh(new CapsuleGeometry(0.075, 0.3, 4, 12), jacketDark),
      0,
      0.44,
      0.01,
    );
    yoke.rotation.z = Math.PI / 2;
    put(this.chest, new Mesh(new BoxGeometry(0.014, 0.34, 0.012), jacketDark), 0, 0.27, -0.126);
    put(this.chest, new Mesh(new BoxGeometry(0.05, 0.022, 0.01), accent), 0.07, 0.37, -0.118);
    put(this.chest, new Mesh(new CylinderGeometry(0.075, 0.095, 0.09, 16), jacket), 0, 0.53, 0);

    // Head: neck gaiter, helmet, goggle strap and a wraparound mirrored lens.
    const head = new Group();
    head.position.set(0, 0.67, -0.01);
    put(head, new Mesh(new SphereGeometry(0.098, 16, 12), gaiter)).scale.set(1, 1.08, 1);
    const shell = put(
      head,
      new Mesh(new SphereGeometry(0.124, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.56), helmet),
      0,
      0.022,
      0.006,
    );
    shell.scale.set(1, 0.95, 1.1);
    const strap = put(
      head,
      new Mesh(new TorusGeometry(0.121, 0.013, 6, 32), accent),
      0,
      0.01,
      0.01,
    );
    strap.rotation.x = Math.PI / 2;
    // Cylinder angle 0 points along +z; centre the arc on the face (-z).
    const arc = (r: number, h: number, span: number, material: MeshStandardNodeMaterial) =>
      new Mesh(new CylinderGeometry(r, r, h, 24, 1, true, Math.PI - span / 2, span), material);
    frame.side = DoubleSide;
    lens.side = DoubleSide;
    put(head, arc(0.127, 0.066, 2.3, frame), 0, 0.012, 0.004);
    put(head, arc(0.131, 0.05, 2.0, lens), 0, 0.012, 0.004);
    this.chest.add(head);
    this.figure.add(this.chest);

    // Limbs: unit cylinders stretched between joints each frame.
    const limb = (r1: number, r2: number, material: MeshStandardNodeMaterial) => {
      const m = shade(new Mesh(new CylinderGeometry(r2, r1, 1, 12), material));
      this.figure.add(m);
      return m;
    };
    const joint = (r: number, material: MeshStandardNodeMaterial) => {
      const m = shade(new Mesh(new SphereGeometry(r, 12, 8), material));
      this.figure.add(m);
      return m;
    };
    for (let i = 0; i < 2; i++) {
      this.limbs.push({
        thigh: limb(0.088, 0.074, pants),
        shin: limb(0.074, 0.078, pants), // flares over the boot
        knee: joint(0.078, pants),
        upperArm: limb(0.062, 0.055, jacket),
        forearm: limb(0.055, 0.05, jacket),
        elbow: joint(0.058, jacket),
        cuff: limb(0.052, 0.052, jacketDark),
      });
    }
    this.figure.name = 'body';
    this.chest.name = 'chest';
    this.root.add(this.figure);

    // Poles hang from the hands (gloves on the grips); their pivot is the grip.
    for (let i = 0; i < 2; i++) {
      const pole = new Group();
      put(pole, new Mesh(new CylinderGeometry(0.009, 0.006, 1.15, 6), poleShaft), 0, -0.575, 0);
      put(pole, new Mesh(poleGripGeometry(), poleGrip), 0, 0, 0);
      put(pole, new Mesh(new CylinderGeometry(0.045, 0.045, 0.006, 12), poleGrip), 0, -1.05, 0);
      // Wrist strap: a loop from the top of the grip, round the back of the glove.
      const strap = put(pole, new Mesh(new TorusGeometry(0.04, 0.006, 4, 16, Math.PI), poleGrip));
      strap.position.set(0, 0.07, 0.03);
      strap.rotation.set(0, Math.PI / 2, -Math.PI / 2);
      // Gloved fist round the grip: palm and fingers, thumb over the top, cuff to the wrist.
      const fist = put(pole, new Mesh(new SphereGeometry(1, 14, 10), glove), 0, 0.03, -0.006);
      fist.scale.set(0.036, 0.052, 0.04);
      for (let k = 0; k < 4; k++) {
        // Knuckle ridges across the front of the fingers.
        const knuckle = put(pole, new Mesh(new SphereGeometry(0.0125, 8, 6), glove));
        knuckle.position.set(0, 0.06 - k * 0.02, -0.034);
      }
      const thumb = put(pole, new Mesh(new CapsuleGeometry(0.013, 0.03, 4, 8), glove));
      thumb.position.set(0, 0.078, -0.012);
      thumb.rotation.x = -1.1;
      const gauntlet = put(pole, new Mesh(new CylinderGeometry(0.04, 0.034, 0.08, 12), glove));
      gauntlet.position.set(0, 0.07, 0.05);
      gauntlet.rotation.x = 0.95;
      this.root.add(pole);
      this.poles.push(pole);
    }
  }

  /** Whole character's opacity (1 = solid). Used to show a "ghost" skier while flying. */
  setOpacity(opacity: number): void {
    if (opacity === this.opacity) return;
    this.opacity = opacity;
    const seen = new Set<MeshStandardNodeMaterial>();
    this.root.traverse((o) => {
      const material = (o as Mesh).material as MeshStandardNodeMaterial | undefined;
      if (!material || seen.has(material)) return;
      seen.add(material);
      material.transparent = opacity < 1;
      material.opacity = opacity;
      material.needsUpdate = true;
    });
    this.root.traverse((o) => {
      if ((o as Mesh).isMesh) o.castShadow = opacity >= 1;
    });
  }

  /** Reshape the skis (length, widths, rocker, mount) to match a setup. */
  setSkiSetup(setup: SkiSetup): void {
    const geometry = createSkiGeometry(skiDimensions(setup));
    this.skis.left.ski.geometry = geometry;
    this.skis.right.ski.geometry = geometry;
    this.skiGeometry.dispose();
    this.skiGeometry = geometry;
  }

  /** Skis, bindings and boots. */
  setSkisVisible(visible: boolean): void {
    this.skis.left.group.visible = visible;
    this.skis.right.group.visible = visible;
  }

  /** Skis and poles stowed (riding inside a cabin): just the boots stay on. */
  get isStowed(): boolean {
    return this.stowed;
  }

  setStowed(stowed: boolean): void {
    this.stowed = stowed;
    for (const p of this.skiParts) p.visible = !stowed;
    for (const p of this.poles) p.visible = !stowed;
  }

  /** World position of a ski's centre on the snow. Call after the root's matrices update. */
  skiPosition(side: 'left' | 'right', out: Vector3): Vector3 {
    return this.skis[side].group.getWorldPosition(out);
  }

  /**
   * In first person the camera sits in the head: hide the body, keep skis and poles.
   * `legs` keeps your legs in view too (seated, where you'd see your knees).
   */
  setFirstPerson(firstPerson: boolean, legs = false): void {
    this.figure.visible = !firstPerson || legs;
    const upper = !firstPerson;
    this.chest.visible = upper;
    for (const limb of this.limbs) {
      for (const m of [limb.upperArm, limb.forearm, limb.elbow, limb.cuff]) m.visible = upper;
    }
  }

  /** `up`: the direction the body balances along, in the skier's (slope-aligned) frame. */
  apply(stance: Stance, up: Vector3 = Y_AXIS): void {
    this.lastStance = stance;
    this.lastUp.copy(up);
    const place = (rig: SkiRig, pose: SkiPose) => {
      // Rolling about the centreline would sink one edge into the snow; rest it on top.
      const edgeLift = Math.abs(Math.sin(pose.roll)) * 0.06;
      rig.group.position.set(pose.x, pose.lift + edgeLift, pose.z);
      rig.group.rotation.set(0, pose.yaw, pose.roll, 'YXZ');
      rig.group.updateMatrix();
    };
    place(this.skis.left, stance.left);
    place(this.skis.right, stance.right);
    if (this.stowed) {
      // Skis off: boot soles down on the floor.
      for (const rig of [this.skis.left, this.skis.right]) {
        rig.group.position.y -= BOOT_SOLE;
        rig.group.updateMatrix();
      }
    }

    // Ankles sit inside the boots, so they follow the skis (plough, skating, edging).
    const ankles = [this.skis.left, this.skis.right].map((rig) =>
      new Vector3(0, ANKLE_HEIGHT, 0.03).applyMatrix4(rig.group.matrix),
    );
    const c = stance.crouch;
    const sit = stance.sit?.amount ?? 0;
    const feet = ankles[0]!.clone().add(ankles[1]!).multiplyScalar(0.5);
    // The body stands along `up` (its balance line, which needn't be the slope normal),
    // dropping and sitting back as you crouch. Leaning forward tips the balance line over
    // the toes and the chest down; leaning back drops the hips behind the heels.
    const f = stance.foreAft * (1 - sit);
    const back = Math.max(0, -f);
    const align = new Quaternion()
      .setFromUnitVectors(Y_AXIS, up)
      .multiply(new Quaternion().setFromAxisAngle(X_AXIS, -0.12 * f));
    const hipHeight = (THIGH + SHIN) * (0.95 - 0.36 * c - 0.08 * back);
    const pelvis = new Vector3(0, hipHeight, 0.04 + 0.16 * c + 0.1 * back)
      .applyQuaternion(align)
      .add(feet);
    if (stance.sit) {
      // Hips on the seat (measured from the floor the boots stand on), sitting up straight.
      const { height, back: seatBack } = stance.sit;
      pelvis.lerp(new Vector3(0, height, seatBack), sit);
    }
    // Seated: leaning back a touch.
    const bend = (0.12 + 0.85 * c + 0.25 * f - 0.2 * back) * (1 - sit) - 0.06 * sit;
    this.chest.position.copy(pelvis);
    this.chest.quaternion
      .copy(align)
      .multiply(new Quaternion().setFromEuler(new Euler(-bend, stance.twist, 0, 'YXZ')));
    this.chest.updateMatrix();

    const pelvisTurn = align
      .clone()
      .multiply(new Quaternion().setFromEuler(new Euler(0, stance.twist * 0.35, 0)));
    this.limbs.forEach((limb, i) => {
      const side = i === 0 ? -1 : 1;
      // Legs: hip to ankle with the knee bending forward.
      const hip = new Vector3(side * 0.095, -0.03, 0).applyQuaternion(pelvisTurn).add(pelvis);
      const knee = solveJoint(hip, ankles[i]!, THIGH, SHIN, KNEE_HINT);
      stretch(limb.thigh, hip, knee);
      stretch(limb.shin, knee, ankles[i]!);
      limb.knee.position.copy(knee);

      // Arms: shoulder to hand, elbows out and back. Hands come in front in a tuck.
      const shoulder = new Vector3(side * 0.2, 0.44, 0).applyMatrix4(this.chest.matrix);
      // armReach swings the hands forward and up (planting) or back past the hips (push).
      const r = stance.armReach;
      const handLocal = new Vector3(
        side * (0.3 - 0.16 * c),
        0.08 + 0.18 * c + 0.22 * Math.max(r, 0),
        -0.3 - 0.12 * c - 0.3 * r,
      ).lerp(new Vector3(side * 0.17, 0.06, -0.3), sit); // seated: hands on the thighs
      const hand = stance.grip
        ? new Vector3(side * stance.grip.x, stance.grip.y, stance.grip.z)
        : handLocal.applyMatrix4(this.chest.matrix);
      const elbow = solveJoint(shoulder, hand, UPPER_ARM, FOREARM, new Vector3(side, -0.3, 0.6));
      stretch(limb.upperArm, shoulder, elbow);
      const wrist = elbow.clone().lerp(hand, 0.85);
      stretch(limb.forearm, elbow, wrist);
      stretch(limb.cuff, wrist, hand);
      limb.elbow.position.copy(elbow);

      const pole = this.poles[i]!;
      pole.position.copy(hand);
      pole.rotation.set(-stance.poleSweep, 0, side * 0.12 + stance.lean * 0.6);
    });
  }
}

/**
 * Boot side profiles as (z, y): z along the ski (-z = toe), y up from the boot's sole.
 * A Mondopoint ~27 shell is ~31 cm long.
 */
const BOOT_SOLE_PROFILE: [number, number][] = [
  [-0.156, 0],
  [0.156, 0],
  [0.156, 0.03],
  [0.12, 0.03],
  [0.118, 0.024],
  [-0.12, 0.024],
  [-0.122, 0.03],
  [-0.156, 0.03],
];
const BOOT_SHELL_PROFILE: [number, number][] = [
  [-0.15, 0.022],
  [0.15, 0.022],
  [0.152, 0.07],
  [0.135, 0.12],
  [0.09, 0.15],
  [0.05, 0.155],
  [-0.03, 0.14],
  [-0.08, 0.11],
  [-0.12, 0.085],
  [-0.148, 0.06],
];
const BOOT_CUFF_PROFILE: [number, number][] = [
  [-0.035, 0.12],
  [0.12, 0.1],
  [0.135, 0.16],
  [0.105, 0.34],
  [-0.06, 0.345],
  [-0.075, 0.25],
];
const BOOT_STRAP_PROFILE: [number, number][] = [
  [-0.062, 0.3],
  [0.112, 0.3],
  [0.106, 0.335],
  [-0.066, 0.337],
];
/** Buckles on the outside: two over the instep, two up the cuff (y, z, tilt). */
const BOOT_BUCKLES: [number, number, number][] = [
  [0.11, -0.085, 0.6],
  [0.14, -0.035, 0.35],
  [0.21, -0.055, -0.15],
  [0.27, -0.065, -0.15],
];

/** A boot part: `profile` extruded `width` across the ski, centred, edges rounded. */
function bootPiece(profile: [number, number][], width: number, round: number): BufferGeometry {
  const shape = new Shape(profile.map(([z, y]) => new Vector2(z, y)));
  const g = new ExtrudeGeometry(shape, {
    depth: width - 2 * round,
    bevelEnabled: round > 0,
    bevelThickness: round,
    bevelSize: round * 0.8,
    bevelSegments: 2,
    curveSegments: 4,
  });
  // Shape (x, y) → skier (z, y); the extrusion runs along -x, so the basis keeps its
  // handedness (faces stay outward). Centred across the ski.
  g.applyMatrix4(
    new Matrix4()
      .makeBasis(new Vector3(0, 0, 1), new Vector3(0, 1, 0), new Vector3(-1, 0, 0))
      .setPosition(width / 2 - round, 0, 0),
  );
  // Smooth across the rounded edges (the bevels make the corners soft, not sharp).
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const smooth = mergeVertices(g, 1e-4);
  smooth.computeVertexNormals();
  return smooth;
}

/** Moulded pole grip: a finger-shaped barrel flaring to a rounded cap at the top. */
function poleGripGeometry(): BufferGeometry {
  const profile = [
    [0, -0.06],
    [0.011, -0.06],
    [0.016, -0.045],
    [0.0175, -0.02],
    [0.016, 0.01],
    [0.0175, 0.04],
    [0.019, 0.07],
    [0.024, 0.08],
    [0.022, 0.09],
    [0.012, 0.097],
    [0, 0.098],
  ].map(([r, y]) => new Vector2(r, y));
  return new LatheGeometry(profile, 14);
}

/** Boot sole above the base of the ski. */
const BOOT_SOLE = UNDERFOOT + 0.026;
const ANKLE_HEIGHT = 0.2; // ankle joint above the base of the ski, inside the boot
const THIGH = 0.43;
const SHIN = 0.42;
const UPPER_ARM = 0.3;
const FOREARM = 0.28;
const KNEE_HINT = new Vector3(0, 0.2, -1);
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

/**
 * Two-bone IK: where the middle joint goes so bones of length a and b join `from` to
 * `to`, bending toward `hint`. Out-of-reach targets straighten the limb.
 */
export function solveJoint(
  from: Vector3,
  to: Vector3,
  a: number,
  b: number,
  hint: Vector3,
): Vector3 {
  const offset = to.clone().sub(from);
  const d = Math.min(Math.max(offset.length(), Math.abs(a - b) + 1e-4), a + b - 1e-4);
  const along = offset.normalize();
  const proj = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(a * a - proj * proj, 0));
  const perp = hint.clone().addScaledVector(along, -hint.dot(along));
  if (perp.lengthSq() < 1e-8) perp.set(0, 0, -1);
  perp.normalize();
  return from.clone().addScaledVector(along, proj).addScaledVector(perp, h);
}

/** Point a unit-height cylinder from one joint to another. */
function stretch(mesh: Mesh, from: Vector3, to: Vector3): void {
  const dir = to.clone().sub(from);
  const length = dir.length();
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.scale.set(1, Math.max(length, 1e-3), 1);
  mesh.quaternion.setFromUnitVectors(Y_AXIS, dir.divideScalar(length || 1));
}
