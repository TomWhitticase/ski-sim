import { Euler, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

/**
 * The map teleport, GTA V character-switch style: the camera jump-cuts up into the sky
 * in three steps above where you were (looking straight down), pans across to the
 * destination, cuts back down in three steps, then swoops into your view there.
 */

/** Camera heights above the ground for the three cuts (m). */
export const SKY_HEIGHTS = [90, 500, 2400] as const;
/** Seconds held at each cut, drifting a little (up on the way out, down on arrival). */
export const CUT_SECONDS = 0.42;
const DRIFT = 0.12;
const PAN_MIN = 1.1;
const PAN_MAX = 2.6;
/** Pan speed at the top (m/s) before the min/max clamp. */
const PAN_SPEED = 3500;
/** Seconds to blend from the last cut into your view. */
export const SETTLE_SECONDS = 0.7;
/** Straight down (a hair off, to keep the yaw meaningful). */
const LOOK_DOWN = (-89.5 * Math.PI) / 180;

export interface SkyEnd {
  /** World position (x east, z = -north) and the ground height there. */
  x: number;
  z: number;
  ground: number;
  /** Camera yaw (radians, three.js convention). */
  yaw: number;
}

export interface SkyPlan {
  from: SkyEnd;
  to: SkyEnd;
  pan: number;
  duration: number;
}

export interface SkyPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** 0-2: cutting up, 3: panning, 4-6: cutting down. A change of stage is a cut. */
  stage: number;
}

export function planSky(from: SkyEnd, to: SkyEnd): SkyPlan {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const pan = Math.min(Math.max(distance / PAN_SPEED, PAN_MIN), PAN_MAX);
  return { from, to, pan, duration: 6 * CUT_SECONDS + pan };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function shortestYaw(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Where the camera is `t` seconds into the transition. */
export function skyPose(plan: SkyPlan, t: number): SkyPose {
  const { from, to, pan } = plan;
  const up = 3 * CUT_SECONDS;
  if (t < up) {
    const stage = Math.min(2, Math.floor(t / CUT_SECONDS));
    const s = (t - stage * CUT_SECONDS) / CUT_SECONDS;
    const y = from.ground + SKY_HEIGHTS[stage]! * (1 + DRIFT * s);
    return { x: from.x, y, z: from.z, yaw: from.yaw, pitch: LOOK_DOWN, stage };
  }
  if (t < up + pan) {
    const s = smooth((t - up) / pan);
    const top = SKY_HEIGHTS[2] * (1 + DRIFT);
    return {
      x: from.x + (to.x - from.x) * s,
      y: from.ground + top + (to.ground - from.ground) * s,
      z: from.z + (to.z - from.z) * s,
      yaw: shortestYaw(from.yaw, to.yaw, s),
      pitch: LOOK_DOWN,
      stage: 3,
    };
  }
  const k = Math.min(2, Math.floor((t - up - pan) / CUT_SECONDS));
  const s = Math.min(1, (t - up - pan - k * CUT_SECONDS) / CUT_SECONDS);
  const height = SKY_HEIGHTS[2 - k]!;
  const y = to.ground + height * (1 + DRIFT * (1 - s));
  return { x: to.x, y, z: to.z, yaw: to.yaw, pitch: LOOK_DOWN, stage: 4 + k };
}

/**
 * Runs the transition on the real camera: overrides it while active, then blends it
 * into wherever the controls put it. The screen is desaturated in the sky, with a
 * flash and a whoosh at each cut.
 */
export class SkyTransition {
  private plan: SkyPlan | null = null;
  private t = 0;
  private stage = -1;
  private settle = 0;
  private readonly settleFrom = new Vector3();
  private readonly settleFromQ = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly q = new Quaternion();

  constructor(
    private readonly flash: HTMLElement,
    private readonly onCut: (up: boolean) => void,
  ) {}

  /** True while the camera is in the sky (controls are frozen). */
  get active(): boolean {
    return this.plan !== null;
  }

  start(from: SkyEnd, to: SkyEnd): void {
    this.plan = planSky(from, to);
    this.t = 0;
    this.stage = -1;
    this.settle = 0;
    document.body.classList.add('sky-transition');
  }

  /** While active: place the camera for this frame. */
  update(dt: number, camera: PerspectiveCamera): void {
    const plan = this.plan;
    if (!plan) return;
    this.t += dt;
    const pose = skyPose(plan, Math.min(this.t, plan.duration));
    if (pose.stage !== this.stage) {
      // The pan isn't a cut: it carries straight on from the top one.
      if (pose.stage !== 3) this.cut(pose.stage < 3);
      this.stage = pose.stage;
    }
    camera.position.set(pose.x, pose.y, pose.z);
    this.euler.set(pose.pitch, pose.yaw, 0);
    camera.quaternion.setFromEuler(this.euler);
    if (this.t >= plan.duration) {
      this.plan = null;
      this.settle = SETTLE_SECONDS;
      this.settleFrom.copy(camera.position);
      this.settleFromQ.copy(camera.quaternion);
      document.body.classList.remove('sky-transition');
    }
  }

  /** After the controls have set the camera: ease it in from the last cut. */
  settleCamera(dt: number, camera: PerspectiveCamera): void {
    if (this.settle <= 0) return;
    this.settle = Math.max(0, this.settle - dt);
    const k = smooth(1 - this.settle / SETTLE_SECONDS);
    camera.position.lerpVectors(this.settleFrom, camera.position, k);
    this.q.copy(this.settleFromQ).slerp(camera.quaternion, k);
    camera.quaternion.copy(this.q);
  }

  private cut(up: boolean): void {
    this.onCut(up);
    // Restart the CSS flash animation.
    this.flash.classList.remove('flash');
    void this.flash.offsetWidth;
    this.flash.classList.add('flash');
  }
}
