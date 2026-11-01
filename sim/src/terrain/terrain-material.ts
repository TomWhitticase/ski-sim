import {
  abs,
  cameraPosition,
  color,
  Discard,
  Fn,
  float,
  max,
  mix,
  modelWorldMatrix,
  mx_fractal_noise_float,
  mx_fractal_noise_vec3,
  positionGeometry,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  transformNormalToView,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DoubleSide, MeshStandardNodeMaterial, type Texture, type UniformNode } from 'three/webgpu';

import { TERRAIN_DETAIL } from '../config';
import type { Heightmap } from '../geo/heightmap';
import type { TerrainDetailTier } from '../render/quality';
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

// Legacy 2-D tiling snow-detail normal map (`snow-detail.ts`): the mid-range fallback.
// It's sampled by `positionWorld.xz`, a flat projection, so it smears at grazing angles
// right under the camera — exactly where the 3-D procedural detail below now takes over.
// So when that detail is active it's suppressed near the camera and kept only mid-range.
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

/** Roads on the piste overlay's grid (RGB coverage: R cleared asphalt, G snow road). */
export interface RoadShading {
  texture: Texture;
  /** Cleared roads are meshes nearer than this (m): the terrain shades them from
   *  `fade[0]`, fully by `fade[1]`. */
  fade: [number, number];
}

/** Far asphalt, seen from beyond the road meshes' range. */
const ROAD_FAR = vec3(0.1, 0.105, 0.11);

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
    detail,
    pistes,
    landCover,
    roads,
  }: {
    snowDetail?: boolean;
    /** Procedural close-up detail tier (`render/quality.ts`); omit or `enabled: false`
     *  for none (the far layer passes nothing). */
    detail?: TerrainDetailTier;
    pistes?: PisteShading;
    landCover?: LandCoverShading;
    roads?: RoadShading;
  } = {},
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
  // Roads under the snow are packed (smoother, a shade darker) unless a run is on top;
  // cleared ones are drawn as meshes nearby and shaded here beyond them.
  const roadCover = roads ? texture(roads.texture, uv) : null;
  const pisteFree = groomed.oneMinus();
  const snowRoad = roadCover ? roadCover.g.mul(pisteFree) : float(0);
  const farRoad =
    roadCover && roads
      ? roadCover.r
          .mul(pisteFree)
          .mul(smoothstep(roads.fade[0], roads.fade[1], cameraPosition.distance(positionWorld)))
      : float(0);
  const dist = cameraPosition.distance(positionWorld);

  // Procedural close-up detail, scaled by the device's quality tier. The far layer passes
  // no `detail`, so `active` is false there and nothing below runs. `D` holds the tunables
  // (config.TERRAIN_DETAIL); `detailStrength` is the eased combo × the tier; `oct` caps fBm
  // octaves (phones get fewer); `nearFade(window)` is 1 at the camera, 0 past the window.
  const D = TERRAIN_DETAIL;
  const active = detail?.enabled ?? false;
  const detailStrength = active ? D.strength * detail!.strength : 0;
  const fadeScale = detail?.fadeScale ?? 1;
  const oct = (n: number) => Math.max(1, Math.min(n, detail?.octaves ?? 1));
  const nearFade = (fade: [number, number]) =>
    smoothstep(fade[1] * fadeScale, fade[0] * fadeScale, dist);

  let shadingNormal = normal;
  if (withSnowDetail) {
    // Legacy 2-D tiling snow texture, faded out with distance. It's the mid-range fallback:
    // where the 3-D detail is active it smears under the camera, so suppress it there.
    snowDetailTexture ??= createSnowDetailTexture();
    const tex = snowDetailTexture;
    const fade = smoothstep(DETAIL_FADE[0], DETAIL_FADE[1], dist).oneMinus();
    const [coarse, fine] = DETAIL_TILES.map((tile, i) =>
      texture(tex, positionWorld.xz.div(tile)).xy.mul(2).sub(1).mul(DETAIL_STRENGTH[i]!),
    );
    // Groomed corduroy is smooth; untracked off-piste snow is lumpier.
    const roughness = mix(float(1.25), float(0.3), groomed.max(snowRoad.mul(0.75)));
    let slope = coarse!.add(fine!).mul(fade).mul(roughness);
    // Hand the near zone to the 3-D snow grain (the smear source is this xz projection).
    if (active) slope = slope.mul(nearFade(D.snowGrain.fade).oneMinus());
    shadingNormal = normal.add(vec3(slope.x.negate(), 0, slope.y.negate())).normalize();
  }

  const ground = vec3(positionWorld.x, 0, positionWorld.z);
  const breakup = mx_fractal_noise_float(ground.mul(0.02), 3);
  const colourNoise = mx_fractal_noise_float(ground.mul(0.15), 2);

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
  const shift = bare.mul(colourNoise.mul(0.05).add(0.07)).sub(tree.mul(0.12));
  const rock = smoothstep(0.22, 0.32, steepness.add(breakup.mul(0.06)).add(shift)).mul(
    water.oneMinus(),
  );
  /** Snow (not rock / water / forest): where the extra snow detail belongs. */
  const snowy = rock.oneMinus().mul(water.oneMinus()).mul(tree.oneMinus());
  const offPiste = groomed.oneMinus();

  if (active) {
    // Micro-relief on off-piste snow: two octaves of fBm lumps plus a ridged sastrugi term
    // (wind-carved ripples). Visual only — physics samples the smooth 4 m grid, so the skis
    // don't follow it — and groomed pistes keep only a flat share of it.
    const rAmp = nearFade(D.relief.fade)
      .mul(snowy)
      .mul(offPiste.mul(D.relief.offPiste).add(1 - D.relief.offPiste))
      .mul(detailStrength);
    const lump = mx_fractal_noise_vec3(positionWorld.mul(D.relief.freq[0]), oct(3)).mul(
      D.relief.lump,
    );
    const grain = mx_fractal_noise_vec3(positionWorld.mul(D.relief.freq[1]), oct(2)).mul(
      D.relief.grain,
    );
    const ridge = mx_fractal_noise_vec3(positionWorld.mul(D.relief.freq[2]).add(31), oct(2));
    const sastrugi = vec3(abs(ridge.x).oneMinus(), 0, abs(ridge.z).oneMinus()).mul(
      D.relief.sastrugi,
    );
    const rd = lump.add(grain).add(sastrugi).mul(rAmp);
    shadingNormal = shadingNormal.add(vec3(rd.x, 0, rd.z)).normalize();

    // 3-D detail normals: a craggy breakup on rock faces, plus a fine snow grain. Sampled
    // in 3-D world space, so (unlike the 2-D tiling map) they never stretch at grazing
    // angles or on vertical rock. Both fade in only near the camera.
    const rockNear = nearFade(D.rock.fade).mul(rock).mul(detailStrength);
    const rockD = mx_fractal_noise_vec3(positionWorld.mul(D.rock.freq[0]), oct(4)).mul(
      D.rock.coarse,
    );
    const rockFine = mx_fractal_noise_vec3(positionWorld.mul(D.rock.freq[1]), oct(2)).mul(
      D.rock.fine,
    );
    const snowGrain = mx_fractal_noise_vec3(positionWorld.mul(D.snowGrain.freq), oct(2))
      .mul(D.snowGrain.strength)
      .mul(nearFade(D.snowGrain.fade).mul(snowy).mul(detailStrength));
    shadingNormal = shadingNormal.add(rockD.add(rockFine).mul(rockNear).add(snowGrain)).normalize();

    // Groomed corduroy: shallow ridges across the fall line (the macro normal's horizontal
    // part), ~0.9 m apart. Direction is derived from the slope.
    if (pistes) {
      const fall = vec2(normal.x, normal.z);
      const rip = sin(ground.xz.dot(fall).mul(D.corduroy.spacing))
        .mul(D.corduroy.strength)
        .mul(groomed)
        .mul(nearFade(D.corduroy.fade))
        .mul(detailStrength);
      shadingNormal = shadingNormal.add(vec3(fall.x.mul(rip), 0, fall.y.mul(rip))).normalize();
    }
  }
  material.normalNode = transformNormalToView(shadingNormal);

  const snow = mix(
    mix(SNOW, SNOW_SHADED, breakup.mul(0.5).add(0.5).mul(0.35)),
    GLACIER_SNOW,
    ice.mul(0.55),
  );
  const stone = mix(mix(ROCK, ROCK_LIGHT, colourNoise.mul(0.5).add(0.5)), SERAC_ICE, ice);
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
    // Deepen the shaded snow toward blue near the camera (the subsurface / sky-fill look in
    // hollows), so flat snow reads with depth instead of a uniform white.
    let snowCol = snow;
    if (active) {
      const shade = breakup.mul(0.5).add(0.5).oneMinus();
      const blue = vec3(D.blueShade.colour[0], D.blueShade.colour[1], D.blueShade.colour[2]);
      snowCol = mix(
        snowCol,
        blue,
        shade.mul(D.blueShade.strength).mul(snowy).mul(nearFade(D.blueShade.fade)),
      );
    }
    const surface = mix(
      mix(snowCol, stone, rock),
      LAKE_ICE.mul(colourNoise.mul(0.04).add(1)),
      water,
    );
    // Snow under drawn trees lies in their shade; far off, crowns and snow blend.
    const crowns = mix(CANOPY, CANOPY_SNOW, breakup.mul(0.5).add(0.5).mul(0.35).add(0.3));
    const forest = mix(
      surface.mul(tree.sub(canopy).mul(0.15).oneMinus()),
      crowns,
      canopy.mul(0.85),
    );
    const base = mix(forest.mul(snowRoad.mul(rock.oneMinus()).mul(-0.1).add(1)), ROAD_FAR, farRoad);
    let out = base;
    if (piste && pistes) {
      // Freshly groomed snow reads a touch brighter; optional difficulty-colour tint.
      const brightened = base.mul(groomed.mul(rock.oneMinus()).mul(0.05).add(1));
      const k = pistes.tint.mul(0.55);
      out = brightened.mul(coverage.mul(k).oneMinus()).add(piste.rgb.mul(k));
    }
    // Near-range aerial perspective: a faint sky tint grows over the mid-range so flat near
    // snow lifts off a dead white (`TERRAIN_DETAIL.aerial.strength` 0 disables it).
    if (active && D.aerial.strength > 0) {
      const haze = smoothstep(D.aerial.fade[0] * fadeScale, D.aerial.fade[1] * fadeScale, dist).mul(
        D.aerial.strength,
      );
      out = mix(out, vec3(D.aerial.colour[0], D.aerial.colour[1], D.aerial.colour[2]), haze);
    }
    return out;
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
  // Base roughness: rougher on rock, glassy on ice.
  let roughness = mix(mix(float(0.6), float(0.9), rock), float(0.35), water);
  if (active) {
    // Sparse sun-catching crystals (roughness dips → sharp specular glints) and a broad
    // variation so the snow glistens unevenly rather than reading as matte. Both fade with
    // distance so the sparkle never aliases into static.
    const sparkleN = mx_fractal_noise_float(positionWorld.mul(D.sparkle.freq), oct(2))
      .mul(0.5)
      .add(0.5);
    const sparkle = step(D.sparkle.threshold, sparkleN).mul(snowy).mul(nearFade(D.sparkle.fade));
    const vary = mx_fractal_noise_float(positionWorld.mul(D.roughnessVary.freq), oct(2))
      .mul(D.roughnessVary.strength)
      .mul(snowy);
    roughness = roughness.add(vary).mul(sparkle.mul(D.sparkle.strength).oneMinus()).clamp(0.04, 1);
  }
  material.roughnessNode = roughness;

  if (active) {
    // Cheap curvature ambient occlusion: darken hollows near the camera so convex and
    // concave snow no longer read identically (an approximation, not true occlusion).
    const cavity = mx_fractal_noise_float(positionWorld.mul(D.ao.freq), oct(3)).mul(0.5).add(0.5);
    material.aoNode = mix(
      float(1),
      mix(float(1 - D.ao.darken), float(1), cavity),
      nearFade(D.ao.fade),
    );
  }
  material.metalness = 0;
  return material;
}
