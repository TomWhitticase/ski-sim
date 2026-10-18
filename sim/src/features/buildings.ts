import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  ShapeUtils,
  Vector2,
} from 'three/webgpu';

import type { Building } from './types';

/** Snow-covered flat roofs. */
const ROOF: [number, number, number] = [0.93, 0.95, 0.98];
/** Alpine resort facades: timber, render and stone. */
const WALLS: [number, number, number][] = [
  [0.42, 0.29, 0.19],
  [0.3, 0.21, 0.15],
  [0.82, 0.77, 0.67],
  [0.62, 0.6, 0.57],
  [0.55, 0.42, 0.3],
];
const STATION_WALL: [number, number, number] = [0.5, 0.52, 0.55];

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

/**
 * Extruded footprints with flat roofs, merged into one mesh. Faces are wound so normals
 * point outward/upward (world: x east, y up, z = -north).
 */
export function buildBuildingGeometry(buildings: Building[]): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  const vertex = (east: number, y: number, north: number, color: [number, number, number]) => {
    positions.push(east, y, -north);
    colors.push(...color);
  };

  for (const b of buildings) {
    const ring = signedArea(b.footprint) < 0 ? [...b.footprint].reverse() : b.footprint;
    const wall = b.type === 'lift_station' ? STATION_WALL : WALLS[Math.abs(b.id) % WALLS.length]!;

    // Walls: with a counter-clockwise ring, outside is to the right of each edge.
    for (let i = 0; i < ring.length; i++) {
      const [e0, n0] = ring[i]!;
      const [e1, n1] = ring[(i + 1) % ring.length]!;
      vertex(e0, b.base, n0, wall);
      vertex(e1, b.base, n1, wall);
      vertex(e1, b.top, n1, wall);
      vertex(e0, b.base, n0, wall);
      vertex(e1, b.top, n1, wall);
      vertex(e0, b.top, n0, wall);
    }

    // Roof: triangles counter-clockwise in east/north face up in world space.
    const contour = ring.map(([e, n]) => new Vector2(e, n));
    for (const [i0, i1, i2] of ShapeUtils.triangulateShape(contour, [])) {
      const p0 = ring[i0!]!;
      let p1 = ring[i1!]!;
      let p2 = ring[i2!]!;
      const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      if (cross < 0) [p1, p2] = [p2, p1];
      vertex(p0[0], b.top, p0[1], ROOF);
      vertex(p1[0], b.top, p1[1], ROOF);
      vertex(p2[0], b.top, p2[1], ROOF);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createBuildings(buildings: Building[]): Mesh {
  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 });
  const mesh = new Mesh(buildBuildingGeometry(buildings), material);
  mesh.name = 'buildings';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
