import {
  attribute,
  cos,
  float,
  fract,
  mix,
  normalGeometry,
  positionGeometry,
  sin,
  transformNormalToView,
  vec3,
} from 'three/tsl';
import {
  DynamicDrawUsage,
  Box3,
  type Camera,
  Frustum,
  Group,
  InstancedBufferAttribute,
  Matrix4,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import type { Extent } from '../resort/manifest';
import {
  createTreeGeometry,
  crownRadiusAt,
  DETAILED,
  MINIMAL,
  SIMPLE,
  type TreeShape,
} from './tree-geometry';
import {
  placeTrees,
  STRIDE,
  TILE,
  type TreeParams,
  type TreeSource,
  unpack,
} from './tree-placement';

const SNOW = vec3(0.92, 0.94, 0.98);
const NEEDLES = vec3(0.045, 0.08, 0.055);
const NEEDLES_LIGHT = vec3(0.07, 0.11, 0.065);
const TWIGS = vec3(0.2, 0.15, 0.11);
const BARK = vec3(0.12, 0.08, 0.06);

/** Detail levels: tree shape, out to what distance (m), and whether it casts shadows. */
const LODS: { shape: TreeShape; distance: number; shadows: boolean }[] = [
  { shape: DETAILED, distance: 250, shadows: true },
  { shape: SIMPLE, distance: 700, shadows: false },
  { shape: MINIMAL, distance: 1500, shadows: false },
];
/** Beyond the last LOD the terrain shades forest itself; it fades in over this range. */
export const FOREST_DRAW_DISTANCE = LODS[LODS.length - 1]!.distance;
/** Trunk plus stiff lower branches: what stops a skier (m). Small trees' crowns reach the
 * ground, so they block out to their crown's radius at waist height, up to `CROWN_BLOCK`. */
const TRUNK_RADIUS = 0.45;
const CROWN_BLOCK = 1.4;
/** Tiles generated per frame at most (each is ~0.1 ms), nearest first. */
const TILES_PER_FRAME = 60;
const MAX_CACHED_TILES = 6000;

interface Tile {
  trees: Float32Array;
  /** Mean, lowest and highest ground under its trees, for distance and view checks. */
  ground: number;
  low: number;
  high: number;
  used: number;
}

interface Lod {
  mesh: Mesh;
  geometry: InstancedBufferGeometry;
  attribute: InstancedBufferAttribute;
  distance: number;
}

/**
 * Individual trees placed from the land cover's tree cover (`tree-placement.ts`), in
 * tiles generated around the camera and cached. Each detail level is one instanced draw:
 * a tile's trees go into the level its distance falls in, rebuilt as you move.
 */
export class Forest {
  readonly root = new Group();
  private readonly tiles = new Map<number, Tile>();
  private readonly lods: Lod[];
  private frame = 0;
  private readonly lastPosition = new Vector3(Infinity, 0, 0);
  private readonly lastRotation = new Quaternion();
  private readonly frustum = new Frustum();
  private readonly projection = new Matrix4();
  private readonly box = new Box3();
  private dirty = true;
  private readonly bounds: { tx0: number; tx1: number; ty0: number; ty1: number };

  constructor(
    private readonly source: TreeSource,
    private readonly params: TreeParams,
    extent: Extent,
  ) {
    this.bounds = {
      tx0: Math.floor(extent.west / TILE),
      tx1: Math.floor(extent.east / TILE),
      ty0: Math.floor(extent.south / TILE),
      ty1: Math.floor(extent.north / TILE),
    };
    this.root.name = 'forest';
    const material = createTreeMaterial();
    this.lods = LODS.map(({ shape, distance, shadows }) => {
      const geometry = new InstancedBufferGeometry();
      const base = createTreeGeometry(shape);
      for (const name of ['position', 'normal', 'tint']) {
        geometry.setAttribute(name, base.getAttribute(name));
      }
      const attr = instanceAttribute(1024);
      geometry.setAttribute('tree', attr);
      geometry.instanceCount = 0;
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      return { mesh, geometry, attribute: attr, distance };
    });
  }

  /**
   * Generate tiles coming into range and redistribute the trees in view among the detail
   * levels (when the camera has moved or turned).
   */
  update(camera: Camera): void {
    this.frame++;
    const reach = FOREST_DRAW_DISTANCE;
    const eye = camera.position;
    const east = eye.x;
    const north = -eye.z;
    const r = Math.ceil(reach / TILE);
    const ctx = Math.floor(east / TILE);
    const cty = Math.floor(north / TILE);
    const { tx0, tx1, ty0, ty1 } = this.bounds;

    // Generate missing tiles in range, nearest first, a few per frame.
    const missing: { tx: number; ty: number; d: number }[] = [];
    for (let ty = Math.max(cty - r, ty0); ty <= Math.min(cty + r, ty1); ty++) {
      for (let tx = Math.max(ctx - r, tx0); tx <= Math.min(ctx + r, tx1); tx++) {
        if (this.tiles.has(key(tx, ty))) continue;
        const de = (tx + 0.5) * TILE - east;
        const dn = (ty + 0.5) * TILE - north;
        const d2 = de * de + dn * dn;
        if (d2 < (reach + TILE) ** 2) missing.push({ tx, ty, d: d2 });
      }
    }
    if (missing.length) {
      missing.sort((a, b) => a.d - b.d);
      for (const { tx, ty } of missing.slice(0, TILES_PER_FRAME)) this.tile(tx, ty);
      this.dirty = true;
    }

    const moved = eye.distanceTo(this.lastPosition);
    const turned = 2 * Math.acos(Math.min(1, Math.abs(camera.quaternion.dot(this.lastRotation))));
    if (!this.dirty && moved < 8 && turned < 0.03) return;
    this.dirty = false;
    this.lastPosition.copy(eye);
    this.lastRotation.copy(camera.quaternion);
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(
      this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
      camera.reversedDepth,
    );

    // Bucket in-range tiles by detail level.
    const buckets: Tile[][] = this.lods.map(() => []);
    const counts = this.lods.map(() => 0);
    for (let ty = Math.max(cty - r, ty0); ty <= Math.min(cty + r, ty1); ty++) {
      for (let tx = Math.max(ctx - r, tx0); tx <= Math.min(ctx + r, tx1); tx++) {
        const tile = this.tiles.get(key(tx, ty));
        if (!tile || tile.trees.length === 0) continue;
        // Distance to the tile's nearest point, so a tile you're inside is always detailed.
        const dx = Math.max(Math.abs((tx + 0.5) * TILE - east) - TILE / 2, 0);
        const dn = Math.max(Math.abs((ty + 0.5) * TILE - north) - TILE / 2, 0);
        const dy = eye.y - tile.ground;
        const d = Math.sqrt(dx * dx + dn * dn + dy * dy);
        const level = this.lods.findIndex((l) => d < l.distance);
        if (level < 0) continue;
        tile.used = this.frame;
        // Tiles out of view, with a margin for tall trees and shadows cast into view.
        this.box.min.set(tx * TILE - 30, tile.low - 5, -(ty + 1) * TILE - 30);
        this.box.max.set((tx + 1) * TILE + 30, tile.high + 40, -ty * TILE + 30);
        if (!this.frustum.intersectsBox(this.box)) continue;
        buckets[level]!.push(tile);
        counts[level]! += tile.trees.length / STRIDE;
      }
    }
    this.lods.forEach((lod, i) => {
      if (lod.attribute.count < counts[i]!) {
        lod.attribute = instanceAttribute(Math.ceil(counts[i]! * 1.5));
        lod.geometry.setAttribute('tree', lod.attribute);
      }
      const array = lod.attribute.array as Float32Array;
      let offset = 0;
      for (const tile of buckets[i]!) {
        array.set(tile.trees, offset);
        offset += tile.trees.length;
      }
      lod.attribute.clearUpdateRanges();
      lod.attribute.addUpdateRange(0, offset);
      lod.attribute.needsUpdate = true;
      lod.geometry.instanceCount = counts[i]!;
    });
    this.evict();
  }

  /**
   * Draw every tree in range at one detail level (null: back to normal), so the levels
   * can be compared side by side (`e2e/forest.spec.ts`).
   */
  showOnly(level: number | null): void {
    this.lods.forEach((lod, i) => {
      lod.distance = level === null ? LODS[i]!.distance : i === level ? FOREST_DRAW_DISTANCE : 0;
    });
    this.dirty = true;
  }

  /** Trees drawn per detail level, nearest first. */
  get counts(): number[] {
    return this.lods.map((l) => l.geometry.instanceCount);
  }

  /**
   * Push a body of `radius` (world position, feet height) out of any trunk it overlaps
   * and cancel its velocity into the trunk. Returns whether it hit.
   */
  resolve(position: Vector3, velocity: Vector3, radius = 0.4): boolean {
    const east = position.x;
    const north = -position.z;
    const reach = radius + CROWN_BLOCK;
    let hit = false;
    const tx0 = Math.floor((east - reach) / TILE);
    const ty0 = Math.floor((north - reach) / TILE);
    for (let ty = ty0; ty <= Math.floor((north + reach) / TILE); ty++) {
      for (let tx = tx0; tx <= Math.floor((east + reach) / TILE); tx++) {
        const { tx0: bx0, tx1: bx1, ty0: by0, ty1: by1 } = this.bounds;
        if (tx < bx0 || tx > bx1 || ty < by0 || ty > by1) continue;
        const trees = this.tile(tx, ty).trees;
        for (let i = 0; i < trees.length; i += STRIDE) {
          const de = position.x - trees[i]!;
          const dn = -position.z - trees[i + 2]!;
          const d2 = de * de + dn * dn;
          if (d2 >= reach * reach) continue;
          const { height } = unpack(trees[i + 3]!);
          if (position.y > trees[i + 1]! + height || position.y + 1.8 < trees[i + 1]! - 1) continue;
          const block = radius + blockRadius(height);
          if (d2 >= block * block) continue;
          const d = Math.sqrt(d2) || 1e-3;
          const ne = d2 > 0 ? de / d : 1;
          const nn = d2 > 0 ? dn / d : 0;
          position.x = trees[i]! + ne * block;
          position.z = -(trees[i + 2]! + nn * block);
          // Velocity in world axes: east = x, north = -z.
          const vn = velocity.x * ne - velocity.z * nn;
          if (vn < 0) {
            velocity.x -= ne * vn;
            velocity.z += nn * vn;
          }
          hit = true;
        }
      }
    }
    return hit;
  }

  dispose(): void {
    for (const lod of this.lods) lod.geometry.dispose();
  }

  private tile(tx: number, ty: number): Tile {
    const k = key(tx, ty);
    let tile = this.tiles.get(k);
    if (!tile) {
      const trees = placeTrees(tx, ty, this.source, this.params);
      let ground = 0;
      let low = Infinity;
      let high = -Infinity;
      for (let i = 1; i < trees.length; i += STRIDE) {
        ground += trees[i]!;
        low = Math.min(low, trees[i]!);
        high = Math.max(high, trees[i]!);
      }
      const n = trees.length / STRIDE;
      const centre = this.source.ground((tx + 0.5) * TILE, (ty + 0.5) * TILE);
      tile = {
        trees,
        ground: n ? ground / n : centre,
        low: n ? low : centre,
        high: n ? high : centre,
        used: this.frame,
      };
      this.tiles.set(k, tile);
    }
    return tile;
  }

  private evict(): void {
    if (this.tiles.size <= MAX_CACHED_TILES) return;
    const old = [...this.tiles].sort((a, b) => a[1].used - b[1].used);
    for (const [k] of old.slice(0, this.tiles.size - MAX_CACHED_TILES * 0.8)) this.tiles.delete(k);
  }
}

/** How far from its trunk a tree of `height` stops a skier (m). */
export function blockRadius(height: number): number {
  return Math.min(Math.max(crownRadiusAt(1, height), TRUNK_RADIUS), CROWN_BLOCK);
}

function key(tx: number, ty: number): number {
  return (tx + 32768) * 65536 + (ty + 32768);
}

function instanceAttribute(count: number): InstancedBufferAttribute {
  const attr = new InstancedBufferAttribute(new Float32Array(count * STRIDE), STRIDE);
  attr.setUsage(DynamicDrawUsage);
  return attr;
}

/**
 * One material for every detail level. The instance attribute `tree` is (east, ground,
 * north, height + 1000·species); each tree also gets a pseudo-random turn and girth from
 * its position. Snow sits on the tiers' tops (`tint.x`); larches are bare in winter.
 */
function createTreeMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  const tree = attribute('tree', 'vec4');
  const tint = attribute('tint', 'vec2');
  const species = tree.w.div(1000).floor();
  const height = tree.w.sub(species.mul(1000));
  const r1 = fract(tree.x.mul(0.6180339).add(tree.z.mul(0.4142135)));
  const r2 = fract(tree.x.mul(0.3183099).add(tree.z.mul(0.7071067)));
  const angle = r1.mul(Math.PI * 2);
  const c = cos(angle);
  const s = sin(angle);
  // Larches are a little slimmer; girth varies ±15%.
  const girth = r2
    .mul(0.3)
    .add(0.85)
    .mul(mix(float(1), float(0.8), species));
  const p = positionGeometry;
  const turned = vec3(p.x.mul(c).sub(p.z.mul(s)), p.y, p.x.mul(s).add(p.z.mul(c)));
  material.positionNode = turned
    .mul(vec3(girth.mul(height), height, girth.mul(height)))
    .add(vec3(tree.x, tree.y, tree.z.negate()));
  const n = normalGeometry;
  material.normalNode = transformNormalToView(
    vec3(n.x.mul(c).sub(n.z.mul(s)), n.y, n.x.mul(s).add(n.z.mul(c))).normalize(),
  );

  const needles = mix(NEEDLES, NEEDLES_LIGHT, r2);
  const foliage = mix(needles, TWIGS, species);
  // Snow on the tiers (the geometry has already taken it off steep faces), thinner on
  // bare larch twigs.
  const snow = tint.x.mul(mix(float(1), float(0.35), species));
  material.colorNode = mix(mix(foliage, SNOW, snow), BARK, tint.y);
  material.roughnessNode = mix(float(0.9), float(0.7), snow);
  material.metalness = 0;
  return material;
}
