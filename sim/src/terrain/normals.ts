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
  const inv = 1 / Math.sqrt(dhdEast * dhdEast + 1 + dhdNorth * dhdNorth);
  out[i] = -dhdEast * inv;
  out[i + 1] = inv;
  out[i + 2] = dhdNorth * inv;
}

/**
 * Full-resolution normal map. Lets low-LOD geometry be lit with full-resolution detail.
 * Texel (col, row) matches heightmap sample (col, row); RGB = normal * 0.5 + 0.5.
 */
export function createNormalTexture(hm: Heightmap): DataTexture {
  const { width: w, height: h, data } = hm;
  const pixels = new Uint8Array(w * h * 4);
  // Hot loop over every sample (~10M near): inline differences, avoid Math.hypot (slow).
  for (let row = 0; row < h; row++) {
    const rn = row > 0 ? row - 1 : row;
    const rs = row < h - 1 ? row + 1 : row;
    const invDy = 1 / ((rs - rn) * hm.cellSize);
    const base = row * w;
    for (let col = 0; col < w; col++) {
      const cl = col > 0 ? col - 1 : col;
      const cr = col < w - 1 ? col + 1 : col;
      const dhdEast = (data[base + cr]! - data[base + cl]!) / ((cr - cl) * hm.cellSize);
      const dhdNorth = (data[rn * w + col]! - data[rs * w + col]!) * invDy;
      const inv = 1 / Math.sqrt(dhdEast * dhdEast + 1 + dhdNorth * dhdNorth);
      const p = (base + col) * 4;
      pixels[p] = (-dhdEast * inv * 0.5 + 0.5) * 255;
      pixels[p + 1] = (inv * 0.5 + 0.5) * 255;
      pixels[p + 2] = (dhdNorth * inv * 0.5 + 0.5) * 255;
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
