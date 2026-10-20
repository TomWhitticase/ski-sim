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
// Land cover (winter): firn on glaciers, blue ice where they steepen, frozen lakes, and
// forest seen from afar (dark crowns with snow between and on them).
const GLACIER_SNOW = vec3(0.86, 0.93, 1.0);
const SERAC_ICE = vec3(0.5, 0.7, 0.84);
const LAKE_ICE = vec3(0.74, 0.84, 0.92);
const CANOPY = vec3(0.07, 0.1, 0.075);
const CANOPY_SNOW = vec3(0.6, 0.64, 0.66);

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
  /** Same grid: how much of that coverage is unprepared snow (R); groomed is the rest. */
  ungroomed?: Texture;
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

/** Land cover on its own grid: R tree cover, G bare rock, B 0.5 + ½ ice − ½ water. */
export interface LandCoverShading {
  texture: Texture;
  extent: Extent;
  cellSize: number;
  width: number;
  height: number;
  /** Distances (m) over which drawn trees give way to shaded forest; omit to always shade. */
  canopyFade?: [number, number];
}

export function createTerrainMaterial(
  hm: Heightmap,
  normalTexture: Texture,
  hole?: Extent,
  {
    snowDetail: withSnowDetail = false,
    pistes,
    landCover,
  }: { snowDetail?: boolean; pistes?: PisteShading; landCover?: LandCoverShading } = {},
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
  /** Coloured-run coverage, and the groomed part of it (0 off-piste and on itineraries). */
  const coverage = piste ? piste.a : float(0);
  const groomed = pistes?.ungroomed
    ? coverage.sub(texture(pistes.ungroomed, uv).r).max(0)
    : coverage;
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

  const cover = landCover
    ? texture(
        landCover.texture,
        vec2(
          positionWorld.x.sub(landCover.extent.west).div(landCover.cellSize).add(0.5),
          positionWorld.z.add(landCover.extent.north).div(landCover.cellSize).add(0.5),
        ).div(vec2(landCover.width, landCover.height)),
      )
    : null;
  const [tree, bare, ice, water] = cover
    ? [cover.r, cover.g, cover.b.mul(2).sub(1).max(0), cover.b.mul(-2).add(1).max(0)]
    : [float(0), float(0), float(0), float(0)];

  // 1 - n.y: ~0.18 at 35°, ~0.29 at 45°. Snow holds up to roughly 40-45° here. In winter
  // gentle "bare" ground is snow-covered too, but mapped bare rock sheds it from ~30°
  // (patchily, wind-scoured), and forest holds it on steep slopes. Frozen lakes are flat.
  const steepness = normal.y.oneMinus();
  const shift = bare.mul(detail.mul(0.05).add(0.07)).sub(tree.mul(0.12));
  const rock = smoothstep(0.22, 0.32, steepness.add(breakup.mul(0.06)).add(shift)).mul(
    water.oneMinus(),
  );

  const snow = mix(
    mix(SNOW, SNOW_SHADED, breakup.mul(0.5).add(0.5).mul(0.35)),
    GLACIER_SNOW,
    ice.mul(0.55),
  );
  const stone = mix(mix(ROCK, ROCK_LIGHT, detail.mul(0.5).add(0.5)), SERAC_ICE, ice);
  const canopyFade = landCover?.canopyFade;
  /** How much forest the terrain shades itself (where trees aren't drawn as meshes). */
  const canopy = canopyFade
    ? tree.mul(smoothstep(canopyFade[0], canopyFade[1], cameraPosition.distance(positionWorld)))
    : tree;

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
    const surface = mix(mix(snow, stone, rock), LAKE_ICE.mul(detail.mul(0.04).add(1)), water);
    // Snow under drawn trees lies in their shade; far off, crowns and snow blend.
    const crowns = mix(CANOPY, CANOPY_SNOW, breakup.mul(0.5).add(0.5).mul(0.35).add(0.3));
    const base = mix(surface.mul(tree.sub(canopy).mul(0.15).oneMinus()), crowns, canopy.mul(0.85));
    if (!piste || !pistes) return base;
    // Freshly groomed snow reads a touch brighter; optional difficulty-colour tint.
    const brightened = base.mul(groomed.mul(rock.oneMinus()).mul(0.05).add(1));
    const k = pistes.tint.mul(0.55);
    return brightened.mul(coverage.mul(k).oneMinus()).add(piste.rgb.mul(k));
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
  material.roughnessNode = mix(mix(0.6, 0.9, rock), 0.35, water);
  material.metalness = 0;
  return material;
}
