import {
  abs,
  attribute,
  cameraPosition,
  cross,
  float,
  fract,
  length,
  max,
  positionGeometry,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  PlaneGeometry,
  type Scene,
  Vector3,
} from 'three/webgpu';

/** How a layer of particles looks and moves. */
export interface ParticleStyle {
  name: string;
  /** Most particles drawn (at `density` 1). */
  capacity: number;
  /** The box of particles round its centre (m). */
  box: [number, number, number];
  /** Flake width (m). */
  size: number;
  /** Streak length per m/s of speed (s): a camera's motion blur. */
  blur: number;
  /** Side-to-side flutter (m) and how fast (rad/s). */
  wobble: number;
  wobbleRate: number;
  opacity: number;
  /** Rain is a faint additive glint; snow is opaque-ish white. */
  additive: boolean;
  colour: Color;
}

export const SNOW: ParticleStyle = {
  name: 'snowfall',
  capacity: 32_000,
  box: [30, 20, 30],
  size: 0.04,
  blur: 0.012,
  wobble: 0.35,
  wobbleRate: 1.6,
  opacity: 0.95,
  additive: false,
  colour: new Color(0.96, 0.97, 1),
};

export const RAIN: ParticleStyle = {
  name: 'rain',
  capacity: 9000,
  box: [36, 26, 36],
  size: 0.006,
  blur: 0.03,
  wobble: 0,
  wobbleRate: 0,
  opacity: 0.45,
  additive: true,
  colour: new Color(0.7, 0.75, 0.82),
};

/** Spindrift: snow blown off the surface, in a shallow layer over the ground. */
export const DRIFT: ParticleStyle = {
  name: 'spindrift',
  capacity: 9000,
  box: [50, 5, 50],
  size: 0.014,
  blur: 0.02,
  wobble: 0.5,
  wobbleRate: 3.1,
  opacity: 0.55,
  additive: false,
  colour: new Color(0.97, 0.98, 1),
};

/**
 * A box of particles round the camera, all moved on the GPU: each has a fixed seed, the
 * whole cloud drifts by `offset` (velocity integrated on the CPU, so a gust doesn't jump
 * it), and positions wrap round the box so it follows the camera. Particles are world-
 * anchored: you ski or fly through them. Cost is one instanced draw; the count follows
 * the density.
 */
export class Precipitation {
  readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly centre = uniform(new Vector3());
  private readonly offset = uniform(new Vector3());
  private readonly velocity = uniform(new Vector3(0, -1, 0));
  private readonly time = uniform(0);
  private readonly brightness = uniform(1);
  private readonly fade = uniform(1);
  private readonly drift = new Vector3();
  private elapsed = 0;

  constructor(
    scene: Scene,
    readonly style: ParticleStyle,
  ) {
    const geometry = new InstancedBufferGeometry();
    const quad = new PlaneGeometry(1, 1);
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    // A fixed pseudo-random seed per particle (xyz in the box, w its own phase and size).
    const seeds = new Float32Array(style.capacity * 4);
    let s = 12345;
    const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    geometry.setAttribute('seed', new InstancedBufferAttribute(seeds, 4));
    geometry.instanceCount = 0;
    this.geometry = geometry;

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: style.additive ? AdditiveBlending : NormalBlending,
    });
    const seed = attribute('seed', 'vec4');
    const box = vec3(...style.box);
    // Where the particle is in the world, then wrapped into the box round the camera.
    const moving = seed.xyz.mul(box).add(this.offset);
    const phase = seed.w.mul(6.2832);
    const flutter = vec3(
      sin(this.time.mul(style.wobbleRate).add(phase)),
      sin(this.time.mul(style.wobbleRate * 0.7).add(phase.mul(2))).mul(0.3),
      sin(this.time.mul(style.wobbleRate * 1.3).add(phase.mul(3))),
    ).mul(style.wobble);
    const rel = fract(moving.sub(this.centre).div(box).add(0.5)).sub(0.5);
    const at = rel.mul(box).add(this.centre).add(flutter);
    // A quad along the motion (a blurred streak when fast, a flake when slow), facing you.
    const speed = length(this.velocity);
    const axis = this.velocity.div(max(speed, 0.001));
    const toCamera = cameraPosition.sub(at);
    const distance = length(toCamera);
    const side = cross(axis, toCamera).normalize();
    // Never thinner than ~1.5 px, so distant flakes shimmer instead of vanishing; the
    // ones grown for that are made fainter to keep the same amount of white.
    const size = float(style.size).mul(seed.w.mul(0.8).add(0.6));
    const minSize = distance.mul(0.0022);
    const width = max(size, minSize);
    const streak = max(width, speed.mul(style.blur));
    const p = positionGeometry;
    material.positionNode = at.add(side.mul(p.x.mul(width))).add(axis.mul(p.y.mul(streak)));

    // Fading near the camera (no blobs) and at the box edges
    // (no popping as they wrap).
    const d = uv().sub(0.5).mul(2);
    // A round flake; on a stretched quad the same circle is a soft streak.
    const shape = smoothstep(1, 0.2, length(d));
    const edges = smoothstep(0.5, 0.38, max(abs(rel.x), max(abs(rel.y), abs(rel.z))));
    const near = smoothstep(0.3, 1.2, distance);
    const thin = size.div(width).pow(1.5);
    material.colorNode = vec3(style.colour.r, style.colour.g, style.colour.b).mul(this.brightness);
    material.opacityNode = shape.mul(edges).mul(near).mul(thin).mul(this.fade).mul(style.opacity);

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = style.name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * Move the cloud by `velocity` (m/s, world axes) for `dt`, centred on `centre`, with
   * `density` 0..1 of the particles drawn at `brightness` (daylight on them).
   */
  update(
    dt: number,
    centre: Vector3,
    velocity: Vector3,
    density: number,
    brightness: number,
  ): void {
    const count = Math.round(Math.min(1, Math.max(0, density)) * this.style.capacity);
    this.mesh.visible = count > 0;
    this.geometry.instanceCount = count;
    if (count === 0) return;
    this.elapsed += dt;
    this.drift.addScaledVector(velocity, dt);
    // Keep the integrated offset small for float precision: whole boxes don't matter.
    const [bx, by, bz] = this.style.box;
    this.drift.set(this.drift.x % bx, this.drift.y % by, this.drift.z % bz);
    this.offset.value.copy(this.drift);
    this.velocity.value.copy(velocity);
    this.centre.value.copy(centre);
    this.time.value = this.elapsed % 1000;
    this.brightness.value = brightness;
    // Thin snow is fewer flakes, not fainter ones, until the very lightest.
    this.fade.value = Math.min(1, density * 8);
  }
}
