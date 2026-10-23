import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { uniform } from 'three/tsl';
import {
  type Camera,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  type Scene,
  Vector3,
} from 'three/webgpu';

import { type SunPosition, sunPosition } from './sun-position';

const RAD = Math.PI / 180;

/** Unit vector toward the sun in world axes (x east, y up, z south). */
export function sunDirection({ azimuth, elevation }: SunPosition): Vector3 {
  const az = azimuth * RAD;
  const el = elevation * RAD;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const SUN_NOON = new Color(0xfff6ec);
const SUN_LOW = new Color(0xffa060);
const SKY_DAY = new Color(0xa8c8f0);
const SKY_NIGHT = new Color(0x7088c8);
const FOG_DAY = new Color(0xb9d0ea);
const FOG_DUSK = new Color(0xd8a890);
const FOG_NIGHT = new Color(0x0b1220);
/** The sun light never comes from lower than this, so shadows stay sane at dusk. */
const MIN_LIGHT_ELEVATION = 2;

/**
 * Light levels for a sun elevation (degrees). The sun light fades out as the sun sets
 * and goes warm near the horizon; after dusk a dim blue "moonlight" sky light remains so
 * the slopes stay readable. Pure, so it's unit-tested.
 */
export function daylight(elevation: number) {
  const day = smoothstep(-8, 10, elevation);
  const low = 1 - smoothstep(2, 25, elevation);
  return {
    /** Directional sun intensity. */
    sun: 3.2 * smoothstep(-1, 6, elevation),
    /** 0 noon colour → 1 sunset orange. */
    warmth: low,
    /** Hemisphere sky light: 0.9 by day, 0.5 (in moonlight blue) at night. */
    ambient: 0.5 + 0.4 * day,
    day,
    /** How much the fog takes the sunset tint. */
    dusk: low * smoothstep(-6, 2, elevation),
    /** Need for artificial light (headlights): from just before sunset, full once it's down. */
    dark: 1 - smoothstep(-3, 4, elevation),
    /** Floodlit runs: on as the sun sets, full once it's down. */
    floodlights: 1 - smoothstep(-3, 3, elevation),
  };
}

/** Bluebird conditions: cloudless, very clear alpine air, sun placed for the time of day. */
export class Environment {
  sun: SunPosition;
  private readonly sky = new SkyMesh();
  private readonly sunLight = new DirectionalLight(0xfff6ec, 3.2);
  private readonly skyLight = new HemisphereLight(0xa8c8f0, 0xdfe6ee, 0.9);
  private readonly fog = new FogExp2(0xb9d0ea, 0.000011);
  /** 0..1: how strongly floodlit runs and their masts glow (shader uniform). */
  readonly floodlights = uniform(0);

  constructor(
    scene: Scene,
    time: Date,
    private readonly lat: number,
    private readonly lon: number,
    /** Shadow budget (`render/quality.ts`): map size, cascades, how far they reach (m). */
    shadows = { mapSize: 2048, cascades: 3, distance: 30_000 },
  ) {
    this.sun = sunPosition(time, lat, lon);

    const sky = this.sky;
    sky.scale.setScalar(300_000);
    sky.turbidity.value = 1.6;
    sky.rayleigh.value = 1.1;
    sky.mieCoefficient.value = 0.002;
    sky.mieDirectionalG.value = 0.85;
    sky.cloudCoverage.value = 0;
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    scene.add(sky);

    // Cascaded shadow maps: sharp shadows close up, coarser out to `shadows.distance`.
    // Light direction is target - position, so the target sits at the origin.
    const sunLight = this.sunLight;
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(shadows.mapSize, shadows.mapSize);
    sunLight.shadow.bias = -0.0003;
    sunLight.shadow.normalBias = 1.5;
    // Each cascade clones this camera; its depth range must span lightMargin plus the
    // cascade's own depth, so the 500 m default is far too short.
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 80_000;
    sunLight.shadow.shadowNode = new CSMShadowNode(sunLight, {
      cascades: shadows.cascades,
      maxFar: shadows.distance,
      mode: 'practical',
      // Ridges well outside the view still cast long shadows into it.
      lightMargin: 6000,
    });
    scene.add(sunLight, sunLight.target);
    scene.add(this.skyLight);

    // Thin aerial haze so distant ranges fade toward the horizon colour.
    scene.fog = this.fog;
    this.setTime(time);
  }

  /** Moves the sun (sky, light, shadows) and sets light and haze for that time. */
  setTime(time: Date): void {
    this.sun = sunPosition(time, this.lat, this.lon);
    this.sky.sunPosition.value.copy(sunDirection(this.sun));
    this.sunLight.position.copy(
      sunDirection({
        azimuth: this.sun.azimuth,
        elevation: Math.max(this.sun.elevation, MIN_LIGHT_ELEVATION),
      }),
    );
    const light = daylight(this.sun.elevation);
    this.sunLight.intensity = light.sun;
    this.sunLight.color.lerpColors(SUN_NOON, SUN_LOW, light.warmth);
    this.skyLight.intensity = light.ambient;
    this.skyLight.color.lerpColors(SKY_NIGHT, SKY_DAY, light.day);
    this.fog.color.lerpColors(FOG_NIGHT, FOG_DAY, light.day).lerp(FOG_DUSK, light.dusk * 0.6);
    this.floodlights.value = light.floodlights;
  }

  update(camera: Camera): void {
    this.sky.position.copy(camera.position);
  }
}
