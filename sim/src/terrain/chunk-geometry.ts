import { BufferAttribute, BufferGeometry } from 'three/webgpu';

import type { Heightmap } from '../geo/heightmap';
import { normalAt } from './normals';

export interface ChunkBounds {
  col0: number;
  row0: number;
  col1: number;
  row1: number;
}

/** Sample indices from `start` to `end` inclusive in steps of `stride`, always including `end`. */
export function sampleIndices(start: number, end: number, stride: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i += stride) out.push(i);
  out.push(end);
  return out;
}

/**
 * Builds the mesh for one terrain chunk at a given sample stride. Vertex positions are
 * relative to `center` (world x/z) to keep float32 precision on large extents. A skirt
 * hangs `skirtDepth` metres below the edges to hide cracks against neighbouring LODs.
 */
export function buildChunkGeometry(
  hm: Heightmap,
  bounds: ChunkBounds,
  stride: number,
  skirtDepth: number,
): { geometry: BufferGeometry; centerX: number; centerZ: number } {
  const cols = sampleIndices(bounds.col0, bounds.col1, stride);
  const rows = sampleIndices(bounds.row0, bounds.row1, stride);
  const nx = cols.length;
  const nz = rows.length;
  const perimeter = 2 * (nx - 1) + 2 * (nz - 1);
  const vertexCount = nx * nz + perimeter;

  const { west, north } = hm.extent;
  const cell = hm.cellSize;
  const centerX = west + ((bounds.col0 + bounds.col1) / 2) * cell;
  const centerZ = -(north - ((bounds.row0 + bounds.row1) / 2) * cell);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  for (let j = 0; j < nz; j++) {
    const row = rows[j]!;
    const z = -(north - row * cell) - centerZ;
    for (let i = 0; i < nx; i++) {
      const col = cols[i]!;
      const v = (j * nx + i) * 3;
      positions[v] = west + col * cell - centerX;
      positions[v + 1] = hm.at(col, row);
      positions[v + 2] = z;
      normalAt(hm, col, row, normals, v);
    }
  }

  // Perimeter walked clockwise seen from above: north edge eastward, east edge southward, etc.
  const ring: number[] = [];
  for (let i = 0; i < nx - 1; i++) ring.push(i);
  for (let j = 0; j < nz - 1; j++) ring.push(j * nx + nx - 1);
  for (let i = nx - 1; i > 0; i--) ring.push((nz - 1) * nx + i);
  for (let j = nz - 1; j > 0; j--) ring.push(j * nx);

  const skirtBase = nx * nz;
  ring.forEach((top, k) => {
    const s = (skirtBase + k) * 3;
    const t = top * 3;
    positions[s] = positions[t]!;
    positions[s + 1] = positions[t + 1]! - skirtDepth;
    positions[s + 2] = positions[t + 2]!;
    normals[s] = normals[t]!;
    normals[s + 1] = normals[t + 1]!;
    normals[s + 2] = normals[t + 2]!;
  });

  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6 + perimeter * 6);
  let k = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + nx;
      const c = a + 1;
      const d = b + 1;
      indices.set([a, b, c, c, b, d], k);
      k += 6;
    }
  }
  for (let r = 0; r < perimeter; r++) {
    const p0 = ring[r]!;
    const p1 = ring[(r + 1) % perimeter]!;
    const s0 = skirtBase + r;
    const s1 = skirtBase + ((r + 1) % perimeter);
    indices.set([p0, p1, s0, p1, s1, s0], k);
    k += 6;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return { geometry, centerX, centerZ };
}
