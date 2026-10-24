import { type Scene, Vector3 } from 'three/webgpu';

import { DRIFT, Precipitation, RAIN, SNOW } from './precipitation';
import type { Conditions } from './weather';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Share of the snow particles drawn for a snowfall rate (cm/h): ~3 cm/h is a heavy fall. */
export const snowDensity = (c: Conditions) => clamp01(c.snowRate / 3) ** 0.6;
/** Share of the rain particles drawn for a rate (mm/h). */
export const rainDensity = (c: Conditions) => clamp01(c.rainRate / 6) ** 0.6;
/** Spindrift particles, only near the ground (`height` above it, m). */
export const driftDensity = (c: Conditions, height: number) =>
  c.drift ** 1.3 * (1 - smoothstep(6, 30, height));

/**
 * The wind as a world velocity (m/s; x east, z south): blowing *toward* the opposite of
 * where it comes from.
 */
export function windVelocity(speed: number, from: number, out = new Vector3()): Vector3 {
  const a = (from * Math.PI) / 180;
  return out.set(-Math.sin(a) * speed, 0, Math.cos(a) * speed);
}

/**
 * Whether the sun is out right now under a broken sky (0..1): clouds drift past, letting
 * it through about (1 - cover) of the time. Deterministic in `seconds`.
 */
export function sunlitAt(cover: number, seconds: number): number {
  if (cover <= 0.05) return 1;
  const n =
    0.5 +
    0.3 * Math.sin(seconds / 23) +
    0.15 * Math.sin(seconds / 9.1 + 2) +
    0.05 * Math.sin(seconds / 3.7);
  return smoothstep(cover - 0.12, cover + 0.12, n);
}

const FALL_SNOW = 1.1;
const FALL_RAIN = 7;
/** Snow and rain near the ground feel less of the wind than the 10 m figure. */
const LOW_WIND = 0.75;

/** Falling snow, rain and spindrift round the camera. */
export class WeatherFx {
  private readonly snow: Precipitation;
  private readonly rain: Precipitation;
  private readonly drift: Precipitation;
  private readonly wind = new Vector3();
  private readonly v = new Vector3();
  private readonly at = new Vector3();

  constructor(scene: Scene) {
    this.snow = new Precipitation(scene, SNOW);
    this.rain = new Precipitation(scene, RAIN);
    this.drift = new Precipitation(scene, DRIFT);
  }

  /**
   * `wind` is the gusting speed now (m/s), `ground` the snow height under the camera,
   * `light` how lit the flakes are (daylight); `sheltered` (in a cabin) draws none.
   */
  update(
    dt: number,
    camera: Vector3,
    c: Conditions,
    wind: number,
    ground: number,
    light: number,
    sheltered = false,
  ) {
    const open = sheltered ? 0 : 1;
    windVelocity(wind * LOW_WIND, c.windFrom, this.wind);
    this.v.copy(this.wind).setY(-FALL_SNOW);
    this.snow.update(dt, camera, this.v, snowDensity(c) * open, light);
    this.v.copy(this.wind).setY(-FALL_RAIN);
    this.rain.update(dt, camera, this.v, rainDensity(c) * open, light * 0.8);
    // Blown snow skims the surface a little faster than falling snow drifts.
    this.v
      .copy(this.wind)
      .multiplyScalar(1.3 / LOW_WIND)
      .setY(0.15);
    this.at.set(camera.x, ground + 1.6, camera.z);
    this.drift.update(dt, this.at, this.v, driftDensity(c, camera.y - ground) * open, light);
  }
}
