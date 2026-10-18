import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat } from 'three/webgpu';

import type { Heightmap } from '../geo/heightmap';

/**
 * Upward surface normal at a grid sample, in world axes (x east, y up, z south),
 * from central differences (one-sided at the grid edge).
 */
export function normalAt(hm: Heightmap, col: number, row: number, out: Float32Array, i: number) {
  const cl = col > 0 ? col - 1 : col;
  const cr = col < hm.width - 1 ? col + 1 : col;
  const rn = row > 0 ? row - 1 : row; // the row to the north
  const rs = row < hm.height - 1 ? row + 1 : row;
  const dhdEast = (hm.at(cr, row) - hm.at(cl, row)) / ((cr - cl) * hm.cellSize);
  const dhdNorth = (hm.at(col, rn) - hm.at(col, rs)) / ((rs - rn) * hm.cellSize);
  const len = Math.hypot(dhdEast, 1, dhdNorth);
  out[i] = -dhdEast / len;
  out[i + 1] = 1 / len;
  out[i + 2] = dhdNorth / len;
}

/**
 * Full-resolution normal map. Lets low-LOD geometry be lit with full-resolution detail.
 * Texel (col, row) matches heightmap sample (col, row); RGB = normal * 0.5 + 0.5.
 */
export function createNormalTexture(hm: Heightmap): DataTexture {
  const pixels = new Uint8Array(hm.width * hm.height * 4);
  const n = new Float32Array(3);
  for (let row = 0; row < hm.height; row++) {
    for (let col = 0; col < hm.width; col++) {
      normalAt(hm, col, row, n, 0);
      const p = (row * hm.width + col) * 4;
      pixels[p] = (n[0]! * 0.5 + 0.5) * 255;
      pixels[p + 1] = (n[1]! * 0.5 + 0.5) * 255;
      pixels[p + 2] = (n[2]! * 0.5 + 0.5) * 255;
      pixels[p + 3] = 255;
    }
  }
  const texture = new DataTexture(pixels, hm.width, hm.height, RGBAFormat);
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
