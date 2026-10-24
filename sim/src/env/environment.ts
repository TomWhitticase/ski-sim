import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { mix, normalWorld, smoothstep as smooth, uniform } from 'three/tsl';
import {
  BackSide,
  type Camera,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  MeshBasicNodeMaterial,
  type Scene,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

import { type SunPosition, sunPosition } from './sun-position';
import { CLEAR, type Conditions } from './weather';

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
const GROUND = new Color(0xdfe6ee);
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

const CLOUD_GREY = new Color(0xb4bac3);
const CLOUD_DARK = new Color(0x7d848f);
const WHITEOUT = new Color(0xdfe3e8);
const FOG_CLEAR_DENSITY = 0.000011;

/** How the weather changes the light, sky and haze. Pure, so it's unit-tested. */
export interface WeatherLook {
  /** Multiplies the sun light. */
  sun: number;
  /** Multiplies the hemisphere sky light. */
  ambient: number;
  /** 0..1: the hemisphere's ground colour toward its sky colour (no shading by facing). */
  flat: number;
  /** 0..1: the grey cloud dome over the sky. */
  dome: number;
  /** 0..1: dome, fog and sky light toward the cloud's grey/white. */
  grey: number;
  /** 0 grey overcast … 1 bright whiteout white. */
  white: number;
  /** FogExp2 density (1/m). */
  fogDensity: number;
  /** Broken cloud drawn in the sky (SkyMesh coverage). */
  cloudCoverage: number;
}

/**
 * The weather's light. `sunlit` (0..1) is whether a passing cloud is off the sun right now
 * (broken cloud lets it through some of the time).
 */
export function weatherLook(c: Conditions, sunlit = 1): WeatherLook {
  const broken = Math.min(1, c.cloud * 1.2);
  // A broken sky: the sun comes and goes; overcast: it's gone.
  const sun = (1 - c.overcast) * (1 - 0.75 * broken * (1 - sunlit));
  const flat = Math.max(c.overcast * 0.6, c.whiteout);
  // Koschmieder: 2 % contrast left at the visibility; exp² fog reaches that at 1.98 / V.
  const fogDensity = Math.max(FOG_CLEAR_DENSITY, 1.98 / c.visibility);
  return {
    sun: Math.max(0, sun),
    // Diffuse skylight from a bright overcast; the snow lights itself in a whiteout.
    ambient: 1 + 1.6 * c.overcast + 1.2 * c.whiteout,
    flat,
    dome: Math.max(smoothstep(0.35, 0.95, c.overcast) * 0.97, smoothstep(3000, 300, c.visibility)),
    grey: Math.max(c.overcast, smoothstep(20_000, 1500, c.visibility)),
    white: c.whiteout,
    fogDensity,
    cloudCoverage: c.overcast > 0.9 ? 0 : Math.min(0.9, c.cloud * 0.9),
  };
}

/** Bluebird conditions, or the weather's: sun placed for the time of day. */
export class Environment {
  sun: SunPosition;
  private readonly sky = new SkyMesh();
  private readonly sunLight = new DirectionalLight(0xfff6ec, 3.2);
  private readonly skyLight = new HemisphereLight(0xa8c8f0, GROUND, 0.9);
  private readonly fog = new FogExp2(0xb9d0ea, FOG_CLEAR_DENSITY);
  /** 0..1: how strongly floodlit runs and their masts glow (shader uniform). */
  readonly floodlights = uniform(0);
  /** The grey cloud dome inside the sky: an overcast or a fog, merging with the haze. */
  private readonly dome: Mesh;
  private readonly domeHorizon = uniform(new Color());
  private readonly domeZenith = uniform(new Color());
  private readonly domeOpacity = uniform(0);
  private weather: Conditions = CLEAR;
  private sunlit = 1;

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

    // Inside the sky box, outside everything else: drawn over the sky only (terrain is
    // nearer, and depth-tested), fading to the haze colour at the horizon.
    const domeMaterial = new MeshBasicNodeMaterial({
      side: BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const up = normalWorld.y.negate(); // back faces: the normal points in
    domeMaterial.colorNode = mix(this.domeHorizon, this.domeZenith, smooth(0, 0.5, up));
    domeMaterial.opacityNode = this.domeOpacity;
    this.dome = new Mesh(new SphereGeometry(250_000, 32, 16), domeMaterial);
    this.dome.name = 'cloud-dome';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    this.dome.visible = false;
    scene.add(this.dome);

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
    this.apply();
  }

  /**
   * The weather where the camera is (`CLEAR` for none). `sunlit` is 0..1: whether a
   * passing cloud is off the sun just now.
   */
  setWeather(conditions: Conditions, sunlit = 1): void {
    this.weather = conditions;
    this.sunlit = sunlit;
    this.apply();
  }

  /** Light levels from the sun's height and the weather. */
  private apply(): void {
    const light = daylight(this.sun.elevation);
    const look = weatherLook(this.weather, this.sunlit);
    this.sunLight.intensity = light.sun * look.sun;
    this.sunLight.color.lerpColors(SUN_NOON, SUN_LOW, light.warmth * (1 - look.grey));
    this.skyLight.intensity = light.ambient * look.ambient;
    // Cloud light: grey overcast, near-white in a whiteout; dimmed with the day.
    // Lit cloud is as bright as the snow it lights (tone mapping brings it back to white).
    const tint = this.cloudTint.lerpColors(CLOUD_GREY, WHITEOUT, look.white);
    const cloud = this.cloudColour.copy(tint).multiplyScalar(1.2 + 0.8 * look.white);
    const night = this.nightColour.lerpColors(FOG_NIGHT, cloud, light.day);
    // The sky light takes the cloud's hue, not its greyness (its intensity is `ambient`).
    const hue = tint.multiplyScalar(1 / Math.max(tint.r, tint.g, tint.b));
    this.skyLight.color.lerpColors(SKY_NIGHT, SKY_DAY, light.day).lerp(hue, look.grey * 0.8);
    this.skyLight.groundColor.lerpColors(GROUND, this.skyLight.color, look.flat);
    this.fog.color
      .lerpColors(FOG_NIGHT, FOG_DAY, light.day)
      .lerp(FOG_DUSK, light.dusk * 0.6 * (1 - look.grey))
      .lerp(night, look.grey);
    this.fog.density = look.fogDensity;
    this.floodlights.value = light.floodlights;
    this.sky.cloudCoverage.value = look.cloudCoverage;
    this.sky.showSunDisc.value = look.dome > 0.85 ? 0 : 1;
    // The dome: the haze colour at the horizon, a darker cloud base overhead (less so in fog).
    this.dome.visible = look.dome > 0.01;
    this.domeOpacity.value = look.dome;
    this.domeHorizon.value.copy(this.fog.color);
    this.domeZenith.value
      .lerpColors(CLOUD_DARK, cloud, Math.max(look.white, 1 - this.weather.overcast * 0.6))
      .multiplyScalar(0.25 + 0.75 * light.day)
      .lerp(this.fog.color, smoothstep(2000, 200, this.weather.visibility));
  }

  update(camera: Camera): void {
    this.sky.position.copy(camera.position);
    this.dome.position.copy(camera.position);
  }

  private readonly cloudTint = new Color();
  private readonly cloudColour = new Color();
  private readonly nightColour = new Color();
}
