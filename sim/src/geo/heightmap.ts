import type { Extent, HeightmapMeta } from '../resort/manifest';

/**
 * A grid-registered height grid in the local ENU frame.
 * Sample (row, col) sits at east = west + col * cellSize, north = north - row * cellSize.
 */
export class Heightmap {
  constructor(
    readonly data: Float32Array,
    readonly width: number,
    readonly height: number,
    readonly cellSize: number,
    readonly extent: Extent,
  ) {
    if (data.length !== width * height) {
      throw new Error(`Heightmap data has ${data.length} samples, expected ${width * height}`);
    }
  }

  static decode(buffer: ArrayBuffer, meta: HeightmapMeta): Heightmap {
    const raw = new Uint16Array(buffer);
    const data = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      data[i] = meta.heightOffset + raw[i]! * meta.heightScale;
    }
    return new Heightmap(data, meta.width, meta.height, meta.cellSize, meta.extent);
  }

  at(col: number, row: number): number {
    return this.data[row * this.width + col]!;
  }

  contains(east: number, north: number): boolean {
    const e = this.extent;
    return east >= e.west && east <= e.east && north >= e.south && north <= e.north;
  }

  /** Bilinear height at local coordinates, clamped to the grid edge. */
  sample(east: number, north: number): number {
    const col = clamp((east - this.extent.west) / this.cellSize, 0, this.width - 1);
    const row = clamp((this.extent.north - north) / this.cellSize, 0, this.height - 1);
    const c0 = Math.min(Math.floor(col), this.width - 2);
    const r0 = Math.min(Math.floor(row), this.height - 2);
    const fc = col - c0;
    const fr = row - r0;
    const top = this.at(c0, r0) * (1 - fc) + this.at(c0 + 1, r0) * fc;
    const bottom = this.at(c0, r0 + 1) * (1 - fc) + this.at(c0 + 1, r0 + 1) * fc;
    return top * (1 - fr) + bottom * fr;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
