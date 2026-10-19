import {
  attribute,
  cameraPosition,
  positionWorld,
  float,
  fract,
  mix,
  mx_noise_float,
  select,
  smoothstep,
  step,
  vec3,
} from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  ShapeUtils,
  Vector2,
} from 'three/webgpu';

import type { Building } from './types';

/** Facade styles, chosen per building and drawn by the shader. Huts (mountain
 *  restaurants) carry a shutter colour variant in the fraction: 4, 4.25, 4.5. */
export const STYLE = { chalet: 0, render: 1, stone: 2, metal: 3, hut: 4, trim: 5 } as const;
/** Roof thickness shown at the eaves (fascia and soffit), m. */
const ROOF_THICKNESS = 0.28;

/** Signed area of a ring in the east/north plane; positive when counter-clockwise. */
export function signedArea(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

export function facadeStyle(b: Building): number {
  if (b.use === 'restaurant') return STYLE.hut + (Math.abs(b.id) % 3) * 0.25;
  const area = Math.abs(signedArea(b.footprint));
  const t = b.type ?? 'yes';
  if (['lift_station', 'industrial', 'warehouse', 'garage', 'garages', 'service'].includes(t))
    return STYLE.metal;
  if (t === 'church' || t === 'chapel' || t === 'ruins') return STYLE.stone;
  // Big blocks are rendered with timber balconies; smaller ones are timber chalets.
  if (area > 450) return Math.abs(b.id) % 3 === 0 ? STYLE.chalet : STYLE.render;
  return STYLE.chalet;
}

/** Height of the roof (or flat top) above the point. Eaves continue the roof planes
 *  down past the wall tops. */
export function roofHeight(b: Building, e: number, n: number): number {
  const roof = b.roof;
  if (!roof) return b.top;
  const [[ax, ay], [bx, by]] = roof.ridge;
  const len = Math.hypot(bx - ax, by - ay);
  const d = Math.abs((bx - ax) * (ay - n) - (ax - e) * (by - ay)) / len;
  const k = 1 - d / roof.halfWidth;
  return b.top + roof.rise * (roof.eaves ? k : Math.max(0, k));
}

/** Signed side of the ridge line a point is on. */
function ridgeSide(b: Building, e: number, n: number): number {
  const [[ax, ay], [bx, by]] = b.roof!.ridge;
  return (bx - ax) * (n - ay) - (by - ay) * (e - ax);
}

/**
 * Extruded footprints with gable or flat roofs, merged into one mesh. Each vertex
 * carries `facade` = (metres along the wall, metres above the base, style, wall) for the
 * facade shader, where wall is 0 for roofs and 1 + the stone footing's height for walls. Faces are wound outward/upward (world z = -north).
 */
export function buildBuildingGeometry(buildings: Building[]): BufferGeometry {
  const positions: number[] = [];
  const facade: number[] = [];

  const vertex = (
    e: number,
    y: number,
    n: number,
    u: number,
    v: number,
    style: number,
    wall: number,
  ) => {
    positions.push(e, y, -n);
    facade.push(u, v, style, wall);
  };

  for (const b of buildings) {
    const ring = signedArea(b.footprint) < 0 ? [...b.footprint].reverse() : b.footprint;
    const style = facadeStyle(b);
    const wall = 1 + (b.footing ?? 0);

    // Walls, splitting any edge that crosses the ridge so gable ends peak correctly.
    let u = 0;
    for (let i = 0; i < ring.length; i++) {
      const p0 = ring[i]!;
      const p1 = ring[(i + 1) % ring.length]!;
      const points: [number, number][] = [p0];
      if (b.roof) {
        const s0 = ridgeSide(b, ...p0);
        const s1 = ridgeSide(b, ...p1);
        if (s0 * s1 < 0) {
          const t = s0 / (s0 - s1);
          points.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]);
        }
      }
      points.push(p1);
      for (let k = 0; k < points.length - 1; k++) {
        const [e0, n0] = points[k]!;
        const [e1, n1] = points[k + 1]!;
        const len = Math.hypot(e1 - e0, n1 - n0);
        const h0 = roofHeight(b, e0, n0);
        const h1 = roofHeight(b, e1, n1);
        const u1 = u + len;
        // With a counter-clockwise ring, outside is to the right of each edge.
        vertex(e0, b.base, n0, u, 0, style, wall);
        vertex(e1, b.base, n1, u1, 0, style, wall);
        vertex(e1, h1, n1, u1, h1 - b.base, style, wall);
        vertex(e0, b.base, n0, u, 0, style, wall);
        vertex(e1, h1, n1, u1, h1 - b.base, style, wall);
        vertex(e0, h0, n0, u, h0 - b.base, style, wall);
        u = u1;
      }
    }

    // Raised pieces (left above a station, walkway or cable cut) need an underside.
    if (b.raised) {
      const contour = ring.map(([e, n]) => new Vector2(e, n));
      for (const [i0, i1, i2] of ShapeUtils.triangulateShape(contour, [])) {
        const p0 = ring[i0!]!;
        let p1 = ring[i1!]!;
        let p2 = ring[i2!]!;
        const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
        if (cross > 0) [p1, p2] = [p2, p1]; // clockwise from above: faces down
        for (const [e, n] of [p0, p1, p2]) vertex(e, b.base, n, e, 0.5, STYLE.render, 1);
      }
    }

    // Roof: each face is planar, so triangulate it and lift the vertices onto the roof.
    const faces = b.roof ? b.roof.faces : [ring];
    for (const face of faces) {
      const contour = face.map(([e, n]) => new Vector2(e, n));
      for (const [i0, i1, i2] of ShapeUtils.triangulateShape(contour, [])) {
        const p0 = face[i0!]!;
        let p1 = face[i1!]!;
        let p2 = face[i2!]!;
        const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
        if (cross < 0) [p1, p2] = [p2, p1];
        for (const [e, n] of [p0, p1, p2]) vertex(e, roofHeight(b, e, n), n, e, n, style, 0);
        // Overhanging roofs are seen from below: a timber soffit under the eaves.
        if (b.roof?.eaves) {
          for (const [e, n] of [p0, p2, p1]) {
            vertex(e, roofHeight(b, e, n) - ROOF_THICKNESS, n, e, 0, STYLE.trim, 1);
          }
        }
      }
      if (b.roof?.eaves) roofEdge(b, face, vertex);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('facade', new BufferAttribute(new Float32Array(facade), 4));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The fascia: the roof's edge, all round the eaves (not along the ridge split). */
function roofEdge(
  b: Building,
  face: [number, number][],
  vertex: (e: number, y: number, n: number, u: number, v: number, s: number, w: number) => void,
): void {
  const ring = signedArea(face) < 0 ? [...face].reverse() : face;
  for (let i = 0; i < ring.length; i++) {
    const [e0, n0] = ring[i]!;
    const [e1, n1] = ring[(i + 1) % ring.length]!;
    if (Math.abs(ridgeSide(b, e0, n0)) < 1e-3 && Math.abs(ridgeSide(b, e1, n1)) < 1e-3) continue;
    const h0 = roofHeight(b, e0, n0);
    const h1 = roofHeight(b, e1, n1);
    const t = ROOF_THICKNESS;
    vertex(e0, h0 - t, n0, 0, 0, STYLE.trim, 1);
    vertex(e1, h1 - t, n1, 0, 0, STYLE.trim, 1);
    vertex(e1, h1, n1, 0, 0, STYLE.trim, 1);
    vertex(e0, h0 - t, n0, 0, 0, STYLE.trim, 1);
    vertex(e1, h1, n1, 0, 0, STYLE.trim, 1);
    vertex(e0, h0, n0, 0, 0, STYLE.trim, 1);
  }
}

/**
 * Facade shader: no textures, everything procedural from the `facade` attribute, so a
 * whole resort of buildings is still a single draw call.
 */
export function createBuildingMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.85 });
  const f = attribute<'vec4'>('facade', 'vec4');
  const u = f.x;
  const v = f.y;
  const style = f.z;
  const isWall = step(0.5, f.w);
  // Walls of huts on a slope: stone up to the uphill ground (a basement storey).
  const footing = f.w.sub(1).max(1.3);

  const storey = float(2.9);
  const bay = float(3.2);
  const level = fract(v.div(storey));
  const column = fract(u.div(bay));
  // Window openings: within each storey and bay, above the plinth.
  const inWindow = step(0.32, level)
    .mul(step(level, 0.82))
    .mul(step(0.22, column))
    .mul(step(column, 0.78))
    .mul(step(2.2, v));
  const frame = inWindow.mul(
    float(1).sub(
      step(0.36, level).mul(step(level, 0.78)).mul(step(0.26, column)).mul(step(column, 0.74)),
    ),
  );
  const balcony = step(level, 0.07).mul(step(3.5, v)); // timber balcony band at each floor
  const plinth = step(v, 2.4); // stone ground floor

  const grain = mx_noise_float(vec3(u.mul(0.5), v.mul(4), style)).mul(0.06);
  const planks = smoothstep(0.0, 0.08, fract(v.mul(5))).mul(0.06); // horizontal boards
  const ribs = smoothstep(0.0, 0.1, fract(u.mul(2.5))).mul(0.08); // metal cladding
  const boards = smoothstep(0.0, 0.07, fract(u.mul(5))).mul(0.1); // vertical hut boards
  // Sun-darkened larch: blotchier than the chalet planks.
  const weathering = mx_noise_float(vec3(u.mul(0.15), v.mul(0.3), style.mul(7))).mul(0.12);

  const timber = vec3(0.4, 0.26, 0.15).mul(float(0.94).add(planks).add(grain));
  const renderWall = vec3(0.86, 0.81, 0.71).add(grain);
  const stoneWall = vec3(0.6, 0.58, 0.54).add(grain.mul(2));
  const metal = vec3(0.5, 0.53, 0.57).mul(float(0.92).add(ribs));
  const larch = vec3(0.3, 0.2, 0.13).mul(float(0.9).add(boards).add(weathering).add(grain));
  const darkTimber = vec3(0.22, 0.14, 0.08);
  const glass = vec3(0.1, 0.13, 0.18);
  const frameColour = vec3(0.9, 0.9, 0.88);
  const snow = vec3(0.94, 0.96, 0.99);

  const wallColour = select(
    style.lessThan(0.5),
    timber,
    select(
      style.lessThan(1.5),
      renderWall,
      select(
        style.lessThan(2.5),
        stoneWall,
        select(style.lessThan(3.5), metal, select(style.lessThan(4.9), larch, darkTimber)),
      ),
    ),
  );
  const hut = step(3.5, style).mul(step(style, 4.9));
  // Timber buildings and rendered blocks sit on stone; balconies on the residential ones.
  const residential = step(style, 1.5);
  let colour = mix(wallColour, stoneWall, plinth.mul(residential));
  colour = mix(colour, darkTimber, balcony.mul(residential));
  // Metal sheds get fewer, smaller windows.
  const windows = inWindow
    .mul(select(style.greaterThan(2.5), step(0.5, fract(u.div(bay.mul(3)))), float(1)))
    .mul(float(1).sub(step(v, footing.add(0.4)).mul(hut)));
  // Huts: a rough stone footing, and painted shutters either side of each window.
  const inFooting = step(v, footing).mul(hut);
  colour = mix(colour, stoneWall, inFooting);
  const shutterBand = step(0.32, level).mul(step(level, 0.82)).mul(step(2.2, v));
  const shutter = shutterBand
    .mul(
      step(0.07, column)
        .mul(step(column, 0.21))
        .add(step(0.79, column).mul(step(column, 0.93))),
    )
    .mul(hut);
  const variant = fract(style).mul(4);
  const shutterColour = select(
    variant.lessThan(0.5),
    vec3(0.5, 0.07, 0.06),
    select(variant.lessThan(1.5), vec3(0.1, 0.28, 0.14), vec3(0.82, 0.78, 0.7)),
  ).mul(float(0.9).add(smoothstep(0.0, 0.2, fract(v.mul(9))).mul(0.12))); // slats
  colour = mix(colour, shutterColour, shutter.mul(float(1).sub(inFooting)));
  colour = mix(colour, glass, windows);
  colour = mix(colour, frameColour, frame.mul(windows).mul(0.8));

  // Far away the window grid is smaller than a pixel and shimmers; fade it to the
  // facade's average colour (roughly a third glass) instead.
  const detail = smoothstep(380, 140, cameraPosition.distance(positionWorld));
  const average = mix(mix(wallColour, darkTimber, residential.mul(0.1)), glass, 0.3);
  colour = mix(average, colour, detail);
  material.colorNode = mix(snow, colour, isWall);
  material.roughnessNode = mix(float(0.9), mix(float(0.85), float(0.12), windows), isWall);
  material.metalnessNode = windows.mul(isWall).mul(0.4);
  return material;
}

export function createBuildings(buildings: Building[]): Mesh {
  const mesh = new Mesh(buildBuildingGeometry(buildings), createBuildingMaterial());
  mesh.name = 'buildings';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
