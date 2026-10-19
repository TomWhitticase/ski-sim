import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CylinderGeometry,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Vector3,
} from 'three/webgpu';

import type { Terminal } from '../features/types';

type RGB = [number, number, number];

const CONCRETE: RGB = [0.56, 0.55, 0.53];
const STEEL: RGB = [0.42, 0.45, 0.5];
const ROOF: RGB = [0.62, 0.12, 0.1];
const HOUSING: RGB = [0.09, 0.22, 0.42];
const WALL: RGB = [0.82, 0.8, 0.76];
const GLASS: RGB = [0.12, 0.16, 0.22];
const TIMBER: RGB = [0.38, 0.25, 0.15];
const STRIPE: RGB = [0.95, 0.75, 0.1];
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
    // Box local x → v, local z → u.
    const basis = new Matrix4().makeBasis(this.v, new Vector3(0, 1, 0), this.u);
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

  wheel(rail: number) {
    const r = this.t.gauge / 2;
    const g = new CylinderGeometry(r, r, 0.12, 24, 1, true).toNonIndexed();
    const at = this.world(0, 0, rail);
    g.applyMatrix4(new Matrix4().makeTranslation(at.x, at.y, at.z));
    paint(g, [0.15, 0.15, 0.17]);
    this.parts.push(g);
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
 * - chair: bullwheel housing on a portal frame, a roof canopy over the loading area,
 *   an operator's hut, a loading-line gate;
 * - gondola / cable car: an enclosed hall, open at the line end, with a door gap on the
 *   uphill track's side where you walk in and out;
 * - drag: a bullwheel on a post and a small hut.
 */
const BOARD_RATIO = 0.19; // sign height / width
const HOUSING_TOP = 1.9; // bullwheel housing top above the rail (chairs)
const WALK_HEADROOM = 4.5; // walkway cut height above the pad (pipeline WALK_HEIGHT)

function buildTerminal(
  t: Terminal,
  rail: number,
  ground: (x: number, z: number) => number,
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
  b.wheel(rail);

  if (t.kind === 'chair') {
    // Bullwheel housing on a portal frame (above the carriers' grips), always clearly
    // under the canopy roof so the two never overlap.
    const housingTop = rail + HOUSING_TOP;
    for (const v of [-(r + 1.2), r + 1.2]) b.column(-B + 0.6, v, rail + 0.3);
    b.box(-B, r + 1.5, -(r + 1.6), r + 1.6, rail + 0.3, housingTop, HOUSING);
    let signY = (rail + 0.3 + housingTop) / 2;
    if (t.detachable) {
      const roofY = roofTop - 0.25;
      for (const u of [r + 1.5, L * 0.55, L - 0.5]) {
        for (const v of [-w + 0.4, w - 0.4]) b.column(u, v, roofY);
      }
      b.box(-B, L, -w, w, roofY, roofTop, ROOF);
      b.box(-B + 0.5, L - 0.5, -(r + 0.5), r + 0.5, rail + 0.15, rail + 0.4, STEEL); // rail beam
      signY = roofY - 0.15 - (9 * BOARD_RATIO) / 2;
    }
    if (t.hut) {
      const hu = Math.max(at - 1.5, 0.5);
      hut(b, hu, hu + 3, -w - 3.2, -w - 0.4);
    }
    if (t.end === 'bottom') {
      // Loading-line gate, just behind the loading point.
      for (const v of [r - 0.9, r + 0.9])
        b.box(t.load - 1.4, t.load - 1.3, v - 0.04, v + 0.04, 0, 1.1, STRIPE);
      b.box(t.load - 1.4, t.load - 1.3, r - 0.9, r + 0.9, 1.05, 1.12, STRIPE);
      // Name board over the way in: canopy (or housing) edge facing the entrance.
      if (t.entrance === 'back') {
        b.sign(-B - 0.08, 0, signY, backward, t.detachable ? t.width - 0.6 : 2 * r + 3);
      } else if (t.detachable) {
        b.sign(at, w + 0.08, signY, side, 9);
      } else {
        b.sign((r + 1.5 - B) / 2, r + 1.68, signY, side, 3.2);
      }
    } else {
      // Arriving riders see it on the line end.
      const u = t.detachable ? L + 0.08 : r + 1.58;
      b.sign(u, 0, signY, forward, t.detachable ? t.width - 0.6 : 2 * r + 3);
    }
  } else if (t.kind === 'gondola' || t.kind === 'cabin') {
    const roofY = roofTop - 0.45;
    // Door on the entrance side: in the side wall at the (un)loading point, or in the back
    // wall beside the uphill track (outside the carriers' loop).
    const door: [number, number] = [at - 3, at + 3];
    const backDoor: [number, number] = [r + 0.8, Math.min(r + 4.8, w - 0.4)];
    const sideDoor = t.entrance !== 'back';
    const doorTop = Math.min(2.8, roofY - 0.8);
    b.box(-B, L, -w, w, -2.5, 0.08, CONCRETE); // platform on its foundation
    if (sideDoor) {
      b.box(-B, -B + 0.4, -w, w, 0, roofY, WALL, true);
      b.box(-B, door[0], w - 0.4, w, 0, roofY, WALL, true);
      b.box(door[1], L, w - 0.4, w, 0, roofY, WALL, true);
      b.box(door[0], door[1], w - 0.4, w, doorTop, roofY, WALL); // lintel
    } else {
      b.box(-B, -B + 0.4, -w, backDoor[0], 0, roofY, WALL, true);
      b.box(-B, -B + 0.4, backDoor[1], w, 0, roofY, WALL, true);
      b.box(-B, -B + 0.4, backDoor[0], backDoor[1], doorTop, roofY, WALL); // lintel
      b.box(-B, L, w - 0.4, w, 0, roofY, WALL, true);
    }
    b.box(-B, L, -w, -w + 0.4, 0, roofY, WALL, true);
    b.box(-B + 1, L - 1, -w - 0.02, -w + 0.42, roofY * 0.55, roofY * 0.85, GLASS);
    b.box(-B - 0.5, L + 0.8, -w - 0.5, w + 0.5, roofY, roofTop, ROOF);
    b.box(-B + 0.5, L - 0.5, -(r + 0.6), r + 0.6, rail + 0.2, rail + 0.5, STEEL); // rail beam
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
  terminals: { terminal: Terminal; rail: number }[],
  ground: (x: number, z: number) => number,
): { mesh: Mesh; obstacles: Obstacle[]; signs: SignMount[][] } {
  const parts: BufferGeometry[] = [];
  const obstacles: Obstacle[] = [];
  const signs: SignMount[][] = [];
  for (const { terminal, rail } of terminals) {
    const built = buildTerminal(terminal, rail, ground);
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
