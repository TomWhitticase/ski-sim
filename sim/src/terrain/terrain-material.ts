import {
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
import { DoubleSide, MeshStandardNodeMaterial, type Texture } from 'three/webgpu';

import type { Heightmap } from '../geo/heightmap';
import type { Extent } from '../resort/manifest';

const SNOW = vec3(0.93, 0.95, 0.98);
const SNOW_SHADED = vec3(0.84, 0.88, 0.95);
const ROCK = vec3(0.26, 0.24, 0.23);
const ROCK_LIGHT = vec3(0.4, 0.37, 0.34);

// Around the hole the coarse terrain is pulled down so it always sits below the finer
// layer's edge, whose skirts then cover the join. Without this, hairline gaps show sky.
const HOLE_EDGE_DIP = 40;

/**
 * Winter terrain: snow everywhere except slopes too steep to hold it.
 * Lighting uses the full-resolution normal texture, not the (possibly coarse) geometry.
 * Fragments inside `hole` are discarded so a finer terrain layer can show through.
 */
export function createTerrainMaterial(
  hm: Heightmap,
  normalTexture: Texture,
  hole?: Extent,
): MeshStandardNodeMaterial {
  // Double-sided so chunk skirts hide LOD cracks whichever side they're seen from.
  const material = new MeshStandardNodeMaterial({ side: DoubleSide });
  const { west, north } = hm.extent;

  const uv = vec2(
    positionWorld.x.sub(west).div(hm.cellSize).add(0.5).div(hm.width),
    positionWorld.z.add(north).div(hm.cellSize).add(0.5).div(hm.height),
  );
  const normal = texture(normalTexture, uv).xyz.mul(2).sub(1).normalize();
  material.normalNode = transformNormalToView(normal);

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
    return mix(snow, stone, rock);
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
  material.roughnessNode = mix(0.6, 0.9, rock);
  material.metalness = 0;
  return material;
}
