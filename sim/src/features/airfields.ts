import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  ShapeUtils,
  Vector2,
  Vector3,
} from 'three/webgpu';

import { helipadPaint, type Paint, ringQuads, runwayMarks } from './airfield-markings';
import type { Solid } from './obstacles';
import type { Airfields, Helipad, Runway } from './types';

type RGB = [number, number, number];
type EN = [number, number];
type Ground = (east: number, north: number) => number;

const ASPHALT: RGB = [0.16, 0.16, 0.17];
const CONCRETE: RGB = [0.42, 0.42, 0.41];
const PAINT: Record<Paint, RGB> = {
  white: [1, 1, 0.98],
  yellow: [0.93, 0.7, 0.08],
  red: [0.72, 0.07, 0.05],
};
const SNOWBANK: RGB = [0.97, 0.98, 1];
const CONE: RGB = [0.95, 0.33, 0.04];
const CONE_BAND: RGB = [0.92, 0.92, 0.9];
const POLE: RGB = [0.88, 0.88, 0.86];
const POLE_BAND: RGB = [0.75, 0.08, 0.06];

/**
 * Heights above the ground. Each kind of surface has its own layer, so where two meet or
 * overlap (a helipad on an apron, a taxiway into a runway) one is always on top and they
 * never share a plane; paint sits just above its own surface, under the next one up.
 */
export const LAYER = { apron: 0.1, taxiway: 0.14, runway: 0.18, helipad: 0.22 } as const;
export const PAINT_LIFT = 0.03;
/** Rooftop pads: just above the roof. */
const ROOF_LIFT = 0.05;
/** Draped quads are cut into pieces no longer than this, so they follow the ground. */
const DRAPE_STEP = 4;

/** Ploughed snowbank: cross-section and how its ends taper (m). */
export const SNOWBANK_SHAPE = { base: 3, top: 1, height: 1.1, taper: 2.5 } as const;
/** Edge marker cone (m). */
export const MARKER_CONE = { height: 0.75, radius: 0.22 } as const;
/** Windsock mast and sock (m); the sock is fully out at FULL_WIND m/s (15 kt). */
export const WINDSOCK = { mast: 6, length: 3.6, mouth: 0.45, tail: 0.22 } as const;
const FULL_WIND = 7.7;
const LIMP = 72; // degrees below level with no wind

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

  /** Corners counter-clockwise seen from above. */
  quad(a: number[], b: number[], c: number[], d: number[], colour: RGB): void {
    this.tri(a, b, c, colour);
    this.tri(a, c, d, colour);
  }

  /**
   * A quad lying on the ground, cut into DRAPE_STEP pieces so it follows it: `at(s, t)`
   * gives the ground point for s, t in 0..1 (s along, t across, counter-clockwise).
   */
  drape(
    at: (s: number, t: number) => EN,
    along: number,
    across: number,
    height: (e: number, n: number) => number,
    colour: RGB,
  ): void {
    const ns = Math.max(1, Math.ceil(along / DRAPE_STEP));
    const nt = Math.max(1, Math.ceil(across / DRAPE_STEP));
    const p = (i: number, j: number) => {
      const [e, n] = at(i / ns, j / nt);
      return [e, height(e, n), n];
    };
    for (let i = 0; i < ns; i++) {
      for (let j = 0; j < nt; j++) {
        this.quad(p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1), colour);
      }
    }
  }

  /**
   * A polygon lying on the ground: triangulated, then each triangle split until no edge
   * is longer than DRAPE_STEP, so it follows the ground between the mapped corners.
   */
  cap(ring: EN[], height: (e: number, n: number) => number, colour: RGB): void {
    const contour = ring.map(([e, n]) => new Vector2(e, n));
    const split = (a: EN, b: EN, c: EN, depth: number): void => {
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
      const longest = Math.max(ab, bc, ca);
      if (longest > DRAPE_STEP && depth < 14) {
        // Halve the longest edge.
        const mid = (p: EN, q: EN): EN => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (longest === ab) {
          const m = mid(a, b);
          split(a, m, c, depth + 1);
          split(m, b, c, depth + 1);
        } else if (longest === bc) {
          const m = mid(b, c);
          split(a, b, m, depth + 1);
          split(a, m, c, depth + 1);
        } else {
          const m = mid(c, a);
          split(a, b, m, depth + 1);
          split(m, b, c, depth + 1);
        }
        return;
      }
      this.tri(
        [a[0], height(a[0], a[1]), a[1]],
        [b[0], height(b[0], b[1]), b[1]],
        [c[0], height(c[0], c[1]), c[1]],
        colour,
      );
    };
    for (const [i0, i1, i2] of ShapeUtils.triangulateShape(contour, [])) {
      const a = ring[i0!]!;
      let b = ring[i1!]!;
      let c = ring[i2!]!;
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) [b, c] = [c, b];
      split(a, b, c, 0);
    }
  }

  /** An upright cylinder-ish column (`sides` faces) between two heights. */
  column(
    e: number,
    n: number,
    bottom: number,
    top: number,
    r0: number,
    r1: number,
    colour: RGB,
    sides = 8,
  ): void {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      this.quad(
        [e + Math.cos(a0) * r0, bottom, n + Math.sin(a0) * r0],
        [e + Math.cos(a1) * r0, bottom, n + Math.sin(a1) * r0],
        [e + Math.cos(a1) * r1, top, n + Math.sin(a1) * r1],
        [e + Math.cos(a0) * r1, top, n + Math.sin(a0) * r1],
        colour,
      );
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colours), 3));
    g.computeVertexNormals();
    return g;
  }
}

/** A point along a polyline and its unit direction there, at distance `u` from its start. */
export class Polyline {
  readonly length: number;
  private readonly cum: number[] = [0];

  constructor(readonly points: EN[]) {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1]!, points[i]!];
      this.cum.push(this.cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    this.length = this.cum[this.cum.length - 1]!;
  }

  /** Position `v` metres to the right of the line at `u` metres along it. */
  at(u: number, v = 0): EN {
    const { points, cum } = this;
    let i = 1;
    while (i < points.length - 1 && cum[i]! < u) i++;
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = cum[i]! - cum[i - 1]! || 1;
    const t = (u - cum[i - 1]!) / len;
    const de = (b[0] - a[0]) / len;
    const dn = (b[1] - a[1]) / len;
    // Right of the direction (de, dn) is (dn, -de).
    return [a[0] + (b[0] - a[0]) * t + dn * v, a[1] + (b[1] - a[1]) * t - de * v];
  }
}

function runway(b: Builder, r: Runway, ground: Ground): void {
  const line = new Polyline(r.line);
  const half = r.width / 2;
  const surface = (e: number, n: number) => ground(e, n) + LAYER.runway;
  const paint = (e: number, n: number) => ground(e, n) + LAYER.runway + PAINT_LIFT;
  if (r.winter !== 'cleared') return; // a groomed snow runway: the snow, and its markers
  b.drape(
    (s, t) => line.at(s * line.length, half - 2 * half * t),
    line.length,
    r.width,
    surface,
    ASPHALT,
  );
  for (const m of runwayMarks(line.length, r.width, r.designators)) {
    b.drape(
      (s, t) => line.at(m.u0 + (m.u1 - m.u0) * s, m.v1 - (m.v1 - m.v0) * t),
      m.u1 - m.u0,
      m.v1 - m.v0,
      paint,
      PAINT[m.paint],
    );
  }
}

function helipad(b: Builder, p: Helipad, ground: Ground): void {
  const snow = p.winter !== 'cleared';
  const base = (e: number, n: number) => (p.roof ? p.top : ground(e, n));
  const lift = p.roof ? ROOF_LIFT : LAYER.helipad;
  const surface = (e: number, n: number) => base(e, n) + lift;
  const paint = (e: number, n: number) => base(e, n) + lift + PAINT_LIFT;
  // Pad frame: x across, y along the heading.
  const t = (p.heading * Math.PI) / 180;
  const [ye, yn] = [Math.sin(t), Math.cos(t)];
  const [xe, xn] = [yn, -ye];
  const to = (x: number, y: number): EN => [p.east + xe * x + ye * y, p.north + xn * x + yn * y];
  const half = p.size / 2;
  if (!snow) {
    if (p.shape === 'circle') {
      const ring: EN[] = [];
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        ring.push(to(Math.cos(a) * half, Math.sin(a) * half));
      }
      b.cap(ring, surface, CONCRETE);
    } else {
      b.drape(
        (s, u) => to(-half + 2 * half * s, -half + 2 * half * u),
        p.size,
        p.size,
        surface,
        CONCRETE,
      );
    }
  }
  const pad = helipadPaint(p.size, snow);
  for (const m of pad.h) {
    b.drape(
      (s, u) => to(m.x0 + (m.x1 - m.x0) * s, m.y0 + (m.y1 - m.y0) * u),
      m.x1 - m.x0,
      m.y1 - m.y0,
      paint,
      PAINT[m.paint],
    );
  }
  const quad = (q: [number, number][], colour: RGB) => {
    const pts = q.map(([x, y]) => {
      const [e, n] = to(x, y);
      return [e, paint(e, n), n];
    });
    b.quad(pts[0]!, pts[1]!, pts[2]!, pts[3]!, colour);
  };
  for (const q of ringQuads(pad.circle.radius, pad.circle.width)) {
    quad(q, PAINT[snow ? 'red' : 'yellow']);
  }
  if (pad.perimeter) {
    const { half: h, width: w } = pad.perimeter;
    if (p.shape === 'circle') {
      for (const q of ringQuads(h, w, 40)) quad(q, PAINT.white);
    } else {
      const sides: [number, number, number, number][] = [
        [-h - w, h + w, h, h + w],
        [-h - w, h + w, -h - w, -h],
        [-h - w, -h, -h, h],
        [h, h + w, -h, h],
      ];
      for (const [x0, x1, y0, y1] of sides) {
        quad(
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ],
          PAINT.white,
        );
      }
    }
  }
}

/** A snowbank along `line`: a trapezoid ridge on the ground, its ends tapering down. */
function snowbank(b: Builder, points: EN[], ground: Ground): void {
  const line = new Polyline(points);
  if (line.length < 1) return;
  const { base, top, height, taper } = SNOWBANK_SHAPE;
  const steps = Math.max(1, Math.ceil(line.length / 2.5));
  const section = (i: number) => {
    const u = (line.length * i) / steps;
    const end = Math.min(u, line.length - u);
    const k = Math.min(1, end / taper);
    const h = height * (0.35 + 0.65 * k);
    // A rounded windrow: steep sides, a soft crown.
    const offsets: [number, number][] = [
      [-base / 2, -0.3],
      [-base * 0.36, h * 0.45],
      [-top / 2, h * 0.9],
      [0, h],
      [top / 2, h * 0.9],
      [base * 0.36, h * 0.45],
      [base / 2, -0.3],
    ];
    return offsets.map(([v, y]) => {
      const [e, n] = line.at(u, v);
      const [ce, cn] = line.at(u, 0);
      return [e, ground(ce, cn) + y, n];
    });
  };
  let prev = section(0);
  for (let i = 1; i <= steps; i++) {
    const next = section(i);
    for (let k = 0; k + 1 < prev.length; k++) {
      b.quad(prev[k]!, prev[k + 1]!, next[k + 1]!, next[k]!, SNOWBANK);
      b.quad(prev[k]!, next[k]!, next[k + 1]!, prev[k + 1]!, SNOWBANK);
    }
    prev = next;
  }
}

/** Snowbanks as solids: a box per piece between the line's points (at most 8 m). */
export function snowbankSolids(banks: EN[][], ground: Ground): Solid[] {
  const out: Solid[] = [];
  const half = SNOWBANK_SHAPE.base / 2 - 0.4;
  for (const points of banks) {
    const line = new Polyline(points);
    const pieces = Math.max(1, Math.ceil(line.length / 8));
    for (let k = 0; k < pieces; k++) {
      const u0 = (line.length * k) / pieces;
      const u1 = (line.length * (k + 1)) / pieces;
      const ring = [line.at(u0, -half), line.at(u1, -half), line.at(u1, half), line.at(u0, half)];
      const [e, n] = line.at((u0 + u1) / 2);
      const g = ground(e, n);
      out.push({ ring, base: g - 2, top: g + SNOWBANK_SHAPE.height - 0.2 });
    }
  }
  return out;
}

function square(e: number, n: number, r: number): EN[] {
  return [
    [e - r, n - r],
    [e + r, n - r],
    [e + r, n + r],
    [e - r, n + r],
  ];
}

/** Collision solids: snowbanks, edge markers and windsock masts. */
export function airfieldSolids(data: Airfields, ground: Ground): Solid[] {
  return [
    ...snowbankSolids(data.snowbanks, ground),
    ...data.markers.map(([e, n, g]) => ({
      ring: square(e, n, 0.25),
      base: g - 1,
      top: g + MARKER_CONE.height,
    })),
    ...data.windsocks.map((w) => ({
      ring: square(w.east, w.north, 0.2),
      base: w.ground - 1,
      top: w.ground + WINDSOCK.mast + 0.5,
    })),
  ];
}

/** The sock, along +x from its mouth at the origin: orange and white hoops. */
function sockGeometry(): BufferGeometry {
  const b = new Builder();
  const { length, mouth, tail } = WINDSOCK;
  const bands = 5;
  const sides = 12;
  for (let i = 0; i < bands; i++) {
    const x0 = (length * i) / bands;
    const x1 = (length * (i + 1)) / bands;
    const r0 = mouth + ((tail - mouth) * i) / bands;
    const r1 = mouth + ((tail - mouth) * (i + 1)) / bands;
    const colour = i % 2 ? CONE_BAND : CONE;
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      // Builder writes north as -z: give it (x, y, -z) so the sock stays along +x.
      const p = (x: number, r: number, a: number) => [x, Math.cos(a) * r, -Math.sin(a) * r];
      b.quad(p(x0, r0, a0), p(x1, r1, a0), p(x1, r1, a1), p(x0, r0, a1), colour);
    }
  }
  return b.geometry();
}

/** How a windsock hangs: its bearing (deg, downwind) and droop below level (deg). */
export function sockPose(wind: number, windFrom: number, seconds: number, id: number) {
  const out = Math.min(1, Math.max(0, wind / FULL_WIND));
  const flutter = Math.sin(seconds * 2.3 + id) * 0.6 + Math.sin(seconds * 5.1 + id * 1.7) * 0.4;
  return {
    bearing: windFrom + 180 + flutter * 6 * out,
    droop: LIMP * (1 - out) ** 1.5 + Math.abs(flutter) * 3 * out,
  };
}

export interface AirfieldMeshes {
  root: Group;
  /** Turn the socks to the wind (m/s, the direction it blows from in degrees). */
  update(wind: number, windFrom: number, seconds: number): void;
}

/**
 * Runways, taxiways, aprons and helipads (paved surfaces with their paint, or paint on
 * the snow), snowbanks, edge markers and windsock masts as one static mesh; the socks
 * as one instanced mesh that follows the wind.
 */
export function createAirfields(data: Airfields, ground: Ground): AirfieldMeshes {
  const b = new Builder();
  const apron = (e: number, n: number) => ground(e, n) + LAYER.apron;
  for (const a of data.aprons) {
    if (a.winter === 'cleared') b.cap(a.ring, apron, ASPHALT);
  }
  const surface = (e: number, n: number) => ground(e, n) + LAYER.taxiway;
  const paint = (e: number, n: number) => ground(e, n) + LAYER.taxiway + PAINT_LIFT;
  for (const t of data.taxiways) {
    if (t.winter !== 'cleared') continue;
    const line = new Polyline(t.line);
    const half = t.width / 2;
    b.drape(
      (s, v) => line.at(s * line.length, half - 2 * half * v),
      line.length,
      t.width,
      surface,
      ASPHALT,
    );
    // Yellow centreline, continuous.
    b.drape(
      (s, v) => line.at(s * line.length, 0.075 - 0.15 * v),
      line.length,
      0.15,
      paint,
      PAINT.yellow,
    );
  }
  for (const r of data.runways) runway(b, r, ground);
  for (const p of data.helipads) helipad(b, p, ground);
  for (const bank of data.snowbanks) snowbank(b, bank, ground);
  for (const [e, n, g] of data.markers) {
    const { height, radius } = MARKER_CONE;
    b.column(e, n, g - 0.1, g + height * 0.45, radius, radius * 0.55, CONE, 6);
    b.column(e, n, g + height * 0.45, g + height * 0.65, radius * 0.55, radius * 0.4, CONE_BAND, 6);
    b.column(e, n, g + height * 0.65, g + height, radius * 0.4, 0.02, CONE, 6);
  }
  for (const w of data.windsocks) {
    const bands = 6;
    for (let i = 0; i < bands; i++) {
      const y0 = w.ground - 0.5 + ((WINDSOCK.mast + 0.5) * i) / bands;
      const y1 = w.ground - 0.5 + ((WINDSOCK.mast + 0.5) * (i + 1)) / bands;
      b.column(w.east, w.north, y0, y1, 0.07, 0.06, i % 2 ? POLE_BAND : POLE, 6);
    }
  }
  const root = new Group();
  root.name = 'airfields';
  if (b.positions.length) {
    const mesh = new Mesh(
      b.geometry(),
      new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'airfield-surfaces';
    root.add(mesh);
  }
  const socks = data.windsocks.length
    ? new InstancedMesh(
        sockGeometry(),
        new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, side: DoubleSide }),
        data.windsocks.length,
      )
    : null;
  if (socks) {
    socks.castShadow = true;
    socks.name = 'windsocks';
    root.add(socks);
  }
  const m = new Matrix4();
  const q = new Quaternion();
  const euler = new Euler(0, 0, 0, 'YZX');
  const pos = new Vector3();
  const one = new Vector3(1, 1, 1);
  const update = (wind: number, windFrom: number, seconds: number) => {
    if (!socks) return;
    data.windsocks.forEach((w, i) => {
      const pose = sockPose(wind, windFrom, seconds, i);
      // +x turned to point along the bearing (east = sin, north = cos, world z = -north).
      euler.set(0, ((90 - pose.bearing) * Math.PI) / 180, (-pose.droop * Math.PI) / 180);
      q.setFromEuler(euler);
      pos.set(w.east, w.ground + WINDSOCK.mast, -w.north);
      socks.setMatrixAt(i, m.compose(pos, q, one));
    });
    socks.instanceMatrix.needsUpdate = true;
  };
  update(0, 0, 0);
  return { root, update };
}
