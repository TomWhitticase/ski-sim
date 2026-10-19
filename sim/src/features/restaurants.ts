import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  SRGBColorSpace,
  ShapeUtils,
  Vector2,
} from 'three/webgpu';

import { atlasLayout } from '../lifts/signs';
import { pointInRing } from './building-index';
import { signedArea } from './buildings';
import type { Building, Restaurant } from './types';

type RGB = [number, number, number];
type EN = [number, number];

const DECK: RGB = [0.46, 0.33, 0.21];
const DECK_EDGE: RGB = [0.3, 0.2, 0.12];
const STONE: RGB = [0.52, 0.5, 0.47];
const RAIL: RGB = [0.28, 0.19, 0.11];
const TABLE: RGB = [0.5, 0.36, 0.22];
const POLE: RGB = [0.85, 0.85, 0.82];
const LOUNGER: RGB = [0.62, 0.45, 0.27];
const BOARD: RGB = [0.2, 0.13, 0.08];
/** Parasol canvas colours, one per restaurant (picked by id). */
const PARASOLS: RGB[] = [
  [0.92, 0.89, 0.8],
  [0.7, 0.1, 0.08],
  [0.92, 0.89, 0.8],
  [0.16, 0.34, 0.2],
];

const PARASOL_SPACING = 4.6;
const RAIL_HEIGHT = 1.0;

/** Triangles with per-vertex colours, in local ENU (east, up, north) until written out. */
class Builder {
  readonly positions: number[] = [];
  readonly colours: number[] = [];

  tri(a: number[], b: number[], c: number[], colour: RGB): void {
    for (const [e, y, n] of [a, b, c]) {
      this.positions.push(e!, y!, -n!);
      this.colours.push(...colour);
    }
  }

  quad(a: number[], b: number[], c: number[], d: number[], colour: RGB): void {
    this.tri(a, b, c, colour);
    this.tri(a, c, d, colour);
  }

  /** An upright box: centre (e, n), base height, size along `dir` / across / up. */
  box(
    e: number,
    n: number,
    base: number,
    dir: EN,
    length: number,
    width: number,
    height: number,
    colour: RGB,
  ): void {
    const [dx, dn] = dir;
    const ax = -dn;
    const an = dx;
    const l = length / 2;
    const w = width / 2;
    // Counter-clockwise footprint seen from above.
    const ring: EN[] = [
      [e - dx * l - ax * w, n - dn * l - an * w],
      [e + dx * l - ax * w, n + dn * l - an * w],
      [e + dx * l + ax * w, n + dn * l + an * w],
      [e - dx * l + ax * w, n - dn * l + an * w],
    ];
    this.prism(ring, base, base + height, colour);
  }

  /** Extrude a counter-clockwise ring between two heights (walls and a top). */
  prism(ring: EN[], bottom: number, top: number, colour: RGB, topColour = colour): void {
    for (let i = 0; i < ring.length; i++) {
      const [e0, n0] = ring[i]!;
      const [e1, n1] = ring[(i + 1) % ring.length]!;
      this.quad([e0, bottom, n0], [e1, bottom, n1], [e1, top, n1], [e0, top, n0], colour);
    }
    this.cap(ring, top, topColour);
  }

  /** A flat, upward-facing polygon. */
  cap(ring: EN[], height: number, colour: RGB): void {
    const contour = ring.map(([e, n]) => new Vector2(e, n));
    for (const [i0, i1, i2] of ShapeUtils.triangulateShape(contour, [])) {
      const a = ring[i0!]!;
      let b = ring[i1!]!;
      let c = ring[i2!]!;
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) [b, c] = [c, b];
      this.tri([a[0], height, a[1]], [b[0], height, b[1]], [c[0], height, c[1]], colour);
    }
  }
}

function segmentDistance(p: EN, a: EN, b: EN): number {
  const dx = b[0] - a[0];
  const dn = b[1] - a[1];
  const len2 = dx * dx + dn * dn;
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dn) / len2)) : 0;
  const e = a[0] + dx * t - p[0];
  const n = a[1] + dn * t - p[1];
  return Math.sqrt(e * e + n * n);
}

function ringDistance(p: EN, ring: EN[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, segmentDistance(p, ring[i]!, ring[(i + 1) % ring.length]!));
  }
  return best;
}

/**
 * Where the furniture goes on a deck: parasol tables on a grid aligned with the deck's
 * longest side, and sun loungers in a row along the open edges, facing out. Pure, so it
 * can be tested.
 */
export function layoutTerrace(
  ring: EN[],
  building: EN[] | null,
): { tables: EN[]; loungers: { at: EN; facing: EN }[]; along: EN } {
  let along: EN = [1, 0];
  let longest = 0;
  for (let i = 0; i < ring.length; i++) {
    const [e0, n0] = ring[i]!;
    const [e1, n1] = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(e1 - e0, n1 - n0);
    if (len > longest) [longest, along] = [len, [(e1 - e0) / len, (n1 - n0) / len]];
  }
  const across: EN = [-along[1], along[0]];
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [e, n] of ring) {
    const u = e * along[0] + n * along[1];
    const v = e * across[0] + n * across[1];
    [minU, maxU, minV, maxV] = [
      Math.min(minU, u),
      Math.max(maxU, u),
      Math.min(minV, v),
      Math.max(maxV, v),
    ];
  }
  const at = (u: number, v: number): EN => [
    along[0] * u + across[0] * v,
    along[1] * u + across[1] * v,
  ];

  // Loungers go along open edges (not the one against the hut), a metre in.
  const loungers: { at: EN; facing: EN }[] = [];
  const area = signedArea(ring);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 3) continue;
    const mid: EN = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (building && ringDistance(mid, building) < 1.5) continue;
    const dir: EN = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    // Outward normal: right of the edge for a counter-clockwise ring.
    const out: EN = area > 0 ? [dir[1], -dir[0]] : [-dir[1], dir[0]];
    for (let s = 1.2; s < len - 1.2; s += 1.6) {
      const p: EN = [a[0] + dir[0] * s - out[0] * 1.3, a[1] + dir[1] * s - out[1] * 1.3];
      if (pointInRing(p[0], p[1], ring) && ringDistance(p, ring) > 0.9) {
        loungers.push({ at: p, facing: out });
      }
    }
  }

  // Tables fill the middle, clear of the loungers and the walls.
  const tables: EN[] = [];
  const nu = Math.max(1, Math.floor((maxU - minU - 3) / PARASOL_SPACING) + 1);
  const nv = Math.max(1, Math.floor((maxV - minV - 3) / PARASOL_SPACING) + 1);
  const u0 = (minU + maxU) / 2 - ((nu - 1) * PARASOL_SPACING) / 2;
  const v0 = (minV + maxV) / 2 - ((nv - 1) * PARASOL_SPACING) / 2;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const p = at(u0 + i * PARASOL_SPACING, v0 + j * PARASOL_SPACING);
      if (!pointInRing(p[0], p[1], ring) || ringDistance(p, ring) < 2.2) continue;
      if (building && ringDistance(p, building) < 2.4) continue;
      if (loungers.some((l) => Math.hypot(l.at[0] - p[0], l.at[1] - p[1]) < 2.2)) continue;
      tables.push(p);
    }
  }
  return { tables, loungers, along };
}

function addTerrace(
  out: Builder,
  r: Restaurant,
  building: Building | undefined,
  groundHeight: (east: number, north: number) => number,
): void {
  const t = r.terrace!;
  const ring: EN[] = signedArea(t.ring) < 0 ? [...t.ring].reverse() : t.ring;
  const top = t.top;

  // Deck boards on top; a timber edge, then a stone wall down into the slope.
  out.cap(ring, top, DECK);
  for (let i = 0; i < ring.length; i++) {
    const [e0, n0] = ring[i]!;
    const [e1, n1] = ring[(i + 1) % ring.length]!;
    const g0 = Math.min(groundHeight(e0, n0), top) - 0.4;
    const g1 = Math.min(groundHeight(e1, n1), top) - 0.4;
    out.quad([e0, top - 0.3, n0], [e1, top - 0.3, n1], [e1, top, n1], [e0, top, n0], DECK_EDGE);
    out.quad([e0, g0, n0], [e1, g1, n1], [e1, top - 0.3, n1], [e0, top - 0.3, n0], STONE);
  }

  // Railing round the open sides.
  const hut = building?.footprint ?? null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const mid: EN = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (hut && ringDistance(mid, hut) < 1.5) continue;
    const dir: EN = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    out.box(mid[0], mid[1], top + RAIL_HEIGHT - 0.1, dir, len, 0.12, 0.1, RAIL);
    out.box(mid[0], mid[1], top + 0.45, dir, len, 0.06, 0.08, RAIL);
    const posts = Math.max(1, Math.round(len / 1.4));
    for (let k = 0; k <= posts; k++) {
      const s = (k / posts) * len;
      out.box(a[0] + dir[0] * s, a[1] + dir[1] * s, top, dir, 0.1, 0.1, RAIL_HEIGHT, RAIL);
    }
  }

  const { tables, loungers, along } = layoutTerrace(ring, hut);
  const canvas = PARASOLS[Math.abs(r.id) % PARASOLS.length]!;
  const across: EN = [-along[1], along[0]];
  for (const [e, n] of tables) {
    out.box(e, n, top + 0.72, along, 1.8, 0.8, 0.05, TABLE);
    out.box(e, n, top, along, 0.12, 0.12, 0.72, RAIL);
    for (const side of [-0.75, 0.75]) {
      const be = e + across[0] * side;
      const bn = n + across[1] * side;
      out.box(be, bn, top + 0.42, along, 1.8, 0.32, 0.05, TABLE);
      out.box(be, bn, top, along, 1.4, 0.08, 0.42, RAIL);
    }
    parasol(out, e, n, top, canvas);
  }
  for (const { at, facing } of loungers) {
    // Seat and a backrest tilted up at the end nearest the hut, so you face out.
    const [e, n] = at;
    out.box(e, n, top + 0.25, facing, 1.3, 0.6, 0.08, LOUNGER);
    const be = e - facing[0] * 0.75;
    const bn = n - facing[1] * 0.75;
    const back: EN = facing;
    const width = 0.6;
    const ax = -back[1] * (width / 2);
    const an = back[0] * (width / 2);
    const low = top + 0.3;
    const high = top + 0.85;
    const tilt = 0.35;
    out.quad(
      [be + ax, low, bn + an],
      [be - ax, low, bn - an],
      [be - ax - back[0] * tilt, high, bn - an - back[1] * tilt],
      [be + ax - back[0] * tilt, high, bn + an - back[1] * tilt],
      LOUNGER,
    );
    out.quad(
      [be - ax, low, bn - an],
      [be + ax, low, bn + an],
      [be + ax - back[0] * tilt, high, bn + an - back[1] * tilt],
      [be - ax - back[0] * tilt, high, bn - an - back[1] * tilt],
      LOUNGER,
    );
    out.box(e, n, top, facing, 1.1, 0.5, 0.25, RAIL);
  }
}

/** A big square-ish market parasol: pole, eight-sided canopy and a hanging valance. */
function parasol(out: Builder, e: number, n: number, top: number, colour: RGB): void {
  const sides = 8;
  const radius = 1.9;
  const rim = top + 2.35;
  const apex = top + 2.95;
  out.box(e, n, top, [1, 0], 0.07, 0.07, 2.95, POLE);
  const under: RGB = [colour[0] * 0.75, colour[1] * 0.75, colour[2] * 0.75];
  for (let i = 0; i < sides; i++) {
    const a0 = ((i + 0.5) / sides) * Math.PI * 2;
    const a1 = ((i + 1.5) / sides) * Math.PI * 2;
    const p0 = [e + Math.cos(a0) * radius, rim, n + Math.sin(a0) * radius];
    const p1 = [e + Math.cos(a1) * radius, rim, n + Math.sin(a1) * radius];
    const tip = [e, apex, n];
    out.tri(p0, p1, tip, colour); // top: counter-clockwise from above in east/north
    out.tri(p0, tip, p1, under);
    const d0 = [p0[0]!, rim - 0.22, p0[2]!];
    const d1 = [p1[0]!, rim - 0.22, p1[2]!];
    out.quad(p1, p0, d0, d1, colour);
    out.quad(p0, p1, d1, d0, under);
  }
}

// --- name boards --------------------------------------------------------------------

const CELL_W = 1024;
const CELL_H = 192;
const BOARD_HEIGHT = 1.1;

interface BoardCell {
  /** Used width of the cell (px), so the board keeps the text's proportions. */
  width: number;
}

function drawBoards(names: string[]): {
  texture: CanvasTexture;
  cells: BoardCell[];
  columns: number;
  rows: number;
} {
  const { columns, rows, scale } = atlasLayout(names.length);
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(CELL_W * columns * scale);
  canvas.height = Math.floor(CELL_H * rows * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  const cells = names.map((name, i) => {
    const x = (i % columns) * CELL_W;
    const y = Math.floor(i / columns) * CELL_H;
    let size = 112;
    const font = () => `700 ${size}px Georgia, 'Times New Roman', serif`;
    ctx.font = font();
    while (ctx.measureText(name).width > CELL_W - 90 && size > 48) {
      size -= 4;
      ctx.font = font();
    }
    const width = Math.min(CELL_W, Math.ceil(ctx.measureText(name).width) + 90);
    // Dark carved board with a lighter rim and cream lettering.
    ctx.fillStyle = '#3a2414';
    ctx.fillRect(x, y, width, CELL_H);
    ctx.strokeStyle = '#7a5532';
    ctx.lineWidth = 10;
    ctx.strokeRect(x + 9, y + 9, width - 18, CELL_H - 18);
    ctx.fillStyle = '#f1e4c6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, x + width / 2, y + CELL_H * 0.54);
    return { width };
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  return { texture, cells, columns, rows };
}

function createBoards(restaurants: Restaurant[], backing: Builder): Mesh | null {
  const signed = restaurants.filter((r) => r.sign);
  if (signed.length === 0) return null;
  const { texture, cells, columns, rows } = drawBoards(signed.map((r) => r.name));
  const positions: number[] = [];
  const uvs: number[] = [];
  signed.forEach((r, i) => {
    const s = r.sign!;
    const cell = cells[i]!;
    let width = (BOARD_HEIGHT * cell.width) / CELL_H;
    let height = BOARD_HEIGHT;
    if (width > s.width) [width, height] = [s.width, (BOARD_HEIGHT * s.width) / width];
    const h = (s.heading * Math.PI) / 180;
    const normal: EN = [Math.sin(h), Math.cos(h)];
    // The viewer's right, standing in front of the board.
    const right: EN = [-normal[1], normal[0]];
    const c: EN = [s.east, s.north];
    const corner = (x: number, y: number) => [
      c[0] + right[0] * x,
      s.height + y,
      -(c[1] + right[1] * x),
    ];
    const a = corner(-width / 2, -height / 2);
    const b = corner(width / 2, -height / 2);
    const cc = corner(width / 2, height / 2);
    const d = corner(-width / 2, height / 2);
    positions.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    const u0 = (i % columns) / columns;
    const u1 = u0 + cell.width / CELL_W / columns;
    const vTop = 1 - Math.floor(i / columns) / rows;
    const vBottom = vTop - 1 / rows;
    uvs.push(u0, vBottom, u1, vBottom, u1, vTop, u0, vBottom, u1, vTop, u0, vTop);
    // A thicker plank behind, so the board stands proud of the wall.
    backing.box(
      c[0] - normal[0] * 0.06,
      c[1] - normal[1] * 0.06,
      s.height - height / 2 - 0.06,
      right,
      width + 0.12,
      0.1,
      height + 0.12,
      BOARD,
    );
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, new MeshStandardNodeMaterial({ map: texture, roughness: 0.75 }));
  mesh.name = 'restaurant-boards';
  return mesh;
}

/**
 * Mountain-restaurant dressing: sun terraces (deck, railing, parasol tables, loungers) and
 * name boards. Static, so it's two meshes and two draw calls for the whole resort.
 */
export function createRestaurants(
  restaurants: Restaurant[],
  buildings: Building[],
  groundHeight: (east: number, north: number) => number,
): Group {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const group = new Group();
  group.name = 'restaurants';
  const builder = new Builder();
  for (const r of restaurants) {
    if (r.terrace)
      addTerrace(builder, r, r.building !== null ? byId.get(r.building) : undefined, groundHeight);
  }
  const boards = createBoards(restaurants, builder);
  if (builder.positions.length > 0) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(builder.positions), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(builder.colours), 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new Mesh(
      geometry,
      new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 }),
    );
    mesh.name = 'restaurant-terraces';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (boards) group.add(boards);
  return group;
}

/** Solids for collisions: a deck is a raised platform you ski round, not through. */
export function terraceSolids(
  restaurants: Restaurant[],
  groundHeight: (east: number, north: number) => number,
): { ring: [number, number][]; base: number; top: number }[] {
  return restaurants
    .filter((r) => r.terrace)
    .map((r) => {
      const t = r.terrace!;
      const base = Math.min(...t.ring.map(([e, n]) => groundHeight(e, n))) - 1;
      return { ring: t.ring, base, top: t.top + RAIL_HEIGHT };
    });
}
