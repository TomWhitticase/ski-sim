import {
  Color,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

const CAPACITY = 1400;
const GRAVITY = 9.81;
const DRAG = 2.2; // 1/s: snow dust slows quickly in the air

interface Particle {
  position: Vector3;
  velocity: Vector3;
  age: number;
  life: number;
  size: number;
}

/**
 * Snow kicked up by the skis: a fixed pool of small instanced chunks, simulated on the
 * CPU (a few hundred at most). How many are thrown depends on how hard you skid or carve.
 */
export class SnowSpray {
  readonly mesh: InstancedMesh;
  private readonly particles: Particle[] = [];
  private live = 0;
  private carry = 0;
  private seed = 1;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();

  constructor() {
    const material = new MeshStandardNodeMaterial({
      color: new Color(0.97, 0.98, 1),
      emissive: new Color(0.55, 0.57, 0.6), // powdery: stays bright on its shaded side
      roughness: 1,
    });
    this.mesh = new InstancedMesh(new IcosahedronGeometry(0.028, 0), material, CAPACITY);
    this.mesh.name = 'snow-spray';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < CAPACITY; i++) {
      this.particles.push({
        position: new Vector3(),
        velocity: new Vector3(),
        age: 0,
        life: 0,
        size: 1,
      });
    }
  }

  private random(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /**
   * Throw `rate` particles/s for `dt` seconds from `at`. `slide` is the direction the
   * skis are scraping toward (spray flies that way); `carry` is the skier's velocity.
   */
  emit(at: Vector3, slide: Vector3, carry: Vector3, rate: number, dt: number): void {
    this.carry += rate * dt;
    while (this.carry >= 1 && this.live < CAPACITY) {
      this.carry -= 1;
      const p = this.particles[this.live++]!;
      const r = () => this.random() * 2 - 1;
      p.position.set(at.x + r() * 0.4, at.y + 0.05, at.z + r() * 0.4);
      const throwSpeed = 1.5 + this.random() * 3;
      p.velocity
        .copy(carry)
        .multiplyScalar(0.55)
        .addScaledVector(slide, throwSpeed)
        .add(new Vector3(r() * 1.2, 1.2 + this.random() * 2.2, r() * 1.2));
      p.age = 0;
      p.life = 0.45 + this.random() * 0.7;
      p.size = 0.6 + this.random() * 1.1;
    }
    if (this.live >= CAPACITY) this.carry = 0;
  }

  update(dt: number, groundHeight: (x: number, z: number) => number): void {
    const drag = Math.exp(-DRAG * dt);
    let i = 0;
    while (i < this.live) {
      const p = this.particles[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        // Swap-remove: keep live particles packed at the front.
        const last = this.particles[--this.live]!;
        this.particles[i] = last;
        this.particles[this.live] = p;
        continue;
      }
      p.velocity.y -= GRAVITY * dt;
      p.velocity.multiplyScalar(drag);
      p.position.addScaledVector(p.velocity, dt);
      const floor = groundHeight(p.position.x, p.position.z);
      if (p.position.y < floor) {
        p.position.y = floor;
        p.velocity.set(0, 0, 0);
      }
      // Puff out, then shrink away.
      const t = p.age / p.life;
      const size = p.size * Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.1));
      this.m.compose(p.position, this.q, this.s.setScalar(Math.max(size, 0.001)));
      this.mesh.setMatrixAt(i, this.m);
      i++;
    }
    this.mesh.count = this.live;
    if (this.live > 0) {
      const matrices = this.mesh.instanceMatrix;
      matrices.clearUpdateRanges();
      matrices.addUpdateRange(0, this.live * 16);
      matrices.needsUpdate = true;
    }
  }

  get active(): number {
    return this.live;
  }
}
