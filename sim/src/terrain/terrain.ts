import { Group, Mesh, type Material, Vector3 } from 'three/webgpu';

import type { Heightmap } from '../geo/heightmap';
import type { Extent } from '../resort/manifest';
import { buildChunkGeometry, type ChunkBounds } from './chunk-geometry';

export interface TerrainOptions {
  /** Chunk size in grid cells. */
  chunkCells: number;
  /** LOD 0 uses every sample, LOD k every 2^k-th. */
  lodLevels: number;
  /** Distance (m) within which LOD 0 is used; each further doubling drops one level. */
  lodDistance: number;
  /** Chunks lying entirely inside this extent are never built. */
  skip?: Extent;
}

interface Chunk extends ChunkBounds {
  min: Vector3;
  max: Vector3;
  lod: number;
  mesh: Mesh | null;
}

/** Heightmap terrain split into chunks, each meshed at a LOD chosen by camera distance. */
export class Terrain {
  readonly object = new Group();
  private readonly chunks: Chunk[] = [];
  private readonly closest = new Vector3();

  constructor(
    private readonly hm: Heightmap,
    private readonly material: Material,
    private readonly options: TerrainOptions,
  ) {
    const { chunkCells } = options;
    for (let row0 = 0; row0 < hm.height - 1; row0 += chunkCells) {
      for (let col0 = 0; col0 < hm.width - 1; col0 += chunkCells) {
        const col1 = Math.min(col0 + chunkCells, hm.width - 1);
        const row1 = Math.min(row0 + chunkCells, hm.height - 1);
        const chunk = this.createChunk({ col0, row0, col1, row1 });
        if (!this.isSkipped(chunk)) this.chunks.push(chunk);
      }
    }
  }

  /**
   * Re-meshes chunks whose LOD should change, nearest first, until `budgetMs` is spent.
   * Pass Infinity to bring every chunk up to date (e.g. before the first frame).
   */
  update(camera: Vector3, budgetMs: number): void {
    const pending: { chunk: Chunk; lod: number; distance: number }[] = [];
    for (const chunk of this.chunks) {
      const distance = this.closest.copy(camera).clamp(chunk.min, chunk.max).distanceTo(camera);
      const lod = this.lodFor(distance);
      if (lod !== chunk.lod) pending.push({ chunk, lod, distance });
    }
    pending.sort((a, b) => a.distance - b.distance);

    const start = performance.now();
    for (const { chunk, lod } of pending) {
      this.remesh(chunk, lod);
      if (performance.now() - start > budgetMs) break;
    }
  }

  dispose(): void {
    for (const chunk of this.chunks) chunk.mesh?.geometry.dispose();
  }

  private lodFor(distance: number): number {
    const level = Math.floor(Math.log2(Math.max(distance, 1) / this.options.lodDistance)) + 1;
    return Math.min(Math.max(level, 0), this.options.lodLevels - 1);
  }

  private remesh(chunk: Chunk, lod: number): void {
    const stride = 2 ** lod;
    // Deep enough to cover LOD seams and the dipped edge of a coarser layer beneath.
    const skirtDepth = 50 + stride * this.hm.cellSize;
    const { geometry, centerX, centerZ } = buildChunkGeometry(this.hm, chunk, stride, skirtDepth);
    if (chunk.mesh) {
      chunk.mesh.geometry.dispose();
      chunk.mesh.geometry = geometry;
    } else {
      chunk.mesh = new Mesh(geometry, this.material);
      chunk.mesh.castShadow = true;
      chunk.mesh.receiveShadow = true;
      chunk.mesh.matrixAutoUpdate = false;
      this.object.add(chunk.mesh);
    }
    chunk.mesh.position.set(centerX, 0, centerZ);
    chunk.mesh.updateMatrix();
    chunk.lod = lod;
  }

  private createChunk(bounds: ChunkBounds): Chunk {
    const { hm } = this;
    let minH = Infinity;
    let maxH = -Infinity;
    for (let row = bounds.row0; row <= bounds.row1; row++) {
      for (let col = bounds.col0; col <= bounds.col1; col++) {
        const h = hm.at(col, row);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    const { west, north } = hm.extent;
    const cell = hm.cellSize;
    return {
      ...bounds,
      // World z is -north, so the northern edge (row0) has the smaller z.
      min: new Vector3(west + bounds.col0 * cell, minH, -(north - bounds.row0 * cell)),
      max: new Vector3(west + bounds.col1 * cell, maxH, -(north - bounds.row1 * cell)),
      lod: -1,
      mesh: null,
    };
  }

  private isSkipped(chunk: Chunk): boolean {
    const skip = this.options.skip;
    if (!skip) return false;
    // Skipped only if fully contained. The chunk's north edge is at -min.z, south at -max.z.
    return (
      chunk.min.x >= skip.west &&
      chunk.max.x <= skip.east &&
      -chunk.min.z <= skip.north &&
      -chunk.max.z >= skip.south
    );
  }
}
