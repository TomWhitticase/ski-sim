import {
  type BufferGeometry,
  DoubleSide,
  Group,
  type Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
} from 'three/webgpu';

import { type CabinLayout, cabinInteriorGeometry } from './carriers';

/**
 * The cabin you're riding in: the full cabin with its inside and see-through glass,
 * following your carrier (whose instance LiftSystem leaves out). Only one exists, so
 * it can afford detail the instanced cabins can't.
 */
export class CabinView {
  readonly root = new Group();
  private readonly solid: Mesh;
  private readonly glass: Mesh;
  private readonly built = new Map<string, { solid: BufferGeometry; glass: BufferGeometry }>();

  constructor() {
    this.root.name = 'ridden-cabin';
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    this.solid = new Mesh(
      undefined,
      new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }),
    );
    this.solid.castShadow = true;
    this.solid.receiveShadow = true;
    this.glass = new Mesh(
      undefined,
      new MeshStandardNodeMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: DoubleSide,
        roughness: 0.08,
        metalness: 0.1,
      }),
    );
    this.glass.renderOrder = 1; // after the opaque world it's seen against
    for (const m of [this.solid, this.glass]) {
      m.frustumCulled = false;
      this.root.add(m);
    }
  }

  /** Show `cabin` at the grip transform `grip` (one layout per lift, built once). */
  show(key: string, cabin: CabinLayout, grip: Matrix4): void {
    let g = this.built.get(key);
    if (!g) {
      g = cabinInteriorGeometry(cabin);
      this.built.set(key, g);
    }
    this.solid.geometry = g.solid;
    this.glass.geometry = g.glass;
    this.root.matrix.copy(grip);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.visible = true;
  }

  hide(): void {
    this.root.visible = false;
  }
}
