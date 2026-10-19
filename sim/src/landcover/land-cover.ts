import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat } from 'three/webgpu';

import type { Extent } from '../resort/manifest';

/**
 * Land cover from the pipeline (ESA WorldCover, pipeline/landcover.py): a grid-registered
 * RGB image, row 0 = north, of the fraction of each cell covered by R tree cover (cleared
 * off pistes, lift lines and buildings), G bare rock, and B 0.5 + ½ snow & ice
 * (glaciers) − ½ water: B above 0.5 is ice, below is water.
 */
export class LandCover {
  readonly width: number;
  readonly height: number;

  constructor(
    private readonly pixels: ImageData,
    readonly cellSize: number,
    readonly extent: Extent,
  ) {
    this.width = pixels.width;
    this.height = pixels.height;
  }

  /** Tree cover 0..1 (bilinear), 0 outside the grid. */
  tree(east: number, north: number): number {
    const col = (east - this.extent.west) / this.cellSize;
    const row = (this.extent.north - north) / this.cellSize;
    if (col < 0 || row < 0 || col > this.width - 1 || row > this.height - 1) return 0;
    const c0 = Math.min(Math.floor(col), this.width - 2);
    const r0 = Math.min(Math.floor(row), this.height - 2);
    const fc = col - c0;
    const fr = row - r0;
    const d = this.pixels.data;
    const i = (r0 * this.width + c0) * 4;
    const j = i + this.width * 4;
    const top = d[i]! + (d[i + 4]! - d[i]!) * fc;
    const bottom = d[j]! + (d[j + 4]! - d[j]!) * fc;
    return (top + (bottom - top) * fr) / 255;
  }

  texture(): DataTexture {
    const texture = new DataTexture(
      new Uint8Array(this.pixels.data.buffer),
      this.width,
      this.height,
      RGBAFormat,
    );
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  }
}
