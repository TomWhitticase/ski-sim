import {
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

/** Google Maps' Street View yellow. */
const YELLOW = 0xfbbc04;
const UP = new Vector3(0, 1, 0);
/** Head centre below the fly eye, so the camera orbits his head. */
const HEAD_BELOW_EYE = 0.1;
/** Most he leans into his flight (radians), and how fast he gets there (1/s). */
const MAX_LEAN = 0.5;
const LEAN_RATE = 4;

/**
 * Fly mode's avatar in third person: the yellow Street View figure, dangling as if
 * held by the scruff, swinging his legs and leaning the way he's flying.
 */
export class Pegman {
  readonly root = new Group();
  private readonly body = new Group();
  private readonly legs: Object3D[] = [];
  private readonly arms: Object3D[] = [];
  private lean = 0;
  private bank = 0;
  private time = 0;
  private readonly material: MeshStandardNodeMaterial;

  constructor() {
    // A little self-lit, so he stays the bright map-icon yellow in shade and at dusk.
    const material = (this.material = new MeshStandardNodeMaterial({
      color: YELLOW,
      emissive: YELLOW,
      emissiveIntensity: 0.25,
      roughness: 0.45,
    }));
    const part = (geometry: CapsuleGeometry | SphereGeometry, parent: Object3D) => {
      const mesh = new Mesh(geometry, material);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    this.root.name = 'pegman';
    this.root.add(this.body);
    // Built with the head at the origin, hanging down from it.
    part(new SphereGeometry(0.2, 20, 14), this.body);
    const torso = part(new CapsuleGeometry(0.2, 0.42, 6, 16), this.body);
    torso.position.y = -0.52;
    torso.scale.set(1, 1, 0.75);
    for (const side of [-1, 1]) {
      const shoulder = new Group();
      shoulder.position.set(side * 0.24, -0.36, 0);
      this.body.add(shoulder);
      const arm = part(new CapsuleGeometry(0.065, 0.42, 4, 10), shoulder);
      arm.position.y = -0.26;
      this.arms.push(shoulder);
      const hip = new Group();
      hip.position.set(side * 0.1, -0.86, 0);
      this.body.add(hip);
      const leg = part(new CapsuleGeometry(0.085, 0.5, 4, 10), hip);
      leg.position.y = -0.33;
      this.legs.push(hip);
    }
    this.root.visible = false;
  }

  /**
   * Hang him at the fly eye, facing `yaw`, leaning with `velocity` (world, m/s)
   * relative to the top speed.
   */
  update(dt: number, eye: Vector3, yaw: number, velocity: Vector3, topSpeed: number): void {
    this.root.visible = true;
    this.time += dt;
    this.root.position.set(eye.x, eye.y - HEAD_BELOW_EYE, eye.z);
    this.root.quaternion.setFromAxisAngle(UP, yaw);
    // Forward and sideways speed in his own frame (forward is -z).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const forward = -velocity.x * sin - velocity.z * cos;
    const right = velocity.x * cos - velocity.z * sin;
    const scale = Math.max(topSpeed, 1);
    const k = 1 - Math.exp(-LEAN_RATE * dt);
    this.lean += (Math.max(-1, Math.min(1, forward / scale)) * MAX_LEAN - this.lean) * k;
    this.bank += (Math.max(-1, Math.min(1, right / scale)) * MAX_LEAN * 0.6 - this.bank) * k;
    // Legs trail behind as he flies; a gentle dangle when hovering.
    this.body.rotation.set(-this.lean, 0, -this.bank);
    const swing = Math.sin(this.time * 2.2) * 0.18 * (1 - Math.abs(this.lean) / MAX_LEAN);
    this.legs[0]!.rotation.x = swing + this.lean * 0.4;
    this.legs[1]!.rotation.x = -swing + this.lean * 0.4;
    // Arms out a little, as in the map icon.
    this.arms[0]!.rotation.z = -0.55 - Math.sin(this.time * 1.7) * 0.05;
    this.arms[1]!.rotation.z = 0.55 + Math.sin(this.time * 1.7) * 0.05;
  }

  /** See-through (< 1) for a player flying out of body. */
  setOpacity(opacity: number): void {
    if (this.material.opacity === opacity) return;
    this.material.opacity = opacity;
    const transparent = opacity < 1;
    if (this.material.transparent !== transparent) {
      this.material.transparent = transparent;
      this.material.depthWrite = !transparent;
      this.material.needsUpdate = true;
    }
  }

  hide(): void {
    this.root.visible = false;
  }
}
