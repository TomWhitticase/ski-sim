import {
  cameraPosition,
  color,
  Discard,
  Fn,
  float,
  max,
  mix,
  modelWorldMatrix,
  mx_fractal_noise_float,
  positionGeometry,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DoubleSide, MeshStandardNodeMaterial, type Texture, type UniformNode } from 'three/webgpu';

import type { Heightmap } from '../geo/heightmap';
import type { Extent } from '../resort/manifest';
import { createSnowDetailTexture } from './snow-detail';

const SNOW = vec3(0.93, 0.95, 0.98);
const SNOW_SHADED = vec3(0.84, 0.88, 0.95);
const ROCK = vec3(0.26, 0.24, 0.23);
const ROCK_LIGHT = vec3(0.4, 0.37, 0.34);

// Around the hole the coarse terrain is pulled down so it always sits below the finer
// layer's edge, whose skirts then cover the join. Without this, hairline gaps show sky.
const HOLE_EDGE_DIP = 40;

/** Close-range snow texture: tile sizes (m) and the distance it fades out over. */
const DETAIL_TILES = [9, 1.7];
const DETAIL_STRENGTH = [0.22, 0.14];
const DETAIL_FADE: [number, number] = [40, 400];
let snowDetailTexture: Texture | null = null;

/**
 * Winter terrain: snow everywhere except slopes too steep to hold it.
 * Lighting uses the full-resolution normal texture, not the (possibly coarse) geometry.
 * Fragments inside `hole` are discarded so a finer terrain layer can show through.
 */
export interface PisteShading {
  /** Same grid as the heightmap: RGB = premultiplied piste colour, A = coverage. */
  overlay: Texture;
  /** 0..1: how strongly to tint pistes in their difficulty colour. */
  tint: UniformNode<'float', number>;
  /** Floodlit runs: glow mask (R, grid-registered on `extent`) and how lit it is (0..1). */
  floodlit?: {
    mask: Texture;
    extent: Extent;
    cellSize: number;
    colour: number;
    on: UniformNode<'float', number>;
  };
}

/** Emissive strength of a fully lit pool on the snow under the floodlights. */
const FLOODLIT_GLOW = 0.35;

export function createTerrainMaterial(
  hm: Heightmap,
  normalTexture: Texture,
  hole?: Extent,
  {
    snowDetail: withSnowDetail = false,
    pistes,
  }: { snowDetail?: boolean; pistes?: PisteShading } = {},
): MeshStandardNodeMaterial {
  // Double-sided so chunk skirts hide LOD cracks whichever side they're seen from.
  const material = new MeshStandardNodeMaterial({ side: DoubleSide });
  const { west, north } = hm.extent;

  const uv = vec2(
    positionWorld.x.sub(west).div(hm.cellSize).add(0.5).div(hm.width),
    positionWorld.z.add(north).div(hm.cellSize).add(0.5).div(hm.height),
  );
  const normal = texture(normalTexture, uv).xyz.mul(2).sub(1).normalize();
  const piste = pistes ? texture(pistes.overlay, uv) : null;
  /** Groomed-piste coverage, 0 off-piste. */
  const groomed = piste ? piste.a : float(0);
  let shadingNormal = normal;
  if (withSnowDetail) {
    // Below-lidar-resolution snow texture near the camera, faded out with distance.
    snowDetailTexture ??= createSnowDetailTexture();
    const tex = snowDetailTexture;
    const fade = smoothstep(
      DETAIL_FADE[0],
      DETAIL_FADE[1],
      cameraPosition.distance(positionWorld),
    ).oneMinus();
    const [coarse, fine] = DETAIL_TILES.map((tile, i) =>
      texture(tex, positionWorld.xz.div(tile)).xy.mul(2).sub(1).mul(DETAIL_STRENGTH[i]!),
    );
    // Groomed corduroy is smooth; untracked off-piste snow is lumpier.
    const roughness = mix(float(1.25), float(0.3), groomed);
    const slope = coarse!.add(fine!).mul(fade).mul(roughness);
    shadingNormal = normal.add(vec3(slope.x.negate(), 0, slope.y.negate())).normalize();
  }
  material.normalNode = transformNormalToView(shadingNormal);

  const ground = vec3(positionWorld.x, 0, positionWorld.z);
  const breakup = mx_fractal_noise_float(ground.mul(0.02), 3);
  const detail = mx_fractal_noise_float(ground.mul(0.15), 2);

  // 1 - n.y: ~0.18 at 35°, ~0.29 at 45°. Snow holds up to roughly 40-45° here.
  const steepness = normal.y.oneMinus();
  const rock = smoothstep(0.22, 0.32, steepness.add(breakup.mul(0.06)));

  const snow = mix(SNOW, SNOW_SHADED, breakup.mul(0.5).add(0.5).mul(0.35));
  const stone = mix(ROCK, ROCK_LIGHT, detail.mul(0.5).add(0.5));

  material.colorNode = Fn(() => {
    if (hole) {
      const x = positionWorld.x;
      const n = positionWorld.z.negate();
      Discard(
        x
          .greaterThan(hole.west)
          .and(x.lessThan(hole.east))
          .and(n.greaterThan(hole.south))
          .and(n.lessThan(hole.north)),
      );
    }
    const base = mix(snow, stone, rock);
    if (!piste || !pistes) return base;
    // Freshly groomed snow reads a touch brighter; optional difficulty-colour tint.
    const brightened = base.mul(groomed.mul(rock.oneMinus()).mul(0.05).add(1));
    const k = pistes.tint.mul(0.55);
    return brightened.mul(groomed.mul(k).oneMinus()).add(piste.rgb.mul(k));
  })();
  if (hole) {
    const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
    const north = world.z.negate();
    const dx = max(max(float(hole.west).sub(world.x), world.x.sub(hole.east)), 0);
    const dn = max(max(float(hole.south).sub(north), north.sub(hole.north)), 0);
    const outside = vec2(dx, dn).length();
    const dip = smoothstep(0, hm.cellSize * 2, outside)
      .oneMinus()
      .mul(HOLE_EDGE_DIP);
    material.positionNode = positionGeometry.sub(vec3(0, dip, 0));
  }
  if (pistes?.floodlit) {
    // Pools of warm light under the floodlights: a baked mask, no real lights.
    const lit = pistes.floodlit;
    const cols = Math.round((lit.extent.east - lit.extent.west) / lit.cellSize) + 1;
    const rows = Math.round((lit.extent.north - lit.extent.south) / lit.cellSize) + 1;
    const litUv = vec2(
      positionWorld.x.sub(lit.extent.west).div(lit.cellSize).add(0.5).div(cols),
      positionWorld.z.add(lit.extent.north).div(lit.cellSize).add(0.5).div(rows),
    );
    material.emissiveNode = color(lit.colour).mul(
      texture(lit.mask, litUv).r.mul(lit.on).mul(FLOODLIT_GLOW),
    );
  }
  material.roughnessNode = mix(0.6, 0.9, rock);
  material.metalness = 0;
  return material;
}
