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

import { createDroneController } from './drone-model';
import { boardDimensions, createBinding, createBoardGeometry } from './board-model';
import { DEFAULT_BOARD_SETUP, type BoardSetup } from './discipline';
import { headGeometries } from './skier-head';
import { DEFAULT_SETUP, type SkiDimensions, type SkiSetup, skiDimensions } from './ski-setup';
import type { SkiPose, Stance } from './ski-stance';

type RGB = [number, number, number];

/** Default: a 178 cm all-mountain ski, ~122/88/113 mm. Skier-local -z = forward. */
const DEFAULT_DIMENSIONS = skiDimensions(DEFAULT_SETUP);
const STATIONS = 64;

const TOPSHEET: RGB = [0.05, 0.12, 0.32];
const ACCENT: RGB = [0.95, 0.42, 0.08];
/** Tip and tail: the accent orange, so the ends stand out against the snow. */
const TIP: RGB = [0.95, 0.42, 0.08];
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
  /** The boot's cuff, hinged at the ankle, swung to follow the shin. */
  cuff: Group;
  /** The snowboard binding under this boot (hidden unless riding a board). */
  binding: Group;
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
  private readonly head = new Group();
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
  /** Snowboard discipline: a board + sideways stance instead of two skis and poles. */
  private snowboard = false;
  private boardRegular = true;
  /** Front / back binding splay (deg). */
  private boardAngles: [number, number] = [15, -6];
  private boardSetup: BoardSetup = DEFAULT_BOARD_SETUP;
  private readonly board = new Group();
  private boardDeck!: Mesh;
  private boardGeometry!: BufferGeometry;
  /** The gloved fists on the pole grips (hidden while the hands hold the controller). */
  private readonly fists: Mesh[] = [];
  private readonly controller = createDroneController();
  private flyingDrone = false;
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
        parent: Group = group,
      ) => {
        const mesh = new Mesh(geometry, material);
        mesh.position.set(x, y, z).sub(parent === group ? ORIGIN : CUFF_PIVOT);
        parent.add(mesh);
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
      // The cuff (with its strap and buckles) pivots on the ankle rivets, like a real boot.
      const cuffGroup = new Group();
      cuffGroup.position.copy(CUFF_PIVOT);
      group.add(cuffGroup);
      add(upperCuff, cuff, 0, bootBase, 0, cuffGroup);
      add(strapGeometry, binding, 0, bootBase, 0, cuffGroup);
      for (const [y, z, tilt] of BOOT_BUCKLES) {
        const onCuff = y > 0.18;
        const b = add(
          buckleGeometry,
          buckle,
          side * 0.058,
          bootBase + y,
          z,
          onCuff ? cuffGroup : group,
        );
        b.rotation.x = tilt;
      }
      for (const p of parts) p.castShadow = true;
      // Snowboard binding under the boot (hidden unless riding a board). Faces +toe for a
      // regular rider (toe edge at +x); flipped for goofy by `setBoardStance`.
      const bindingGroup = createBinding(UNDERFOOT + 0.009, binding, bindingMetal, cuff, 1);
      bindingGroup.visible = false;
      group.add(bindingGroup);
      group.position.x = side * 0.11;
      group.name = side === -1 ? 'ski-left' : 'ski-right';
      this.root.add(group);
      return { group, ski, cuff: cuffGroup, binding: bindingGroup };
    };
    this.skis = { left: makeSki(-1), right: makeSki(1) };

    // Snowboard deck: a proper vertex-coloured board (sidecut, camber, turned-up nose and
    // tail, steel edges), nose at -z. One draw call. Hidden until the board discipline is on.
    // The deck sits on the snow; the bindings and boots stack on top.
    this.boardGeometry = createBoardGeometry(boardDimensions(DEFAULT_BOARD_SETUP), 0);
    const deckMat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.28 });
    this.boardDeck = new Mesh(this.boardGeometry, deckMat);
    this.boardDeck.castShadow = true;
    // A stomp pad between the bindings (where the back foot rests off a lift).
    const pad = new Mesh(new BoxGeometry(0.09, 0.01, 0.1), mat(0x25282c, 0.95));
    pad.position.set(0, UNDERFOOT + 0.012, 0);
    this.board.name = 'snowboard';
    this.board.add(this.boardDeck, pad);
    this.board.visible = false;
    this.root.add(this.board);

    this.buildFigure(mat, poleShaft, poleGrip, glove);
  }

  private buildFigure(
    mat: (color: number, roughness: number, metalness?: number) => MeshStandardNodeMaterial,
    poleShaft: MeshStandardNodeMaterial,
    poleGrip: MeshStandardNodeMaterial,
    glove: MeshStandardNodeMaterial,
  ): void {
    const jacket = mat(JACKET, 0.65); // deep teal shell, or a player's colour
    this.jacket = jacket;
    const jacketDark = mat(0x16191d, 0.7);
    const accent = mat(0xff7a1a, 0.5);
    const pants = mat(0x25282c, 0.85);
    const helmet = mat(0x23272c, 0.5);
    const gaiter = mat(0x495057, 0.95);
    const frame = mat(0x101113, 0.4);
    const lens = new MeshStandardNodeMaterial({
      vertexColors: true,
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

    // Head: helmet (peak, vents, ear pads), goggles with the strap in the jacket's colour,
    // and a neck gaiter up to the goggles.
    const head = this.head;
    head.position.set(0, 0.67, -0.01);
    const parts = headGeometries();
    helmet.side = DoubleSide; // the peak is a single sheet, the shell open underneath
    frame.side = DoubleSide;
    for (const [geometry, material] of [
      [parts.gaiter, gaiter],
      [parts.helmet, helmet],
      [parts.frame, frame],
      [parts.lens, lens],
      [parts.strap, jacket],
    ] as const)
      put(head, new Mesh(geometry, material));
    this.chest.add(head);
    this.controller.root.visible = false;
    this.chest.add(this.controller.root);
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
    this.head.name = 'head';
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
      // The fist, knuckles, thumb and gauntlet (the glove), let go to fly the drone.
      for (const m of pole.children) if ((m as Mesh).material === glove) this.fists.push(m as Mesh);
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

  /**
   * Switch between skis and a snowboard. On a board: the skis and poles are hidden, the deck
   * shows, and `apply()` poses the rider sideways (see `applyBoard`).
   */
  setSnowboard(on: boolean, regular = this.boardRegular): void {
    this.snowboard = on;
    this.boardRegular = regular;
  }

  get isSnowboard(): boolean {
    return this.snowboard;
  }

  /** Board geometry and stance follow the setup (deck rebuilt, bindings re-oriented). */
  setBoardSetup(setup: BoardSetup): void {
    this.boardSetup = setup;
    this.boardRegular = setup.stance === 'regular';
    this.boardAngles = [setup.angleFront, setup.angleBack];
    const geometry = createBoardGeometry(boardDimensions(setup), 0);
    this.boardDeck.geometry = geometry;
    this.boardGeometry.dispose();
    this.boardGeometry = geometry;
    // The highback sits behind the heel: toe edge at +x for a regular rider, -x for goofy.
    const toe = this.boardRegular ? 1 : -1;
    for (const rig of [this.skis.left, this.skis.right]) rig.binding.scale.x = toe;
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

  /**
   * Flying the drone (out of body): both hands on its controller in front of the stomach,
   * head bowed to the screen, poles planted upright in the snow either side.
   */
  setFlyingDrone(on: boolean): void {
    if (on === this.flyingDrone) return;
    this.flyingDrone = on;
    this.controller.root.visible = on;
    for (const f of this.fists) f.visible = !on;
    // A frozen body isn't updated: settle it from its last pose into standing still.
    const last = this.lastStance;
    if (on && last) {
      this.apply(
        { ...last, crouch: Math.min(last.crouch, 0.15), foreAft: 0, twist: 0, armReach: 0 },
        this.lastUp,
      );
    }
  }

  get isFlyingDrone(): boolean {
    return this.flyingDrone;
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

  private jacket!: MeshStandardNodeMaterial;

  /** Jacket colour (CSS colour; null = the default teal). Multiplayer: the player's colour. */
  setJacket(colour: string | null): void {
    this.jacket.color.set(colour ?? JACKET);
  }

  /** Hand and pole-tip heights above the snow (skier frame) after the last `apply`. */
  readonly clearance = { hands: [0, 0], tips: [0, 0] };

  /** `up`: the direction the body balances along, in the skier's (slope-aligned) frame. */
  apply(stance: Stance, up: Vector3 = Y_AXIS): void {
    this.lastStance = stance;
    this.lastUp.copy(up);
    // On a board: ride sideways (riding), or seated on a lift with the board hung off the
    // lead foot. Frozen flying the drone falls back to the standing drone pose.
    const onBoard = this.snowboard && !stance.sit && !this.flyingDrone;
    const boardSeated = this.snowboard && !!stance.sit && !this.flyingDrone;
    const leadRig = this.boardRegular ? this.skis.left : this.skis.right;
    const backRig = this.boardRegular ? this.skis.right : this.skis.left;
    this.board.visible = onBoard || boardSeated;
    leadRig.binding.visible = onBoard || boardSeated; // the lead foot stays strapped on a lift
    backRig.binding.visible = onBoard; // the back foot is out of its binding seated
    for (const p of this.skiParts) p.visible = !this.snowboard && !this.stowed;
    for (const p of this.poles) p.visible = !this.snowboard && !this.stowed;
    if (onBoard) {
      this.applyBoard(stance, up);
      return;
    }
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
    // Seated: leaning back a touch. Flying the drone: a little over the controller.
    const bend =
      (0.12 + 0.85 * c + 0.25 * f - 0.2 * back) * (1 - sit) -
      0.06 * sit +
      (this.flyingDrone ? 0.1 : 0);
    this.head.rotation.x = this.flyingDrone ? -0.5 : 0; // watching the screen
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
      // The cuff follows the shin's forward / back lean in the ski's frame (it's stiff
      // sideways, so it only hinges fore and aft), within the boot's range of flex.
      const rig = i === 0 ? this.skis.left : this.skis.right;
      const shin = knee
        .clone()
        .applyMatrix4(inverse.copy(rig.group.matrix).invert())
        .sub(CUFF_PIVOT);
      const lean = Math.atan2(-shin.z, shin.y);
      rig.cuff.rotation.x = -Math.min(Math.max(lean - CUFF_LEAN, -0.25), 0.55);
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
      const drone = this.flyingDrone;
      const hand = drone
        ? this.controller.grips[i]!.clone().applyMatrix4(this.chest.matrix)
        : stance.grip
          ? new Vector3(side * stance.grip.x, stance.grip.y, stance.grip.z)
          : handLocal.applyMatrix4(this.chest.matrix);
      // Leaning into a carve, the inside hand would go into the snow: like a real skier,
      // bring it up and forward over the snow, and never let a hand below HAND_CLEARANCE.
      const held = drone || !!stance.grip;
      const inside = held ? 0 : smoothstep(0.12, 0.5, side * up.x) * (1 - sit);
      if (!held) {
        hand.y += 0.22 * inside;
        hand.z -= 0.18 * inside;
        hand.y = Math.max(hand.y, HAND_CLEARANCE * (1 - sit));
      }
      const elbow = solveJoint(shoulder, hand, UPPER_ARM, FOREARM, new Vector3(side, -0.3, 0.6));
      stretch(limb.upperArm, shoulder, elbow);
      const wrist = elbow.clone().lerp(hand, 0.85);
      stretch(limb.forearm, elbow, wrist);
      stretch(limb.cuff, wrist, hand);
      limb.elbow.position.copy(elbow);

      const pole = this.poles[i]!;
      if (drone) {
        // Planted upright beside the boots, tips a little into the snow.
        pole.position.set(side * 0.42 + feet.x, POLE_TIP - 0.08, feet.z - 0.08);
        pole.rotation.set(0, 0, side * 0.06);
        this.clearance.hands[i] = hand.y;
        this.clearance.tips[i] = -0.08;
        return;
      }
      pole.position.copy(hand);
      // The inside pole swings out to the side; then either pole is swept back until its
      // tip clears the snow (it trails, lightly off it, rather than spearing in).
      const roll = side * (0.12 + 0.35 * inside) + stance.lean * 0.6;
      let sweep = stance.poleSweep;
      const tip = new Vector3();
      for (let k = 0; k < 30; k++) {
        pole.rotation.set(-sweep, 0, roll);
        tip.set(0, -POLE_TIP, 0).applyEuler(pole.rotation).add(hand);
        if (tip.y >= TIP_CLEARANCE || stance.grip) break;
        sweep += 0.05;
      }
      this.clearance.hands[i] = hand.y;
      this.clearance.tips[i] = tip.y;
    });
    if (boardSeated) this.hangBoard(leadRig);
  }

  /**
   * Riding a lift on a board: the skier sits in the normal seated body pose and the board
   * hangs straight down off the strapped-in lead foot (the back foot is free). Placed under
   * the lead boot and swung to dangle nose-down.
   */
  private hangBoard(leadRig: SkiRig): void {
    leadRig.group.updateMatrix();
    const foot = new Vector3(0, BOOT_SOLE, 0.02).applyMatrix4(leadRig.group.matrix);
    const nose = this.boardRegular ? -1 : 1;
    const length = this.boardSetup.length / 100;
    const leadZ = nose * Math.min(0.3, length * 0.165); // the lead binding's place on the deck
    // Dangle nose-down and a touch forward, swinging the deck's lead binding onto the foot
    // (which is still strapped into it) so the board hangs off the front boot, not mid-deck.
    const rot = new Quaternion().setFromAxisAngle(X_AXIS, -1.4);
    this.board.quaternion.copy(rot);
    this.board.position.copy(foot).sub(new Vector3(0, UNDERFOOT, leadZ).applyQuaternion(rot));
  }

  /**
   * Snowboard pose. The hard part of a boarder is that three directions come apart which are
   * one and the same on skis: the **board** points along travel (nose at -z, set by the root
   * yaw), the **body** stands ~90° across it (opened toward the nose by the binding angles and
   * leading into the turn), and the **gaze** looks back down the travel line. This method ties
   * them together:
   *
   * - the deck and both boots roll onto the heel/toe edge by the balance line's cross-tilt
   *   (`up`), so the board carves on an edge and the feet tip with it;
   * - the torso faces across the board, rotated toward the nose by the mean binding splay and
   *   further into the turn as the edge bites (anticipation / counter-rotation);
   * - the head turns off the shoulders back toward the direction of travel, so the rider looks
   *   where they're going, not out across the slope;
   * - sitting back (`foreAft < 0`) loads and lifts the tail — the ollie press.
   *
   * No poles; the arms balance, the lead arm reaching over the nose.
   */
  private applyBoard(stance: Stance, up: Vector3): void {
    const regular = this.boardRegular;
    const d2r = Math.PI / 180;
    const [fa, ba] = this.boardAngles;
    const nose = regular ? -1 : 1; // z-sign of the nose
    const toe = regular ? 1 : -1; // x-sign of the toe edge
    const length = this.boardSetup.length / 100;
    const half = Math.min(0.3, length * 0.165); // half the stance width along the deck (m)

    // Cross-lean onto the heel/toe edge, from the balance line in the board's frame.
    const edge = Math.max(-BOARD_MAX_EDGE, Math.min(BOARD_MAX_EDGE, Math.atan2(up.x, up.y)));
    const boardHalfWidth = this.boardSetup.waist / 2000 + 0.03;
    const lift = boardHalfWidth * Math.abs(Math.sin(edge)); // the low edge rests on the snow
    // Load the tail for an ollie: sitting back tips the nose up.
    const noseTilt = -nose * BOARD_OLLIE_TILT * Math.max(0, -stance.foreAft);

    // Deck: roll onto the edge (about the long axis), then kick the nose.
    this.board.quaternion
      .setFromAxisAngle(Z_AXIS, edge)
      .multiply(new Quaternion().setFromAxisAngle(X_AXIS, noseTilt));
    this.board.position.set(0, lift, 0);

    // Boots: at ±half along the board, splayed to the binding angles, tipped with the edge.
    // The lead foot (front binding `fa`) is toward the nose; the back foot (`ba`) toward the tail.
    const leadZ = nose * half;
    const backZ = -nose * half;
    const qEdge = new Quaternion().setFromAxisAngle(Z_AXIS, edge);
    const bindings: { rig: SkiRig; z: number; splay: number }[] = regular
      ? [
          { rig: this.skis.left, z: leadZ, splay: fa },
          { rig: this.skis.right, z: backZ, splay: ba },
        ]
      : [
          { rig: this.skis.right, z: leadZ, splay: fa },
          { rig: this.skis.left, z: backZ, splay: ba },
        ];
    for (const b of bindings) {
      // Boots point across the board, angled toward the nose by their binding splay.
      const yaw = -toe * (Math.PI / 2) + toe * b.splay * d2r;
      b.rig.group.quaternion.copy(qEdge).multiply(new Quaternion().setFromAxisAngle(Y_AXIS, yaw));
      b.rig.group.position.set(0, lift, b.z);
      b.rig.group.updateMatrix();
      b.rig.cuff.rotation.x = -0.22; // soft boots lean the shin well forward
    }
    const ankles = [this.skis.left, this.skis.right].map((rig) =>
      new Vector3(0, ANKLE_HEIGHT, 0.03).applyMatrix4(rig.group.matrix),
    );
    const feet = ankles[0]!.clone().add(ankles[1]!).multiplyScalar(0.5);

    const c = stance.crouch;
    // The torso: sideways across the board, opened toward the nose by the mean binding splay,
    // and leading further into the turn as the edge bites (counter-rotation).
    const open = ((fa + ba) / 2) * d2r;
    const anticip = BOARD_ANTICIP * edge;
    const bodyYaw = -toe * (Math.PI / 2) + toe * open + anticip;
    // Stand along the balance line, turn across the board, bend fore/aft.
    const align = new Quaternion()
      .setFromUnitVectors(Y_AXIS, up)
      .multiply(new Quaternion().setFromAxisAngle(Y_AXIS, bodyYaw))
      .multiply(new Quaternion().setFromAxisAngle(X_AXIS, -0.12 * stance.foreAft));
    const hipHeight = (THIGH + SHIN) * (0.9 - 0.42 * c);
    const pelvis = new Vector3(0, hipHeight, 0).applyQuaternion(align).add(feet);

    this.chest.position.copy(pelvis);
    this.chest.quaternion
      .copy(align)
      .multiply(new Quaternion().setFromEuler(new Euler(-(0.12 + 0.55 * c), 0, 0, 'YXZ')));
    this.chest.updateMatrix();
    // The gaze turns off the shoulders, back toward the direction of travel.
    this.head.rotation.set(0.05, -bodyYaw * BOARD_GAZE, 0, 'YXZ');

    this.limbs.forEach((limb, i) => {
      const side = i === 0 ? -1 : 1;
      // Hips spread nose-to-tail (the across-body x maps onto the deck's z through bodyYaw).
      const hip = new Vector3(side * 0.1, -0.03, 0).applyQuaternion(align).add(pelvis);
      const ankle = side < 0 ? ankles[0]! : ankles[1]!;
      const kneeHint = new Vector3(toe, 0.35, 0).applyQuaternion(align);
      const knee = solveJoint(hip, ankle, THIGH, SHIN, kneeHint);
      stretch(limb.thigh, hip, knee);
      stretch(limb.shin, knee, ankle);
      limb.knee.position.copy(knee);

      // Arms balance (no poles): the nose-side arm reaches forward over the nose, the other
      // trails back; both drop a little as the edge angle grows (reaching for the snow).
      const shoulder = new Vector3(side * 0.2, 0.44, 0).applyMatrix4(this.chest.matrix);
      const lead = i === 0 ? 1 : -1; // the left arm leads for a regular rider
      const reach = (regular ? lead : -lead) * (0.22 + 0.12 * c);
      const handLocal = new Vector3(
        side * (0.32 - 0.08 * c),
        -0.02 - 0.12 * c - 0.12 * Math.abs(edge) + 0.14 * stance.armReach,
        reach,
      );
      const hand = handLocal.applyMatrix4(this.chest.matrix);
      const elbow = solveJoint(shoulder, hand, UPPER_ARM, FOREARM, new Vector3(side, -0.4, 0.3));
      stretch(limb.upperArm, shoulder, elbow);
      const wrist = elbow.clone().lerp(hand, 0.85);
      stretch(limb.forearm, elbow, wrist);
      stretch(limb.cuff, wrist, hand);
      limb.elbow.position.copy(elbow);
      this.clearance.hands[i] = hand.y;
      this.clearance.tips[i] = 1;
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
/** The default jacket: deep teal. */
const JACKET = 0x0b7285;
const ANKLE_HEIGHT = 0.2; // ankle joint above the base of the ski, inside the boot
/** Lowest a gloved hand goes above the snow, and a pole tip (m); pole grip to tip. */
const HAND_CLEARANCE = 0.42;
const TIP_CLEARANCE = 0.06;
const POLE_TIP = 1.15;
/** The cuff's hinge (the ankle rivets), in the ski's frame; the cuff's built-in lean. */
const CUFF_PIVOT = new Vector3(0, ANKLE_HEIGHT, 0.03);
const CUFF_LEAN = 0.18;
const ORIGIN = new Vector3();
const inverse = new Matrix4();
const THIGH = 0.43;
const SHIN = 0.42;
const UPPER_ARM = 0.3;
const FOREARM = 0.28;
const KNEE_HINT = new Vector3(0, 0.2, -1);
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);
const Z_AXIS = new Vector3(0, 0, 1);
/** Snowboard pose tuning. */
const BOARD_MAX_EDGE = (58 * Math.PI) / 180;
/** How far the torso leads into the turn per radian of edge (counter-rotation). */
const BOARD_ANTICIP = 0.45;
/** How much the head turns off the shoulders back toward travel (0 = sideways, 1 = straight). */
const BOARD_GAZE = 0.7;
/** Nose-up tilt (rad) at a full tail-load ollie press. */
const BOARD_OLLIE_TILT = 0.3;

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
