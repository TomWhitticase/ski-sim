import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import {
  type Camera,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  type Scene,
  Vector3,
} from 'three/webgpu';

import { type SunPosition, sunPosition } from './sun-position';

const RAD = Math.PI / 180;
const SHADOW_DISTANCE = 30_000;

/** Unit vector toward the sun in world axes (x east, y up, z south). */
export function sunDirection({ azimuth, elevation }: SunPosition): Vector3 {
  const az = azimuth * RAD;
  const el = elevation * RAD;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

/** Bluebird conditions: cloudless, very clear alpine air, sun placed for the given time. */
export class Environment {
  readonly sun: SunPosition;
  private readonly sky = new SkyMesh();

  constructor(scene: Scene, time: Date, lat: number, lon: number) {
    this.sun = sunPosition(time, lat, lon);
    const toSun = sunDirection(this.sun);

    const sky = this.sky;
    sky.scale.setScalar(300_000);
    sky.turbidity.value = 1.6;
    sky.rayleigh.value = 1.1;
    sky.mieCoefficient.value = 0.002;
    sky.mieDirectionalG.value = 0.85;
    sky.cloudCoverage.value = 0;
    sky.sunPosition.value.copy(toSun);
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    scene.add(sky);

    // Cascaded shadow maps: sharp shadows close up, coarser out to SHADOW_DISTANCE.
    // Light direction is target - position, so the target sits at the origin.
    const sunLight = new DirectionalLight(0xfff6ec, 3.2);
    sunLight.position.copy(toSun);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.bias = -0.0003;
    sunLight.shadow.normalBias = 1.5;
    // Each cascade clones this camera; its depth range must span lightMargin plus the
    // cascade's own depth, so the 500 m default is far too short.
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 80_000;
    sunLight.shadow.shadowNode = new CSMShadowNode(sunLight, {
      cascades: 3,
      maxFar: SHADOW_DISTANCE,
      mode: 'practical',
      // Ridges well outside the view still cast long shadows into it.
      lightMargin: 6000,
    });
    scene.add(sunLight, sunLight.target);
    scene.add(new HemisphereLight(0xa8c8f0, 0xdfe6ee, 0.9));

    // Thin aerial haze so distant ranges fade toward the horizon colour.
    scene.fog = new FogExp2(0xb9d0ea, 0.000011);
  }

  update(camera: Camera): void {
    this.sky.position.copy(camera.position);
  }
}
