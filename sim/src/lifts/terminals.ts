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
  private readonly origin: Vector3;
  private readonly u: Vector3;
  private readonly v: Vector3;

  constructor(readonly t: Terminal) {
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

  /** A column from the footing up, with a concrete foundation block at its base. */
  column(u: number, v: number, height: number, radius = 0.18) {
    const g = new CylinderGeometry(radius, radius, height + 0.6, 8).toNonIndexed();
    g.translate(0, (height + 0.6) / 2 - 0.6, 0);
    const at = this.world(u, v, 0);
    g.applyMatrix4(new Matrix4().makeTranslation(at.x, at.y, at.z));
    paint(g, STEEL);
    this.parts.push(g);
    this.box(u - 0.5, u + 0.5, v - 0.5, v + 0.5, -1.5, 0.25, CONCRETE, true);
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
function buildTerminal(t: Terminal, rail: number): TerminalBuilder {
  const b = new TerminalBuilder(t);
  const r = t.gauge / 2;
  const w = t.width / 2;
  const L = t.length;
  const B = t.back;
  b.wheel(rail);

  if (t.kind === 'chair') {
    const roofY = rail + 1.3;
    // Portal frame and housing round the bullwheel (above the carriers' grips).
    for (const v of [-(r + 1.2), r + 1.2]) b.column(-B + 0.6, v, rail + 0.3);
    b.box(-B, r + 1.5, -(r + 1.6), r + 1.6, rail + 0.3, rail + 2.0, HOUSING);
    if (t.detachable) {
      // Roof canopy on columns over the slow-moving station section.
      for (const u of [r + 1.5, L * 0.55, L - 0.5]) {
        for (const v of [-w + 0.4, w - 0.4]) b.column(u, v, roofY);
      }
      b.box(-B, L, -w, w, roofY, roofY + 0.25, ROOF);
      b.box(-B + 0.5, L - 0.5, -(r + 0.5), r + 0.5, rail + 0.15, rail + 0.4, STEEL); // rail beam
    }
    // Operator's hut on the downhill-track side, clear of both tracks.
    const hu = t.end === 'bottom' ? Math.min(t.load + 2, L - 3) : Math.max(t.unload - 2, 1);
    hut(b, hu, hu + 3, -w - 3.2, -w - 0.4);
    if (t.end === 'bottom') {
      // Loading-line gate: two posts and a bar, just behind the loading point.
      for (const v of [r - 0.9, r + 0.9])
        b.box(t.load - 1.4, t.load - 1.3, v - 0.04, v + 0.04, 0, 1.1, STRIPE);
      b.box(t.load - 1.4, t.load - 1.3, r - 0.9, r + 0.9, 1.05, 1.12, STRIPE);
    }
  } else if (t.kind === 'gondola' || t.kind === 'cabin') {
    const roofY = rail + (t.kind === 'cabin' ? 2 : 1.2);
    const doorAt = t.end === 'bottom' ? t.load : t.unload;
    const door: [number, number] = [doorAt - 3, doorAt + 3];
    // Foundation slab edge (visible where the ground falls away).
    b.box(-B, L, -w, w, -2.5, -0.02, CONCRETE);
    // Back wall, side walls (uphill side has the door gap), roof.
    b.box(-B, -B + 0.4, -w, w, 0, roofY, WALL, true);
    b.box(-B, L, -w, -w + 0.4, 0, roofY, WALL, true);
    b.box(-B, door[0], w - 0.4, w, 0, roofY, WALL, true);
    b.box(door[1], L, w - 0.4, w, 0, roofY, WALL, true);
    b.box(door[0], door[1], w - 0.4, w, 2.6, roofY, WALL); // lintel over the door
    // Window bands.
    b.box(-B + 1, L - 1, -w - 0.02, -w + 0.42, roofY * 0.55, roofY * 0.85, GLASS);
    b.box(door[1] + 0.5, L - 1, w - 0.42, w + 0.02, roofY * 0.55, roofY * 0.85, GLASS);
    b.box(-B - 0.5, L + 0.8, -w - 0.5, w + 0.5, roofY, roofY + 0.45, ROOF);
    b.box(-B + 0.5, L - 0.5, -(r + 0.6), r + 0.6, rail + 0.2, rail + 0.5, STEEL); // rail beam
  } else {
    // Drag lift: bullwheel post and a small hut.
    b.column(0, 0, rail, 0.25);
    hut(b, 1, 3.5, -t.width / 2 - 3, -t.width / 2 - 0.5);
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
export function createTerminals(terminals: { terminal: Terminal; rail: number }[]): {
  mesh: Mesh;
  obstacles: Obstacle[];
} {
  const parts: BufferGeometry[] = [];
  const obstacles: Obstacle[] = [];
  for (const { terminal, rail } of terminals) {
    const built = buildTerminal(terminal, rail);
    parts.push(...built.parts);
    obstacles.push(...built.obstacles);
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
  return { mesh, obstacles };
}
