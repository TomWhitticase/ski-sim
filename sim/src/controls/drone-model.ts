import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

/** Most the drone tilts into its flight (rad, ~28°), and the speed it gets most of the way there (m/s). */
export const DRONE_MAX_TILT = 0.48;
const TILT_SPEED = 18;
/** How fast the tilt follows the motion (1/s): a drone banks in a fraction of a second. */
const TILT_RATE = 6;
/** Body centre above the camera (the camera hangs in its gimbal under the nose; m). */
const BODY_ABOVE_EYE = 0.09;
/** Propeller spin drawn (rad/s): hovering, plus more with speed. Real props alias at any frame rate. */
const SPIN_HOVER = 45;
const SPIN_PER_MS = 1.2;
/** Motor centres from the body centre (m): a ~50 cm folding quadcopter, arms in an X. */
const ARM_X = 0.17;
const ARM_Z = 0.14;
const PROP_RADIUS = 0.115;

/**
 * How a quadcopter leans to fly: nose down to go forward, rolled toward a sideways drift,
 * levelling out as it stops. `forward` and `right` are its speed (m/s) in its own frame.
 */
export function droneTilt(forward: number, right: number): { pitch: number; roll: number } {
  const speed = Math.sqrt(forward * forward + right * right);
  if (speed < 1e-3) return { pitch: 0, roll: 0 };
  const tilt = DRONE_MAX_TILT * Math.tanh(speed / TILT_SPEED);
  return { pitch: (-tilt * forward) / speed, roll: (-tilt * right) / speed };
}

/**
 * A small quadcopter, as other players see someone flying: grey body with a gimbal camera
 * under the nose, four arms with motors and spinning two-blade props (plus a faint blur
 * disc), green / red navigation lights, tilting the way it flies.
 */
export class Drone {
  readonly root = new Group();
  private readonly frame = new Group();
  private readonly props: Group[] = [];
  private pitch = 0;
  private roll = 0;
  private readonly last = new Vector3();
  private readonly velocity = new Vector3();
  private hasLast = false;

  constructor() {
    const mat = (color: number, roughness: number, metalness = 0) =>
      new MeshStandardNodeMaterial({ color, roughness, metalness });
    const shell = mat(0x5c6066, 0.45, 0.2);
    const dark = mat(0x1f2124, 0.6);
    const metal = mat(0x9ea3a8, 0.35, 0.8);
    const glass = mat(0x0b0c0e, 0.08, 0.6);
    const blade = mat(0x2a2c30, 0.5);
    blade.side = DoubleSide;
    const blur = new MeshStandardNodeMaterial({
      color: 0x30343a,
      roughness: 0.6,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: DoubleSide,
    });
    // Navigation lights glow, so a drone reads at a distance and at night.
    const light = (color: number) =>
      new MeshStandardNodeMaterial({ color, emissive: color, emissiveIntensity: 2.5 });
    const put = (
      parent: Group,
      geometry: BoxGeometry | CylinderGeometry | SphereGeometry | CapsuleGeometry,
      material: MeshStandardNodeMaterial,
      x = 0,
      y = 0,
      z = 0,
    ) => {
      const m = new Mesh(geometry, material);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    this.root.name = 'drone';
    this.root.add(this.frame);
    // Body: a rounded fuselage, longer than it is wide, with a battery hump on top.
    const body = put(this.frame, new CapsuleGeometry(0.055, 0.12, 6, 16), shell);
    body.rotation.x = Math.PI / 2;
    body.scale.set(1.15, 1, 0.55);
    put(this.frame, new BoxGeometry(0.075, 0.03, 0.12), dark, 0, 0.032, 0.02);
    // Gimbal and camera under the nose (-z is forward).
    put(this.frame, new BoxGeometry(0.02, 0.03, 0.02), dark, 0, -0.035, -0.085);
    const camera = put(this.frame, new SphereGeometry(0.026, 14, 10), dark, 0, -0.058, -0.09);
    camera.scale.set(1.1, 0.9, 1);
    put(
      this.frame,
      new CylinderGeometry(0.012, 0.012, 0.01, 12),
      glass,
      0,
      -0.058,
      -0.115,
    ).rotation.x = Math.PI / 2;

    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const x = sx * ARM_X;
      const z = sz * ARM_Z;
      const length = Math.sqrt(x * x + z * z);
      const arm = put(this.frame, new BoxGeometry(0.018, 0.014, length), shell, x / 2, 0, z / 2);
      arm.rotation.y = Math.atan2(x, z);
      put(this.frame, new CylinderGeometry(0.018, 0.02, 0.03, 14), dark, x, 0.012, z);
      put(this.frame, new CylinderGeometry(0.006, 0.006, 0.02, 8), metal, x, 0.034, z);
      // Lights under the motors: green on the right, red on the left (as on aircraft);
      // the rear pair white, blinking-free.
      const colour = sz < 0 ? (sx > 0 ? 0x2bff6a : 0xff2a2a) : 0xffffff;
      put(this.frame, new SphereGeometry(0.008, 8, 6), light(colour), x, -0.008, z);
      // Landing legs under the front arms' motors, the rear ones folded flat.
      if (sz < 0) put(this.frame, new BoxGeometry(0.008, 0.045, 0.008), dark, x, -0.03, z);

      const prop = new Group();
      prop.position.set(x, 0.045, z);
      for (const k of [0, 1]) {
        const b = put(prop, new BoxGeometry(PROP_RADIUS, 0.003, 0.018), blade, 0, 0, 0);
        b.position.x = (k === 0 ? 1 : -1) * PROP_RADIUS * 0.5;
        b.rotation.x = (k === 0 ? 1 : -1) * 0.18; // blade pitch
        b.castShadow = false;
      }
      const disc = new Mesh(new CylinderGeometry(PROP_RADIUS, PROP_RADIUS, 0.002, 24), blur);
      prop.add(disc);
      // Neighbouring props turn opposite ways, so the drone doesn't spin.
      prop.userData.spin = sx * sz;
      this.frame.add(prop);
      this.props.push(prop);
    }
    this.root.visible = false;
  }

  /**
   * Fly it at the camera (`eye`, world) facing `yaw`, moving at `velocity` (world, m/s;
   * omit it and it's worked out from the motion).
   */
  update(dt: number, eye: Vector3, yaw: number, velocity?: Vector3): void {
    this.root.visible = true;
    if (velocity) this.velocity.copy(velocity);
    else if (this.hasLast && dt > 0) {
      // Only what moves it (a teleport is a jump, not a burst of speed).
      const v = this.last
        .clone()
        .sub(eye)
        .multiplyScalar(-1 / dt);
      if (v.length() < 200) this.velocity.lerp(v, 1 - Math.exp(-8 * dt));
    }
    this.last.copy(eye);
    this.hasLast = true;
    this.root.position.set(eye.x, eye.y + BODY_ABOVE_EYE, eye.z);
    this.root.rotation.set(0, yaw, 0);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Its own frame: forward is (-sin, -cos), right is (cos, -sin).
    const forward = -this.velocity.x * sin - this.velocity.z * cos;
    const right = this.velocity.x * cos - this.velocity.z * sin;
    const target = droneTilt(forward, right);
    const k = 1 - Math.exp(-TILT_RATE * dt);
    this.pitch += (target.pitch - this.pitch) * k;
    this.roll += (target.roll - this.roll) * k;
    // A negative x rotation tips the nose (-z) down; a negative z rotation, the right side.
    this.frame.rotation.set(this.pitch, 0, this.roll);
    const spin = (SPIN_HOVER + SPIN_PER_MS * this.velocity.length()) * dt;
    for (const prop of this.props) prop.rotation.y += spin * (prop.userData.spin as number);
  }

  /** The frame's tilt last drawn (rad; pitch < 0 nose down, roll < 0 right side down). */
  get tilt(): { pitch: number; roll: number } {
    return { pitch: this.pitch, roll: this.roll };
  }

  /** Its speed (m/s), for its sound. */
  get speed(): number {
    return this.velocity.length();
  }

  hide(): void {
    this.root.visible = false;
    this.hasLast = false;
  }
}

/**
 * A drone's handheld controller with a phone clipped on top, held in both gloved hands.
 * Built in the chest's frame, in front of the stomach: the sticks face up toward the face
 * and the screen is tilted up to be watched. `grips` are where the hands go (chest frame).
 */
export function createDroneController(): { root: Group; grips: [Vector3, Vector3] } {
  const mat = (color: number, roughness: number, metalness = 0) =>
    new MeshStandardNodeMaterial({ color, roughness, metalness });
  const body = mat(0x3a3d42, 0.55);
  const dark = mat(0x1a1b1e, 0.7);
  const glove = mat(0x353a40, 0.85);
  // The live view from the drone: sky over snow, self-lit like a real screen.
  const screen = new MeshStandardNodeMaterial({
    color: 0x9fd2ff,
    emissive: 0x6fb6f0,
    emissiveIntensity: 0.9,
    roughness: 0.2,
  });
  const snow = new MeshStandardNodeMaterial({
    color: 0xf2f6fa,
    emissive: 0xdfe8f0,
    emissiveIntensity: 0.7,
    roughness: 0.2,
  });
  const root = new Group();
  root.name = 'drone-controller';
  const put = (
    geometry: BoxGeometry | CylinderGeometry | SphereGeometry | CapsuleGeometry,
    material: MeshStandardNodeMaterial,
    x = 0,
    y = 0,
    z = 0,
  ) => {
    const m = new Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    root.add(m);
    return m;
  };
  // Held in front of the stomach, its face tilted up toward the eyes.
  root.position.set(0, 0.3, -0.33);
  root.rotation.x = 0.7;
  root.scale.setScalar(1.2); // a little big, so it reads from a drone's height
  // Local frame: x across, y out of the face (toward the eyes), z down the controller.
  put(new BoxGeometry(0.15, 0.03, 0.08), body);
  for (const side of [-1, 1]) {
    const grip = put(new CapsuleGeometry(0.02, 0.05, 4, 10), body, side * 0.085, -0.008, 0.03);
    grip.rotation.x = Math.PI / 2;
    put(new CylinderGeometry(0.006, 0.006, 0.014, 8), dark, side * 0.04, 0.02, 0.005);
    put(new CylinderGeometry(0.01, 0.01, 0.004, 12), dark, side * 0.04, 0.028, 0.005);
    // Gloved fists round the grips, thumbs over toward the sticks.
    const fist = put(new SphereGeometry(1, 12, 8), glove, side * 0.088, 0.0, 0.035);
    fist.scale.set(0.034, 0.04, 0.05);
    const thumb = put(new CapsuleGeometry(0.012, 0.028, 4, 8), glove, side * 0.065, 0.03, 0.015);
    thumb.rotation.z = side * 1.1;
  }
  // Phone clamp on an arm at the top edge, the phone standing up from it toward the face.
  put(new BoxGeometry(0.02, 0.012, 0.03), dark, 0, 0.01, -0.045);
  const phone = new Group();
  phone.position.set(0, 0.012, -0.06);
  phone.rotation.x = 0.35; // leaning back toward the face
  root.add(phone);
  const case_ = new Mesh(new BoxGeometry(0.16, 0.008, 0.078), dark);
  case_.position.z = -0.039;
  case_.castShadow = true;
  phone.add(case_);
  const sky = new Mesh(new BoxGeometry(0.148, 0.002, 0.034), screen);
  sky.position.set(0, 0.005, -0.059);
  phone.add(sky);
  const ground = new Mesh(new BoxGeometry(0.148, 0.002, 0.032), snow);
  ground.position.set(0, 0.005, -0.024);
  phone.add(ground);
  root.updateMatrix();
  const grip = (side: number) => new Vector3(side * 0.088, 0, 0.035).applyMatrix4(root.matrix);
  return { root, grips: [grip(-1), grip(1)] };
}
