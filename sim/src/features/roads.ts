import {
  abs,
  attribute,
  cameraPosition,
  Discard,
  float,
  Fn,
  fract,
  mix,
  mx_noise_float,
  positionGeometry,
  positionLocal,
  smoothstep,
  step,
  texture,
  vec2,
  vec3,
} from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  type Texture,
  type Vector3,
} from 'three/webgpu';

import { Builder } from './airfields';
import type { Solid } from './obstacles';
import type { Road, Roads } from './types';

type EN = [number, number];
type RGB = [number, number, number];
type Ground = (east: number, north: number) => number;

/** Height of a road's surface above the ground: under the airfields' (10 cm and up). */
export const ROAD_LIFT = 0.06;
/** Centreline points are no further apart than this (m), so the strip follows the ground. */
export const STEP = 3;
/** Roads are built and drawn in square tiles this big (m), only near the camera. */
export const TILE = 1000;
/** Vertices per strip chunk (a tile holds the chunks whose middle is in it). */
const CHUNK = 40;
/** A mitred corner is never pushed out more than this many half-widths. */
const MITRE_LIMIT = 2;
/** Main roads with a centre line (dashed, worn). */
const CENTRE_LINE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const CENTRE_LINE_MIN_WIDTH = 5.5;
/** Bridge decks: how deep their sides are, and how far above the ground they stay (m). */
const DECK_DEPTH = 0.8;
const DECK_CLEARANCE = 0.3;
const DECK_EASE = 5;
/** A fragment is the piste's, not the road's, where groomed coverage is over this. */
const PISTE_CUT = 0.25;

/** Bits of the `road` attribute's w. */
export const FLAG = { centreLine: 1, bridge: 2, side: 4 } as const;

/** Ploughed snowbank along a road: lower and narrower than a runway's (m). */
export const ROAD_BANK = { base: 2.2, top: 0.7, height: 0.8, taper: 2 } as const;
/** Snow pole (m). */
export const SNOW_POLE = { height: 2.2, radius: 0.035 } as const;

const ASPHALT = vec3(0.05, 0.053, 0.057);
const SLUSH = vec3(0.5, 0.52, 0.55);
const LINE_PAINT = vec3(0.62, 0.62, 0.6);
const CONCRETE = vec3(0.42, 0.42, 0.41);
const BANK: RGB = [0.95, 0.96, 0.99];
const BANK_DIRTY: RGB = [0.78, 0.78, 0.79];
const POLE: RGB = [0.8, 0.13, 0.06];
const POLE_BAND: RGB = [0.92, 0.92, 0.9];

/**
 * How far a road's vertices are moved toward the camera (m) at `distance`: a pure depth
 * bias (along the view ray, so nothing moves on screen), enough to keep the draped
 * surface above coarser terrain LODs further out (10 m cells beyond 500 m, 20 m beyond
 * 1 km) without showing through ridges in front of it.
 */
export function depthBias(distance: number): number {
  return 0.05 + 0.002 * distance;
}

/** The polyline with points added so no segment is longer than `step`; corners kept. */
export function densify(points: EN[], step = STEP): EN[] {
  const out: EN[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) {
      const a = points[i - 1]!;
      const len = Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (len < 1e-6) continue;
      const pieces = Math.ceil(len / step);
      for (let k = 1; k < pieces; k++) {
        const t = k / pieces;
        out.push([a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t]);
      }
    }
    out.push(p);
  }
  return out;
}

/**
 * Per point: the distance along the line, and the unit offset to the right (east of a
 * line heading north) scaled so both edges stay `half` from each segment at a corner
 * (mitred, at most MITRE_LIMIT).
 */
export function stripFrame(points: EN[]): { u: number[]; right: EN[] } {
  const u = [0];
  const dirs: EN[] = [];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    u.push(u[i - 1]! + len);
    dirs.push([(b[0] - a[0]) / len, (b[1] - a[1]) / len]);
  }
  const right = points.map((_, i): EN => {
    const d0 = dirs[Math.max(i - 1, 0)]!;
    const d1 = dirs[Math.min(i, dirs.length - 1)]!;
    let [de, dn] = [d0[0] + d1[0], d0[1] + d1[1]];
    const len = Math.hypot(de, dn);
    if (len < 1e-6) [de, dn] = d1;
    else [de, dn] = [de / len, dn / len];
    // Right of (de, dn) is (dn, -de); mitre by 1 / cos of the half-angle.
    const cos = de * d1[0] + dn * d1[1];
    const k = Math.min(1 / Math.max(cos, 1e-6), MITRE_LIMIT);
    return [dn * k, -de * k];
  });
  return { u, right };
}

/**
 * Deck heights along a bridge: a straight line between its ends' ground heights, never
 * closer than DECK_CLEARANCE to the ground under it (easing in over DECK_EASE from each
 * end, which meets the road on the ground).
 */
export function deckHeights(u: number[], ground: number[]): number[] {
  const total = u[u.length - 1] || 1;
  const a = ground[0]!;
  const b = ground[ground.length - 1]!;
  return u.map((d, i) => {
    const ease = Math.min(1, Math.min(d, total - d) / DECK_EASE);
    return Math.max(a + ((b - a) * d) / total, ground[i]! + DECK_CLEARANCE * ease);
  });
}

/** Index ranges [i0, i1] (inclusive, sharing their ends) of at most `size` points. */
export function chunks(count: number, size = CHUNK): [number, number][] {
  const out: [number, number][] = [];
  for (let i0 = 0; i0 < count - 1; i0 += size - 1)
    out.push([i0, Math.min(i0 + size - 1, count - 1)]);
  return out;
}

/** The tile (column, row) a point is in. */
export function tileOf(east: number, north: number): [number, number] {
  return [Math.floor(east / TILE), Math.floor(north / TILE)];
}

/** The lines a road shows in the world: none in a tunnel or under the snow. */
export function drawnLines(road: Road): [number, number][][] {
  if (road.structure === 'tunnel' || road.winter !== 'cleared') return [];
  return road.drawn ?? [road.line];
}

/** A piece of a road's strip, ready to mesh: its points share a tile. */
interface Strip {
  pts: EN[];
  right: EN[];
  u: number[];
  half: number;
  flags: number;
  /** Fixed heights (a bridge deck); else draped on the ground. */
  deck: number[] | null;
  /** Round caps at the line's real ends (not where it's cut into chunks). */
  capStart: boolean;
  capEnd: boolean;
}

interface Tile {
  col: number;
  row: number;
  strips: Strip[];
  banks: EN[][];
  poles: EN[];
  surface: Mesh | null;
  detail: Mesh | null;
}

/** Triangles of a road's surface, with the `road` attribute (u, v, half, flags). */
class SurfaceBuilder {
  readonly positions: number[] = [];
  readonly road: number[] = [];
  readonly index: number[] = [];

  vertex(e: number, y: number, n: number, u: number, v: number, half: number, flags: number) {
    this.positions.push(e, y, -n);
    this.road.push(u, v, half, flags);
    return this.positions.length / 3 - 1;
  }

  strip(s: Strip, ground: Ground): void {
    const across = s.half > 4 ? [-1, -0.5, 0, 0.5, 1] : [-1, 0, 1];
    const rows: number[][] = [];
    s.pts.forEach(([e, n], i) => {
      const [re, rn] = s.right[i]!;
      rows.push(
        across.map((t) => {
          const v = t * s.half;
          const pe = e + re * v;
          const pn = n + rn * v;
          const y = s.deck ? s.deck[i]! : ground(pe, pn) + ROAD_LIFT;
          return this.vertex(pe, y, pn, s.u[i]!, v, s.half, s.flags);
        }),
      );
    });
    for (let i = 0; i + 1 < rows.length; i++) {
      for (let j = 0; j + 1 < across.length; j++) {
        const [a, b, c, d] = [
          rows[i]![j]!,
          rows[i]![j + 1]!,
          rows[i + 1]![j + 1]!,
          rows[i + 1]![j]!,
        ];
        this.index.push(a, b, c, a, c, d);
      }
    }
    if (s.deck) this.deckSides(s);
    if (s.capStart) this.cap(s, 0, ground);
    if (s.capEnd) this.cap(s, s.pts.length - 1, ground);
  }

  /** Concrete sides of a deck, DECK_DEPTH deep, and its underside. */
  private deckSides(s: Strip): void {
    const flags = s.flags | FLAG.side;
    const edge = (i: number, side: number, drop: number) => {
      const [e, n] = s.pts[i]!;
      const [re, rn] = s.right[i]!;
      return this.vertex(
        e + re * side * s.half,
        s.deck![i]! - drop,
        n + rn * side * s.half,
        s.u[i]!,
        side * s.half,
        s.half,
        flags,
      );
    };
    for (let i = 0; i + 1 < s.pts.length; i++) {
      for (const side of [-1, 1]) {
        const [a, b, c, d] = [
          edge(i, side, 0),
          edge(i + 1, side, 0),
          edge(i + 1, side, DECK_DEPTH),
          edge(i, side, DECK_DEPTH),
        ];
        this.index.push(a, b, c, a, c, d);
      }
      const [a, b, c, d] = [
        edge(i, -1, DECK_DEPTH),
        edge(i, 1, DECK_DEPTH),
        edge(i + 1, 1, DECK_DEPTH),
        edge(i + 1, -1, DECK_DEPTH),
      ];
      this.index.push(a, c, b, a, d, c);
    }
  }

  /** A round end, so ways meeting at an angle leave no wedge between them. */
  private cap(s: Strip, i: number, ground: Ground): void {
    const [e, n] = s.pts[i]!;
    const y = (pe: number, pn: number) => (s.deck ? s.deck[i]! : ground(pe, pn) + ROAD_LIFT);
    const centre = this.vertex(e, y(e, n), n, s.u[i]!, 0, s.half, s.flags);
    const sides = 10;
    const rim: number[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const pe = e + Math.cos(a) * s.half;
      const pn = n + Math.sin(a) * s.half;
      rim.push(this.vertex(pe, y(pe, pn), pn, s.u[i]!, s.half, s.half, s.flags));
    }
    for (let k = 0; k < sides; k++) this.index.push(centre, rim[k]!, rim[k + 1]!);
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute('road', new BufferAttribute(new Float32Array(this.road), 4));
    g.setIndex(this.index);
    g.computeVertexNormals();
    return g;
  }
}

/** A snowbank along `points`: a rounded windrow, its ends tapering (one-sided faces). */
function snowbank(b: Builder, points: EN[], ground: Ground): void {
  const pts = densify(points, STEP);
  if (pts.length < 2) return;
  const { u, right } = stripFrame(pts);
  const length = u[u.length - 1]!;
  const { base, top, height, taper } = ROAD_BANK;
  const section = (i: number) => {
    const [e, n] = pts[i]!;
    const [re, rn] = right[i]!;
    const g = ground(e, n);
    const k = Math.min(1, Math.min(u[i]!, length - u[i]!) / taper);
    const h = height * (0.35 + 0.65 * k);
    const shape: [number, number][] = [
      [-base / 2, -0.3],
      [-base * 0.32, h * 0.55],
      [-top / 2, h * 0.95],
      [top / 2, h * 0.95],
      [base * 0.32, h * 0.55],
      [base / 2, -0.3],
    ];
    return shape.map(([v, y]) => [e + re * v, g + y, n + rn * v]);
  };
  let prev = section(0);
  for (let i = 1; i < pts.length; i++) {
    const next = section(i);
    for (let k = 0; k + 1 < prev.length; k++) {
      // Grimier low down, where the plough throws the road's slush.
      const colour = k === 0 || k === prev.length - 2 ? BANK_DIRTY : BANK;
      b.quad(prev[k]!, next[k]!, next[k + 1]!, prev[k + 1]!, colour);
    }
    prev = next;
  }
}

function pole(b: Builder, [e, n]: EN, ground: Ground): void {
  const g = ground(e, n);
  const { height, radius } = SNOW_POLE;
  const bands: [number, number, RGB][] = [
    [-0.3, height * 0.7, POLE],
    [height * 0.7, height * 0.8, POLE_BAND],
    [height * 0.8, height * 0.9, POLE],
    [height * 0.9, height, POLE_BAND],
  ];
  for (const [y0, y1, colour] of bands) b.column(e, n, g + y0, g + y1, radius, radius, colour, 5);
}

/** What the road surface material samples to give way to the pistes. */
export interface RoadShading {
  /** The terrain's piste overlay (A coverage) and unprepared share, and the grid their UVs
   *  follow (the near heightmap's, exactly as the terrain material samples them). */
  overlay: Texture;
  ungroomed?: Texture;
  grid: { west: number; north: number; cellSize: number; width: number; height: number };
}

/**
 * Wet, dark asphalt with grimy slush along the edges and a worn centre line on main
 * roads; concrete on deck sides. Where the piste overlay covers the road, the road isn't
 * drawn: in winter the run's snow is on top. Moved toward the camera by `depthBias`.
 */
export function createRoadMaterial(shading: RoadShading): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ side: DoubleSide });
  const road = attribute('road', 'vec4');
  const u = road.x;
  const v = road.y;
  const half = road.z;
  const flags = road.w;
  const centreLine = fract(flags.mul(0.5)).mul(2).round();
  const bridge = fract(flags.mul(0.25)).mul(2).floor();
  const side = step(3.5, flags);
  const toCamera = cameraPosition.sub(positionLocal);
  const distance = toCamera.length();
  material.positionNode = positionLocal.add(
    toCamera.div(distance).mul(distance.mul(0.002).add(0.05)),
  );
  const { grid } = shading;
  const uv = vec2(
    positionGeometry.x.sub(grid.west).div(grid.cellSize).add(0.5).div(grid.width),
    positionGeometry.z.add(grid.north).div(grid.cellSize).add(0.5).div(grid.height),
  );
  const ground = vec3(positionGeometry.x, 0, positionGeometry.z);
  const grain = mx_noise_float(ground.mul(0.35));
  const patches = mx_noise_float(ground.mul(0.04));
  const across = abs(v);
  // Tyre tracks: a little darker and glossier, where the slush has been driven off.
  const track = smoothstep(0.2, 0.9, abs(across.sub(half.mul(0.5))))
    .oneMinus()
    .mul(0.6);
  const slush = smoothstep(half.sub(0.7).add(patches.mul(0.25)), half.sub(0.05), across);
  const dash = step(fract(u.div(12)), float(0.45));
  const paint = centreLine
    .mul(step(across, float(0.07)))
    .mul(dash)
    .mul(0.8);
  material.colorNode = Fn(() => {
    if (shading.overlay) {
      const coverage = texture(shading.overlay, uv).a;
      const groomed = shading.ungroomed
        ? coverage.sub(texture(shading.ungroomed, uv).r).max(0)
        : coverage;
      Discard(groomed.greaterThan(PISTE_CUT).and(bridge.lessThan(0.5)));
    }
    const asphalt = ASPHALT.mul(grain.mul(0.15).add(patches.mul(0.12)).add(1)).mul(
      track.mul(-0.2).add(1),
    );
    const surface = mix(mix(asphalt, LINE_PAINT, paint), SLUSH, slush.mul(0.85));
    return mix(surface, CONCRETE, side);
  })();
  material.roughnessNode = mix(
    mix(float(0.74).sub(track.mul(0.14)).add(grain.mul(0.06)), float(0.85), slush),
    float(0.9),
    side,
  );
  material.metalness = 0;
  return material;
}

export interface RoadOptions {
  /** Road surfaces are drawn within this distance (m); the terrain shades them beyond. */
  range: number;
  /** Snowbanks and snow poles within this. */
  detailRange: number;
}

/**
 * The roads you see: cleared asphalt (snow-covered roads are the terrain shader's packed
 * snow), bridge decks, snowbanks and snow poles, built in TILE squares as the camera comes
 * within range and dropped again behind it. Two draw calls per tile in range.
 */
export class RoadNetwork {
  readonly root = new Group();
  private readonly tiles = new Map<string, Tile>();
  private readonly material: MeshStandardNodeMaterial;
  private readonly detailMaterial = new MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.9,
    side: DoubleSide,
  });

  constructor(
    data: Roads,
    private readonly ground: Ground,
    shading: RoadShading,
    private readonly options: RoadOptions,
  ) {
    this.root.name = 'roads';
    this.material = createRoadMaterial(shading);
    for (const road of data.roads) this.addRoad(road);
    for (const bank of data.snowbanks) {
      const mid = bank[Math.floor(bank.length / 2)]!;
      this.tile(mid[0], mid[1]).banks.push(bank);
    }
    for (const p of data.poles) this.tile(p[0], p[1]).poles.push(p);
  }

  /** Tiles built so far (for tests and profiling). */
  get built(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.surface ? 1 : 0;
    return n;
  }

  private tile(east: number, north: number): Tile {
    const [col, row] = tileOf(east, north);
    const key = `${col},${row}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { col, row, strips: [], banks: [], poles: [], surface: null, detail: null };
      this.tiles.set(key, t);
    }
    return t;
  }

  private addRoad(road: Road): void {
    const centre = CENTRE_LINE_CLASSES.has(road.class) && road.width >= CENTRE_LINE_MIN_WIDTH;
    const bridge = road.structure === 'bridge';
    const flags = (centre ? FLAG.centreLine : 0) | (bridge ? FLAG.bridge : 0);
    for (const line of drawnLines(road)) {
      const pts = densify(line);
      if (pts.length < 2) continue;
      const { u, right } = stripFrame(pts);
      const deck = bridge
        ? deckHeights(
            u,
            pts.map(([e, n]) => this.ground(e, n)),
          ).map((h) => h + ROAD_LIFT)
        : null;
      const ranges = chunks(pts.length);
      ranges.forEach(([i0, i1], k) => {
        const mid = pts[Math.floor((i0 + i1) / 2)]!;
        this.tile(mid[0], mid[1]).strips.push({
          pts: pts.slice(i0, i1 + 1),
          right: right.slice(i0, i1 + 1),
          u: u.slice(i0, i1 + 1),
          half: road.width / 2,
          flags,
          deck: deck ? deck.slice(i0, i1 + 1) : null,
          capStart: k === 0 && !bridge,
          capEnd: k === ranges.length - 1 && !bridge,
        });
      });
    }
  }

  /**
   * Shows the tiles in range of the camera (world position), building at most `budget`
   * new meshes, nearest first, and drops those well out of range.
   */
  update(camera: Vector3, budget = 2): void {
    const east = camera.x;
    const north = -camera.z;
    const { range, detailRange } = this.options;
    const pending: { tile: Tile; d: number; detail: boolean }[] = [];
    for (const t of this.tiles.values()) {
      const de = Math.max(t.col * TILE - east, 0, east - (t.col + 1) * TILE);
      const dn = Math.max(t.row * TILE - north, 0, north - (t.row + 1) * TILE);
      const d = Math.hypot(de, dn);
      this.keep(t, 'surface', d, range, pending);
      this.keep(t, 'detail', d, detailRange, pending);
    }
    pending.sort((a, b) => a.d - b.d);
    for (const { tile, detail } of pending.slice(0, budget)) {
      if (detail) tile.detail = this.add(this.buildDetail(tile), true);
      else tile.surface = this.add(this.buildSurface(tile), false);
    }
  }

  private keep(
    t: Tile,
    kind: 'surface' | 'detail',
    d: number,
    range: number,
    pending: { tile: Tile; d: number; detail: boolean }[],
  ): void {
    const mesh = t[kind];
    const empty = kind === 'surface' ? !t.strips.length : !t.banks.length && !t.poles.length;
    if (empty) return;
    if (d < range) {
      if (mesh) mesh.visible = true;
      else pending.push({ tile: t, d, detail: kind === 'detail' });
    } else if (mesh) {
      mesh.visible = false;
      if (d > range * 1.4) {
        mesh.geometry.dispose();
        this.root.remove(mesh);
        t[kind] = null;
      }
    }
  }

  private add(geometry: BufferGeometry, detail: boolean): Mesh {
    const mesh = new Mesh(geometry, detail ? this.detailMaterial : this.material);
    mesh.name = detail ? 'road-details' : 'road-surfaces';
    // The surfaces lie on the ground (and are moved in depth): only the banks cast.
    mesh.castShadow = detail;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    return mesh;
  }

  private buildSurface(t: Tile): BufferGeometry {
    const b = new SurfaceBuilder();
    for (const s of t.strips) b.strip(s, this.ground);
    const g = b.geometry();
    g.computeBoundingSphere();
    return g;
  }

  private buildDetail(t: Tile): BufferGeometry {
    const b = new Builder();
    for (const bank of t.banks) snowbank(b, bank, this.ground);
    for (const p of t.poles) pole(b, p, this.ground);
    const g = b.geometry();
    g.computeBoundingSphere();
    return g;
  }

  dispose(): void {
    for (const t of this.tiles.values()) {
      t.surface?.geometry.dispose();
      t.detail?.geometry.dispose();
    }
    this.material.dispose();
    this.detailMaterial.dispose();
  }
}

/** Solids for the snowmobile: snowbanks (a box per piece, at most 8 m) and snow poles. */
export function roadSolids(data: Roads, ground: Ground): Solid[] {
  const out: Solid[] = [];
  const half = ROAD_BANK.base / 2 - 0.4;
  for (const points of data.snowbanks) {
    const pts = densify(points, 8);
    const { right } = stripFrame(pts);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i]!, pts[i + 1]!];
      const [ra, rb] = [right[i]!, right[i + 1]!];
      const ring: EN[] = [
        [a[0] - ra[0] * half, a[1] - ra[1] * half],
        [b[0] - rb[0] * half, b[1] - rb[1] * half],
        [b[0] + rb[0] * half, b[1] + rb[1] * half],
        [a[0] + ra[0] * half, a[1] + ra[1] * half],
      ];
      const g = ground((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      out.push({ ring, base: g - 2, top: g + ROAD_BANK.height - 0.2 });
    }
  }
  for (const [e, n] of data.poles) {
    const r = 0.12;
    const g = ground(e, n);
    out.push({
      ring: [
        [e - r, n - r],
        [e + r, n - r],
        [e + r, n + r],
        [e - r, n + r],
      ],
      base: g - 1,
      top: g + SNOW_POLE.height,
    });
  }
  return out;
}
