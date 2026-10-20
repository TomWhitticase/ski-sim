import { BufferAttribute, BufferGeometry, Vector3 } from 'three/webgpu';

/**
 * A snow-laden conifer, 1 m tall with its base at the origin, in stacked drooping tiers:
 * each tier's top is snow, its jagged rim fades to needles, its underside is dark. Flat
 * shaded (non-indexed). Attribute `tint` = (snow 0..1, trunk 0/1): the snow already
 * accounts for how steep each face is, so the material just paints it.
 */
export interface TreeShape {
  tiers: number;
  sides: number;
  /** Rim radius of the lowest tier, as a fraction of the height. */
  radius: number;
  /** Draw tier undersides (dark needles seen from below / the side). */
  undersides: boolean;
  trunk: boolean;
  /**
   * Snow load multiplier. Coarse shapes have fewer, steeper tiers that would hold less
   * snow and read darker than the detailed tree they stand in for at a distance, so they
   * carry more to look the same (`tree-geometry.test.ts` checks they match).
   */
  snow: number;
}

export const DETAILED: TreeShape = {
  tiers: 7,
  sides: 9,
  radius: 0.2,
  undersides: true,
  trunk: true,
  snow: 1,
};
export const SIMPLE: TreeShape = {
  tiers: 3,
  sides: 6,
  radius: 0.2,
  undersides: true,
  trunk: false,
  snow: 1.4,
};
export const MINIMAL: TreeShape = {
  tiers: 2,
  sides: 4,
  radius: 0.19,
  undersides: false,
  trunk: false,
  snow: 2,
};

const CROWN_BASE = 0.14;
/** Branch tips droop below their tier's rim by this fraction of the tier's radius. */
const DROOP = 0.18;

/** Outer radius (m) of the detailed tree's crown `y` m above the ground, for its `height`. */
export function crownRadiusAt(y: number, height: number): number {
  const f = y / height;
  const lowest = CROWN_BASE - DETAILED.radius * DROOP;
  if (f < lowest || f > 1) return 0;
  const t = Math.min(Math.max((f - CROWN_BASE) / (1 - CROWN_BASE), 0), 1);
  return DETAILED.radius * height * (1 - t);
}

/** How much of a tier's snow stays on a face with this upward normal component (0..1). */
export function snowOn(normalY: number): number {
  const t = Math.min(1, Math.max(0, normalY / 0.45));
  return t * t * (3 - 2 * t);
}

export function createTreeGeometry(shape: TreeShape): BufferGeometry {
  const positions: number[] = [];
  const tints: number[] = [];
  const edge1 = new Vector3();
  const edge2 = new Vector3();
  const tri = (
    a: Vector3,
    b: Vector3,
    c: Vector3,
    ta: number,
    tb: number,
    tc: number,
    trunk = 0,
  ) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    // Snow on upward faces of the tiers (flat shaded, so per face).
    const ny = edge1.subVectors(b, a).cross(edge2.subVectors(c, a)).normalize().y;
    const k = snowOn(ny) * shape.snow;
    const snow = (t: number) => Math.min(1, t * k);
    tints.push(snow(ta), trunk, snow(tb), trunk, snow(tc), trunk);
  };

  if (shape.trunk) {
    const r = 0.022;
    const top = CROWN_BASE + 0.12;
    for (let i = 0; i < 5; i++) {
      const a0 = (i / 5) * Math.PI * 2;
      const a1 = ((i + 1) / 5) * Math.PI * 2;
      const p0 = new Vector3(Math.cos(a0) * r, -0.05, Math.sin(a0) * r);
      const p1 = new Vector3(Math.cos(a1) * r, -0.05, Math.sin(a1) * r);
      const q0 = new Vector3(p0.x * 0.7, top, p0.z * 0.7);
      const q1 = new Vector3(p1.x * 0.7, top, p1.z * 0.7);
      tri(p0, q0, p1, 0, 0, 0, 1);
      tri(p1, q0, q1, 0, 0, 0, 1);
    }
  }

  const span = 1 - CROWN_BASE;
  for (let k = 0; k < shape.tiers; k++) {
    const t = k / shape.tiers;
    // Lower tiers are wider and spaced further apart, like a spruce.
    const rimY = CROWN_BASE + span * (1 - (1 - t) ** 1.15) * 0.92;
    const radius = shape.radius * (1 - t) ** 0.95 + 0.012;
    const tierTop = Math.min(1, rimY + (span / shape.tiers) * 1.9);
    const apex = new Vector3(0, k === shape.tiers - 1 ? 1 : tierTop, 0);
    const under = new Vector3(0, rimY + (tierTop - rimY) * 0.3, 0);
    const twist = k * 0.9;
    const rim: Vector3[] = [];
    for (let i = 0; i < shape.sides; i++) {
      const a = twist + (i / shape.sides) * Math.PI * 2;
      // Alternate branch tips and the gaps between them; tips droop a little.
      const tip = i % 2 === 0 || shape.sides < 6;
      const r = radius * (tip ? 1 : 0.72);
      rim.push(new Vector3(Math.cos(a) * r, rimY - (tip ? radius * DROOP : 0), Math.sin(a) * r));
    }
    for (let i = 0; i < shape.sides; i++) {
      const a = rim[i]!;
      const b = rim[(i + 1) % shape.sides]!;
      // Counter-clockwise seen from outside/above.
      tri(apex, b, a, 1, 0.6, 0.6);
      if (shape.undersides) tri(under, a, b, 0, 0, 0);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('tint', new BufferAttribute(new Float32Array(tints), 2));
  geometry.computeVertexNormals();
  return geometry;
}
