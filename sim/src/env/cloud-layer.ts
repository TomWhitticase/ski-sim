// The cloud deck as something you see: its sunlit top from above (a sea of cloud filling
// the valleys, the summits standing out of it) and its grey base from below (a ceiling
// hiding the peaks). Inside it the fog does the work. Two meshes on one camera-centred
// grid, finer near you, whose heights and cover come from the weather field.

import {
  attribute,
  cameraPosition,
  float,
  length,
  mx_fractal_noise_float,
  positionLocal,
  positionWorld,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Mesh,
  MeshLambertNodeMaterial,
  type Scene,
  type Vector3,
} from 'three/webgpu';

import type { CloudLayer } from './weather';

/** Vertices along a side. */
const N = 97;
/** How far the deck reaches from the camera (m). */
export const CLOUD_RADIUS = 45_000;
/** Share of the radius spaced evenly; the rest stretches outward (~55 m apart under you). */
const LINEAR = 0.06;
/** The grid follows the camera in steps this size (m), so it doesn't swim. */
const SNAP = 200;
/** Lumps on the top and the base (m). */
const BILLOW = 70;

/** A grid coordinate (-1..1) as metres from the centre: fine near it, coarse far out. */
export function gridOffset(u: number): number {
  return CLOUD_RADIUS * (LINEAR * u + (1 - LINEAR) * u * u * u);
}

export class CloudDeck {
  private readonly top: Mesh;
  private readonly base: Mesh;
  private readonly drift = uniform(vec2(0, 0));
  private readonly centre = { x: Number.NaN, z: Number.NaN };
  private visible = false;

  constructor(scene: Scene) {
    const index: number[] = [];
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i;
        index.push(a, a + N, a + 1, a + 1, a + N, a + N + 1);
      }
    }
    // Lit cloud is as bright as the snow it shades (tone mapping brings it back to white).
    this.top = this.mesh(index, 1, new Color(1.3, 1.3, 1.32), 'cloud-top');
    // The base faces down: the same triangles wound the other way.
    const down = index.map((_, k) => index[k - (k % 3) + 2 - (k % 3)]!);
    this.base = this.mesh(down, -1, new Color(0xc4c9d1), 'cloud-base');
    scene.add(this.top, this.base);
  }

  private mesh(index: number[], up: 1 | -1, colour: Color, name: string): Mesh {
    const g = new BufferGeometry();
    g.setIndex(index);
    g.setAttribute('position', new BufferAttribute(new Float32Array(N * N * 3), 3));
    g.setAttribute('normal', new Float32BufferAttribute(new Float32Array(N * N * 3).fill(0), 3));
    const normal = g.getAttribute('normal') as BufferAttribute;
    for (let k = 0; k < N * N; k++) normal.setY(k, up);
    // Cover (0..1) and the surface's height over the ground (m), per vertex.
    g.setAttribute('cover', new BufferAttribute(new Float32Array(N * N), 1));
    g.setAttribute('clear', new BufferAttribute(new Float32Array(N * N), 1));
    const material = new MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
    const xz = positionWorld.xz;
    // Billows: the top heaves up, the base hangs down.
    const lump = mx_fractal_noise_float(vec3(xz.mul(1 / 1600), float(up)), 2);
    material.positionNode = positionLocal.add(vec3(0, lump.mul(BILLOW * up), 0));
    const n = mx_fractal_noise_float(vec3(xz.add(this.drift).mul(1 / 900), float(0.5)), 4)
      .mul(0.5)
      .add(0.5)
      .clamp(0, 1);
    const cover = attribute<'float'>('cover');
    const holes = smoothstep(cover.oneMinus().sub(0.18), cover.oneMinus().add(0.18), n);
    const ground = smoothstep(0, 60, attribute<'float'>('clear'));
    const reach = smoothstep(CLOUD_RADIUS, CLOUD_RADIUS * 0.7, length(xz.sub(cameraPosition.xz)));
    material.opacityNode = holes.mul(ground).mul(reach);
    // Brighter on the heaps, shaded in the hollows.
    material.colorNode = vec3(colour.r, colour.g, colour.b).mul(n.sub(0.5).mul(0.35).add(0.85));
    const mesh = new Mesh(g, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
  }

  /** Clouds drift with the wind (m/s, world x east and z south) over `dt` seconds. */
  blow(dt: number, windX: number, windZ: number): void {
    const d = this.drift.value as unknown as { x: number; y: number };
    d.x = (d.x - windX * dt) % 1e6;
    d.y = (d.y - windZ * dt) % 1e6;
  }

  /**
   * Rebuild round the camera from the deck over each place (`layer`, east/north metres;
   * null: none there) and the ground (`ground`, world x/z). `force` after the field changed.
   */
  update(
    camera: Vector3,
    layer: ((east: number, north: number) => CloudLayer | null) | null,
    ground: (x: number, z: number) => number,
    force: boolean,
  ): void {
    if (!layer) {
      this.show(false);
      return;
    }
    const cx = Math.round(camera.x / SNAP) * SNAP;
    const cz = Math.round(camera.z / SNAP) * SNAP;
    if (!force && this.visible && cx === this.centre.x && cz === this.centre.z) return;
    this.centre.x = cx;
    this.centre.z = cz;
    const top = this.top.geometry;
    const base = this.base.geometry;
    const tp = top.getAttribute('position') as BufferAttribute;
    const bp = base.getAttribute('position') as BufferAttribute;
    const tc = top.getAttribute('cover') as BufferAttribute;
    const bc = base.getAttribute('cover') as BufferAttribute;
    const tg = top.getAttribute('clear') as BufferAttribute;
    const bg = base.getAttribute('clear') as BufferAttribute;
    let any = false;
    for (let j = 0; j < N; j++) {
      const dz = gridOffset((2 * j) / (N - 1) - 1);
      for (let i = 0; i < N; i++) {
        const dx = gridOffset((2 * i) / (N - 1) - 1);
        const k = j * N + i;
        const x = cx + dx;
        const z = cz + dz;
        const l = layer(x, -z);
        const cover = l?.cover ?? 0;
        const g = cover > 0 ? ground(x, z) : 0;
        tp.setXYZ(k, dx, l?.top ?? 0, dz);
        bp.setXYZ(k, dx, l?.base ?? 0, dz);
        tc.setX(k, cover);
        bc.setX(k, cover);
        tg.setX(k, (l?.top ?? 0) - g);
        bg.setX(k, (l?.base ?? 0) - g);
        if (cover > 0.02) any = true;
      }
    }
    for (const a of [tp, bp, tc, bc, tg, bg]) a.needsUpdate = true;
    this.top.position.set(cx, 0, cz);
    this.base.position.set(cx, 0, cz);
    this.show(any);
  }

  private show(on: boolean): void {
    this.visible = on;
    this.top.visible = on;
    this.base.visible = on;
  }
}
