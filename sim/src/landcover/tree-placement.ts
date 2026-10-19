// Where individual trees stand, from the pipeline's tree cover (pipeline/landcover.py).
// The cover is data; each tree's exact spot, height and species are synthetic, seeded per
// placement cell so every visit (and the collision check) sees the same forest.

/** Trees are generated and cached in square tiles of this size (m). */
export const TILE = 80;
/** One candidate tree per cell of this size (m): ~400 stems/ha at full cover. */
export const SPACING = 5;
/** Floats per tree: east, ground, north, height + 1000 * species. */
export const STRIDE = 4;
export const LARCH = 1;

export interface TreeParams {
  /** Elevation (m) below which nearly all the area's forest grows. */
  treeLine: number;
  /** Typical heights (m) in the valleys and at the tree line. */
  height: { valley: number; treeLine: number };
}

export interface TreeSource {
  /** Tree cover 0..1 at a local position. */
  cover(east: number, north: number): number;
  ground(east: number, north: number): number;
}

/** Deterministic 32-bit hash of two integers and a salt, as a float in [0, 1). */
export function hash01(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1] on a lattice of `scale` metres: clumps and glades. */
function valueNoise(east: number, north: number, scale: number, salt: number): number {
  const x = east / scale;
  const y = north / scale;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash01(x0, y0, salt);
  const b = hash01(x0 + 1, y0, salt);
  const c = hash01(x0, y0 + 1, salt);
  const d = hash01(x0 + 1, y0 + 1, salt);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Typical tree height (m) at an elevation: tall in the valleys, stunted near the tree line. */
export function typicalHeight(ground: number, p: TreeParams): number {
  const t = smoothstep(p.treeLine - 800, p.treeLine + 50, ground);
  return p.height.valley + (p.height.treeLine - p.height.valley) * t;
}

/**
 * Trees in tile (tx, ty), which covers east [tx·TILE, (tx+1)·TILE), north likewise.
 * Each SPACING cell holds at most one tree, jittered within the cell; it's kept with
 * probability cover × clumping, so forest edges thin out and dense stands have glades.
 */
export function placeTrees(tx: number, ty: number, src: TreeSource, p: TreeParams): Float32Array {
  const n = TILE / SPACING;
  const out = new Float32Array(n * n * STRIDE);
  let count = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = tx * n + i;
      const cy = ty * n + j;
      const east = (cx + 0.1 + 0.8 * hash01(cx, cy, 1)) * SPACING;
      const north = (cy + 0.1 + 0.8 * hash01(cx, cy, 2)) * SPACING;
      const cover = src.cover(east, north);
      if (cover <= 0.02) continue;
      const clump = 0.35 + 0.65 * valueNoise(east, north, 40, 7);
      if (hash01(cx, cy, 3) >= cover * clump * 1.15) continue;
      const ground = src.ground(east, north);
      const height = typicalHeight(ground, p) * (0.65 + 0.5 * hash01(cx, cy, 4));
      // Bare winter larches mix in toward the tree line.
      const larchShare = 0.3 * smoothstep(p.treeLine - 700, p.treeLine - 150, ground);
      const species = hash01(cx, cy, 5) < larchShare ? LARCH : 0;
      out[count * STRIDE] = east;
      out[count * STRIDE + 1] = ground;
      out[count * STRIDE + 2] = north;
      out[count * STRIDE + 3] = Math.round(height * 10) / 10 + 1000 * species;
      count++;
    }
  }
  return out.slice(0, count * STRIDE);
}

/** Height and species packed into a tree's 4th float. */
export function unpack(w: number): { height: number; species: number } {
  const species = Math.floor(w / 1000);
  return { height: w - species * 1000, species };
}
