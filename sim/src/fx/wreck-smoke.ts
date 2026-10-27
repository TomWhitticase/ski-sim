import {
  cameraPosition,
  cross,
  float,
  fract,
  length,
  mix,
  positionGeometry,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
  attribute,
} from 'three/tsl';
import {
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type Scene,
  Vector3,
} from 'three/webgpu';

/** Puffs in the column at once. */
const PUFFS = 90;
/** Seconds a puff lives, rising and spreading. */
const LIFE = 9;
/** How high a puff rises over its life (m), and how wide it grows (m). */
const RISE = 38;
const START_SIZE = 1.6;
const END_SIZE = 11;

/**
 * Dark smoke rising from a crashed aircraft, so a wreck reads as one: a column of soft
 * puffs, moved entirely on the GPU (each puff's age is `fract(time / LIFE + seed)`),
 * rising, growing, drifting downwind and paling as they thin out. One draw call.
 */
export class WreckSmoke {
  readonly mesh: Mesh;
  private readonly source = uniform(new Vector3());
  private readonly time = uniform(0);
  private readonly wind = uniform(new Vector3());
  private clock = 0;

  constructor(scene: Scene) {
    const geometry = new InstancedBufferGeometry();
    const quad = new PlaneGeometry(1, 1);
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    const seeds = new Float32Array(PUFFS * 4);
    let s = 4242;
    const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < PUFFS; i++) {
      seeds[i * 4] = rand() * 2 - 1;
      seeds[i * 4 + 1] = rand() * 2 - 1;
      seeds[i * 4 + 2] = rand();
      seeds[i * 4 + 3] = i / PUFFS; // evenly spread in age, so the column is steady
    }
    geometry.setAttribute('seed', new InstancedBufferAttribute(seeds, 4));
    geometry.instanceCount = PUFFS;

    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const seed = attribute('seed', 'vec4');
    const age = fract(this.time.div(LIFE).add(seed.w));
    // Rises fast off the fire, slowing as it cools; leans downwind more the higher it is.
    const rise = age.sqrt().mul(RISE);
    const t = age.mul(LIFE);
    const wobble = sin(t.mul(0.9).add(seed.z.mul(6.28))).mul(age.mul(2.5));
    const spread = age.mul(4).add(0.4);
    const at = this.source
      .add(vec3(seed.x.mul(spread).add(wobble), rise, seed.y.mul(spread)))
      .add(this.wind.mul(t.mul(age.add(0.3))));
    // A quad facing the camera.
    const toCamera = cameraPosition.sub(at).normalize();
    const right = cross(vec3(0, 1, 0), toCamera).normalize();
    const up = cross(toCamera, right);
    const size = mix(float(START_SIZE), float(END_SIZE), age.sqrt()).mul(seed.z.mul(0.4).add(0.8));
    const p = positionGeometry;
    material.positionNode = at.add(right.mul(p.x.mul(size))).add(up.mul(p.y.mul(size)));
    const shape = smoothstep(1, 0.15, length(uv().sub(0.5).mul(2)));
    // In quickly, thinning out as it rises; near black at the fire, grey higher up.
    const fade = smoothstep(0, 0.06, age).mul(smoothstep(1, 0.35, age));
    material.colorNode = mix(vec3(0.07, 0.07, 0.075), vec3(0.42, 0.42, 0.44), age);
    material.opacityNode = shape.mul(fade).mul(0.75);

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'wreck-smoke';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * Smoke from `at` (world), blown by `wind` (m/s, world), or none when `at` is null.
   * Call every frame.
   */
  update(dt: number, at: Vector3 | null, wind: Vector3): void {
    this.mesh.visible = at !== null;
    if (!at) return;
    this.clock += dt;
    this.time.value = this.clock;
    this.source.value.copy(at);
    // Smoke drifts with the wind but not at its full speed near the ground.
    this.wind.value.copy(wind).multiplyScalar(0.6);
  }
}
