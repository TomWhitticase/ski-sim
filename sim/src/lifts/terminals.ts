import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Shape,
  Vector3,
} from 'three/webgpu';

import type { Terminal } from '../features/types';

type RGB = [number, number, number];

const CONCRETE: RGB = [0.56, 0.55, 0.53];
const STEEL: RGB = [0.42, 0.45, 0.5];
const ROOF: RGB = [0.62, 0.12, 0.1];
const GLASS: RGB = [0.12, 0.16, 0.22];
/** Station glazing: lighter than a window at night, reflecting the sky. */
const GLAZING: RGB = [0.3, 0.4, 0.5];
const TIMBER: RGB = [0.38, 0.25, 0.15];
const STRIPE: RGB = [0.95, 0.75, 0.1];
const RUBBER: RGB = [0.1, 0.1, 0.11];
const WHEEL: RGB = [0.15, 0.15, 0.17];
const DARK_STEEL: RGB = [0.2, 0.22, 0.25];
const CABIN_WALL: RGB = [0.9, 0.9, 0.88];
/**
 * Station colours (hood / roof, then trim). Picked per lift from its id, so a resort's
 * stations aren't all one colour but both ends of a lift match.
 */
const LIVERIES: [RGB, RGB][] = [
  [
    [0.62, 0.12, 0.1],
    [0.82, 0.8, 0.76],
  ], // red
  [
    [0.09, 0.22, 0.42],
    [0.85, 0.85, 0.85],
  ], // navy
  [
    [0.86, 0.86, 0.84],
    [0.2, 0.22, 0.25],
  ], // white
  [
    [0.24, 0.26, 0.29],
    [0.75, 0.75, 0.73],
  ], // graphite
  [
    [0.12, 0.35, 0.22],
    [0.82, 0.8, 0.76],
  ], // green
  [
    [0.1, 0.42, 0.62],
    [0.88, 0.88, 0.86],
  ], // sky blue
];

export function livery(seed: number): [RGB, RGB] {
  // Integer hash, so neighbouring ids don't run through the palette in order.
  let h = Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15;
  return LIVERIES[(h >>> 0) % LIVERIES.length]!;
}
/**
 * The pad is flattened to exactly y = 0, so a face within this of it would z-fight the
 * snow. `box` moves such faces clear: up to a visible step, or down out of sight.
 */
export const GROUND_GAP = 0.06;

function clearOfGround(y: number): number {
  if (Math.abs(y) >= GROUND_GAP) return y;
  return y > 0 ? GROUND_GAP : -GROUND_GAP;
}

/** Where a station's name board goes: board centre, the way it faces, max width. */
export interface SignMount {
  centre: Vector3;
  facing: Vector3;
  width: number;
  /** Free-standing (drag-lift arch): posts from the board's ends down to the ground. */
  posts?: [Vector3, Vector3];
}

/** A wall or solid the skier collides with: footprint ring (east, north) and height range. */
export interface Obstacle {
  ring: [number, number][];
  base: number;
  top: number;
}

/**
 * Where a terminal's parts go, in its own frame: u metres in front of the bullwheel
 * (into the line), v metres to the uphill track's side, y metres above the pad.
 */
class TerminalBuilder {
  readonly parts: BufferGeometry[] = [];
  readonly obstacles: Obstacle[] = [];
  readonly signs: SignMount[] = [];
  private readonly origin: Vector3;
  private readonly u: Vector3;
  private readonly v: Vector3;

  constructor(
    readonly t: Terminal,
    private readonly ground: (x: number, z: number) => number,
  ) {
    this.origin = new Vector3(t.east, t.pad, -t.north);
    this.u = new Vector3(t.dir[0], 0, -t.dir[1]);
    this.v = new Vector3(t.across[0], 0, -t.across[1]);
  }

  world(u: number, v: number, y: number): Vector3 {
    return this.origin
      .clone()
      .addScaledVector(this.u, u)
      .addScaledVector(this.v, v)
      .setY(this.origin.y + y);
  }

  /** Axis-aligned (in terminal frame) box. `solid` adds it as a collision obstacle. */
  box(
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    y0: number,
    y1: number,
    colour: RGB,
    solid = false,
  ) {
    y0 = clearOfGround(y0);
    y1 = clearOfGround(y1);
    const g = new BoxGeometry(Math.abs(v1 - v0), y1 - y0, Math.abs(u1 - u0)).toNonIndexed();
    const centre = this.world((u0 + u1) / 2, (v0 + v1) / 2, (y0 + y1) / 2);
    // Box local x → ±v, local z → u. The uphill track (+v) is left of the line at some
    // terminals and right at others; a mirrored basis would turn the box inside out (its
    // outside faces culled), so x takes whichever of ±v keeps it right-handed. The box is
    // centred, so either gives the same shape.
    const up = new Vector3(0, 1, 0);
    const x = this.v.clone();
    if (x.dot(new Vector3().crossVectors(up, this.u)) < 0) x.negate();
    const basis = new Matrix4().makeBasis(x, up, this.u);
    g.applyMatrix4(basis.setPosition(centre));
    paint(g, colour);
    this.parts.push(g);
    if (solid) {
      const ring = [
        this.world(u0, v0, 0),
        this.world(u1, v0, 0),
        this.world(u1, v1, 0),
        this.world(u0, v1, 0),
      ].map((p) => [p.x, -p.z] as [number, number]);
      this.obstacles.push({ ring, base: this.origin.y + y0, top: this.origin.y + y1 });
    }
  }

  /** Direction (world) of a terminal-frame vector. */
  dirOf(u: number, v: number): Vector3 {
    return new Vector3().addScaledVector(this.u, u).addScaledVector(this.v, v).normalize();
  }

  /** Board on a station face at (u, v), board centre `y` above the pad. */
  sign(u: number, v: number, y: number, facing: Vector3, width: number) {
    this.signs.push({ centre: this.world(u, v, y), facing, width });
  }

  /**
   * A column from the footing up. The concrete plinth under it reaches down to the real
   * ground, so where the pad blends into a slope it never floats.
   */
  column(u: number, v: number, height: number, radius = 0.18) {
    const g = new CylinderGeometry(radius, radius, height + 0.6, 8).toNonIndexed();
    g.translate(0, (height + 0.6) / 2 - 0.6, 0);
    const at = this.world(u, v, 0);
    g.applyMatrix4(new Matrix4().makeTranslation(at.x, at.y, at.z));
    paint(g, STEEL);
    this.parts.push(g);
    const foot = this.world(u, v, 0);
    const below = Math.min(-0.6, this.ground(foot.x, foot.z) - this.origin.y - 0.3);
    this.box(u - 0.5, u + 0.5, v - 0.5, v + 0.5, below, 0.25, CONCRETE, true);
  }

  /** The bullwheel: rim, spokes and hub at rope height, on its shaft. */
  wheel(rail: number) {
    const r = this.t.gauge / 2;
    const rim = new CylinderGeometry(r, r, 0.3, 32, 1, true).toNonIndexed();
    const at = this.world(0, 0, rail);
    rim.applyMatrix4(new Matrix4().makeTranslation(at.x, at.y, at.z));
    paint(rim, WHEEL);
    this.parts.push(rim);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      const cu = Math.cos(a) * (r - 0.1);
      const cv = Math.sin(a) * (r - 0.1);
      this.beam(-cu, -cv, cu, cv, rail, 0.12, WHEEL);
    }
    this.box(-0.35, 0.35, -0.35, 0.35, rail - 0.2, rail + 0.25, DARK_STEEL);
  }

  /** A flat bar of `size` square section between two points at height `y`. */
  beam(u0: number, v0: number, u1: number, v1: number, y: number, size: number, colour: RGB) {
    const len = Math.hypot(u1 - u0, v1 - v0);
    const g = new BoxGeometry(size, size, len).toNonIndexed();
    const dir = this.dirOf(u1 - u0, v1 - v0);
    const side = new Vector3(0, 1, 0).cross(dir).normalize();
    const centre = this.world((u0 + u1) / 2, (v0 + v1) / 2, y);
    g.applyMatrix4(new Matrix4().makeBasis(side, new Vector3(0, 1, 0), dir).setPosition(centre));
    paint(g, colour);
    this.parts.push(g);
  }

  /**
   * A moulded hood, the shape of a modern station housing: in plan, rounded round the
   * bullwheel at the back (`u0`, the centre of the curve at u0 + half) and tapering to
   * `taper` of its width at the front end `u1`; edges rounded by `round`.
   */
  hood(
    u0: number,
    u1: number,
    half: number,
    y0: number,
    y1: number,
    colour: RGB,
    taper = 0.7,
    round = 0.35,
  ) {
    // The shape's (x, y) is (u, v), mirrored across the line (it's symmetric) where that
    // keeps the basis right-handed, so the extrusion's faces point outwards.
    const flip = this.u.clone().cross(this.v).y > 0 ? 1 : -1;
    const h = half - round;
    const c = u0 + half;
    const shape = new Shape();
    shape.moveTo(c, -h);
    shape.lineTo(u1 - 3 - round, -h);
    shape.lineTo(u1 - round, -h * taper);
    shape.lineTo(u1 - round, h * taper);
    shape.lineTo(u1 - 3 - round, h);
    shape.lineTo(c, h);
    shape.absarc(c, 0, h, Math.PI / 2, (3 * Math.PI) / 2, false);
    const depth = Math.max(0.1, y1 - y0 - 2 * round);
    const g = new ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: round,
      bevelSize: round,
      bevelSegments: 3,
      curveSegments: 12,
    });
    const flat = g.index ? g.toNonIndexed() : g;
    const vSigned = this.v.clone().multiplyScalar(flip);
    const at = this.world(0, 0, y0 + round);
    flat.applyMatrix4(
      new Matrix4().makeBasis(this.u, vSigned, new Vector3(0, 1, 0)).setPosition(at),
    );
    paint(flat, colour);
    this.parts.push(flat);
  }
}

function paint(g: BufferGeometry, colour: RGB) {
  g.deleteAttribute('uv');
  const c = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < c.length; i += 3) c.set(colour, i);
  g.setAttribute('color', new BufferAttribute(c, 3));
}

/**
 * Build one terminal. `rail` is the haul rope's height above the pad inside the station.
 * Layouts (all from the same few parameters, so they fit any lift):
 * - detachable chair: one moulded hood over the bullwheel and the slow section, on
 *   columns between the tracks, with a loading carpet, gate and glazed operator's cabin;
 * - fixed-grip chair: the bullwheel in the open on a column, under a small drive lid;
 * - gondola / cable car: a glazed hall on a dark plinth under a rounded roof that
 *   overhangs the open line end, the drive housing visible over the bullwheel, and a door
 *   gap on the uphill track's side where you walk in and out;
 * - drag: a bullwheel on a post and a small hut.
 */
const BOARD_RATIO = 0.19; // sign height / width
const WALK_HEADROOM = 4.5; // walkway cut height above the pad (pipeline WALK_HEIGHT)

function buildTerminal(
  t: Terminal,
  rail: number,
  ground: (x: number, z: number) => number,
  seed = 0,
): TerminalBuilder {
  const b = new TerminalBuilder(t, ground);
  const r = t.gauge / 2;
  const w = t.width / 2;
  const L = t.length;
  const B = t.back;
  const roofTop = Math.max(t.roofTop ?? rail + 2.5, rail + 1.5);
  const side = b.dirOf(0, 1);
  const backward = b.dirOf(-1, 0);
  const forward = b.dirOf(1, 0);
  const at = t.end === 'bottom' ? t.load : t.unload;
  const [paintwork, trim] = livery(seed);
  b.wheel(rail);

  if (t.kind === 'chair') {
    let signY: number;
    let hoodHalf: number;
    let hoodFront: number;
    let hoodBack: number;
    if (t.detachable) {
      // A modern detachable terminal: one moulded hood over the bullwheel and the slow
      // section, on a steel frame between the tracks (the chairs swing round outside it).
      hoodHalf = r + 1.7;
      hoodFront = L - 0.5;
      hoodBack = B - 0.3;
      const y0 = rail + 0.35;
      b.hood(-hoodBack, hoodFront, hoodHalf, y0, roofTop, paintwork);
      b.hood(
        -B + 0.5,
        hoodFront - 0.4,
        hoodHalf - 0.2,
        y0 - 0.25,
        y0 + 0.05,
        DARK_STEEL,
        0.65,
        0.1,
      );
      for (const u of [0, L * 0.45, L * 0.8]) b.column(u, 0, y0 - 0.2, 0.32);
      // Grip rails each side, under the hood, where the chairs run through the station.
      for (const v of [-r, r])
        b.box(1, hoodFront - 1, v - 0.15, v + 0.15, rail + 0.15, rail + 0.4, STEEL);
      signY = (y0 + roofTop) / 2;
      if (t.end === 'bottom') {
        // Loading carpet up to the loading point, on the uphill track.
        b.box(t.load - 7, t.load - 0.3, r - 1.4, r + 1.4, -0.3, 0.12, RUBBER);
      }
    } else {
      // Fixed grip: the bullwheel out in the open on a single column, the drive (or
      // tension) unit a small housing over its hub.
      hoodHalf = 1.1;
      hoodFront = 2.7;
      hoodBack = hoodHalf;
      b.column(0, 0, rail - 0.2, 0.3);
      b.hood(-hoodBack, hoodFront, hoodHalf, rail + 0.3, rail + 1.5, paintwork, 0.8, 0.25);
      signY = rail + 0.9;
    }
    if (t.hut) {
      // Centred on the (un)loading point, within the cleared hall (L + 0.8 in front).
      const length = Math.min(OPERATOR_CABIN_LENGTH, L + 0.6 - 0.5);
      const hu = Math.min(Math.max(at - length / 2, 0.5), L + 0.6 - length);
      operatorCabin(b, hu, hu + length, -w - 3.2, -w - 0.4, trim, paintwork);
    }
    const boardW = Math.min(9, hoodFront + hoodBack - 2.5);
    if (t.end === 'bottom') {
      // Loading-line gate, just behind the loading point.
      for (const v of [r - 0.9, r + 0.9])
        b.box(t.load - 1.4, t.load - 1.3, v - 0.04, v + 0.04, 0, 1.1, STRIPE);
      b.box(t.load - 1.4, t.load - 1.3, r - 0.9, r + 0.9, 1.05, 1.12, STRIPE);
      // Name board over the way in: on the hood, facing the entrance.
      if (t.entrance === 'back') {
        b.sign(-hoodBack - 0.08, 0, signY, backward, Math.min(boardW, 2 * hoodHalf - 1));
      } else {
        // Along the hood's straight side, as near the loading point as it fits.
        const u = Math.min(
          Math.max(at, boardW / 2 - hoodBack + hoodHalf),
          hoodFront - 3 - boardW / 2,
        );
        b.sign(u, hoodHalf + 0.08, signY, side, boardW);
      }
    } else {
      // Arriving riders see it on the hood's front end.
      b.sign(hoodFront + 0.08, 0, signY, forward, Math.min(boardW, 2 * hoodHalf * 0.6));
    }
  } else if (t.kind === 'gondola' || t.kind === 'cabin') {
    const roofY = roofTop - 0.45;
    // Door on the entrance side: in the side wall at the (un)loading point, or in the back
    // wall beside the uphill track (outside the carriers' loop).
    const door: [number, number] = [at - 3, at + 3];
    const backDoor: [number, number] = [r + 0.8, Math.min(r + 4.8, w - 0.4)];
    const sideDoor = t.entrance !== 'back';
    const doorTop = Math.min(2.8, roofY - 0.8);
    const sill = Math.min(1.2, doorTop - 0.4); // solid wall below the glazing
    b.box(-B, L, -w, w, -2.5, 0.08, CONCRETE); // platform on its foundation
    // Walls: a concrete plinth, glazing above it, a trim band under the roof. Solid for
    // collisions all the way up.
    const wall = (u0: number, u1: number, v0: number, v1: number, y0 = 0) => {
      b.box(u0, u1, v0, v1, y0, roofY, CONCRETE, true);
      if (y0 < sill) {
        const inset = 0.05;
        const out = (lo: number, hi: number) => [lo - inset, hi + inset] as const;
        const [a0, a1] = out(u0, u1);
        const [b0, b1] = out(v0, v1);
        b.box(a0, a1, b0, b1, Math.max(y0, sill), roofY - 0.5, GLAZING);
        b.box(a0, a1, b0, b1, roofY - 0.5, roofY, trim);
      }
    };
    if (sideDoor) {
      wall(-B, -B + 0.4, -w, w);
      wall(-B, door[0], w - 0.4, w);
      wall(door[1], L, w - 0.4, w);
      b.box(door[0], door[1], w - 0.4, w, doorTop, roofY, trim); // lintel
    } else {
      wall(-B, -B + 0.4, -w, backDoor[0]);
      wall(-B, -B + 0.4, backDoor[1], w);
      b.box(-B, -B + 0.4, backDoor[0], backDoor[1], doorTop, roofY, trim); // lintel
      wall(-B, L, w - 0.4, w);
    }
    wall(-B, L, -w, -w + 0.4);
    // Steel portal round the open end, where the cabins leave.
    for (const v of [-w + 0.2, w - 0.2])
      b.box(L - 0.5, L + 0.1, v - 0.3, v + 0.3, 0, roofY, DARK_STEEL);
    // Roof: a rounded hood over the hall, overhanging the open end and the door side.
    b.hood(-B - 0.6, L + 2.5, w + 0.6, roofY, roofTop + 0.3, paintwork, 0.92, 0.4);
    b.box(-B + 0.5, L - 0.5, -(r + 0.6), r + 0.6, rail + 0.2, rail + 0.5, STEEL); // rail beam
    // Drive housing over the bullwheel, seen through the open end.
    b.box(-1.2, 1.2, -1.2, 1.2, rail + 0.5, Math.min(rail + 2.2, roofY - 0.2), paintwork);
    // Name board above the door, inside the walkway the pipeline cuts through any
    // building in front of it (6 m wide / 4 m at the back, 4.5 m headroom).
    const opening = sideDoor ? door[1] - door[0] : backDoor[1] - backDoor[0];
    const room = Math.min(roofY, WALK_HEADROOM) - doorTop - 0.3;
    const boardW = Math.min(opening - 0.4, Math.max(2.4, room / BOARD_RATIO));
    const signY = doorTop + 0.15 + (boardW * BOARD_RATIO) / 2;
    if (sideDoor) b.sign(at, w + 0.08, signY, side, boardW);
    else b.sign(-B - 0.08, (backDoor[0] + backDoor[1]) / 2, signY, backward, boardW);
  } else {
    // Drag lift: bullwheel post, a small hut, and a name board on an arch over the track.
    b.column(0, 0, rail, 0.25);
    if (t.hut) hut(b, 1, 3.5, -w - 3, -w - 0.5);
    const bw = 3.2;
    const u = t.end === 'bottom' ? t.load + 1.5 : t.unload - 1.5;
    const y = 2.4 + (bw * BOARD_RATIO) / 2;
    b.signs.push({
      centre: b.world(u, r, y),
      facing: t.end === 'bottom' ? backward : forward,
      width: bw,
      posts: [b.world(u, r - bw / 2 - 0.1, 0), b.world(u, r + bw / 2 + 0.1, 0)],
    });
  }
  return b;
}

const OPERATOR_CABIN_LENGTH = 4.6;

/**
 * A lift operator's cabin between `v0` (the back) and `v1` (the side facing the lift):
 * light walls, a long window looking out over the line where the operator sits, a
 * smaller one at each end, a door at the back, and a flat roof with eaves.
 */
function operatorCabin(
  b: TerminalBuilder,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  walls: RGB,
  roof: RGB,
) {
  const wall = walls === DARK_STEEL ? CABIN_WALL : walls;
  b.box(u0, u1, v0, v1, -0.8, 2.6, wall, true);
  // Window to the lift: most of the front, from desk height up, with a frame round it.
  b.box(u0 + 0.3, u1 - 0.3, v1 - 0.02, v1 + 0.05, 0.95, 2.2, DARK_STEEL);
  b.box(u0 + 0.38, u1 - 0.38, v1 + 0.03, v1 + 0.07, 1.03, 2.12, GLAZING);
  // End windows, looking up and down the line.
  for (const [ua, ub] of [
    [u0 - 0.05, u0 + 0.02],
    [u1 - 0.02, u1 + 0.05],
  ] as const) {
    b.box(ua, ub, v1 - 1.4, v1 - 0.3, 1.1, 2.1, GLAZING);
  }
  // Door at the back (decorative): a panel standing proud of the wall, a handle, a step.
  const dc = (u0 + u1) / 2;
  b.box(dc - 0.5, dc + 0.5, v0 - 0.05, v0 + 0.02, 0, 2.1, DARK_STEEL);
  b.box(dc - 0.44, dc + 0.44, v0 - 0.08, v0 - 0.03, 0.06, 2.04, roof);
  b.box(dc + 0.28, dc + 0.36, v0 - 0.13, v0 - 0.07, 1.0, 1.06, STEEL);
  b.box(dc - 0.6, dc + 0.6, v0 - 0.45, v0, -0.3, 0.15, CONCRETE);
  b.box(u0 - 0.35, u1 + 0.35, v0 - 0.35, v1 + 0.35, 2.6, 2.85, roof);
}

function hut(b: TerminalBuilder, u0: number, u1: number, v0: number, v1: number) {
  b.box(u0, u1, v0, v1, -0.8, 2.5, TIMBER, true);
  b.box(u0 + 0.3, u1 - 0.3, v1 - 0.02, v1 + 0.02, 1.2, 2.0, GLASS); // window to the line
  b.box(u0 - 0.3, u1 + 0.3, v0 - 0.3, v1 + 0.3, 2.5, 2.75, ROOF);
}

/**
 * All terminals merged into one mesh (one draw call), plus their collision obstacles.
 * `rails` gives each terminal's rail height above its pad.
 */
export function createTerminals(
  terminals: { terminal: Terminal; rail: number; seed?: number }[],
  ground: (x: number, z: number) => number,
): { mesh: Mesh; obstacles: Obstacle[]; signs: SignMount[][] } {
  const parts: BufferGeometry[] = [];
  const obstacles: Obstacle[] = [];
  const signs: SignMount[][] = [];
  for (const { terminal, rail, seed } of terminals) {
    const built = buildTerminal(terminal, rail, ground, seed);
    parts.push(...built.parts);
    obstacles.push(...built.obstacles);
    signs.push(built.signs);
  }
  const geometry = parts.length ? mergeGeometries(parts)! : new BoxGeometry(0, 0, 0);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new Mesh(
    geometry,
    new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15 }),
  );
  mesh.name = 'lift-terminals';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, obstacles, signs };
}
