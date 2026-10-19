import { Quaternion, Vector3 } from 'three/webgpu';

import type { FlyControls } from '../controls/fly-controls';
import type { GliderControls } from '../controls/glider-controls';
import type { SkierModel } from '../controls/ski-model';
import type { SkiControls } from '../controls/ski-controls';
import type { SnowmobileControls } from '../controls/snowmobile-controls';
import type { RideControls } from '../lifts/ride';
import { type AvatarMode, Flag, type PlayerState, SLOT, stanceToSlots } from './codec';

export interface AvatarSources {
  fly: FlyControls;
  ski: SkiControls;
  glider: GliderControls;
  ride: RideControls;
  sled: SnowmobileControls;
}

const UP = new Vector3(0, 1, 0);
const q = new Quaternion();

/** Your own avatar as remote players should see it: what each mode's model is showing. */
export function sampleAvatar(mode: AvatarMode, src: AvatarSources, out: PlayerState): void {
  const pose = out.pose;
  out.mode = mode;
  out.flags = 0;
  pose.fill(0);
  const put = (slot: number, v: { x: number; y: number; z: number }) => {
    pose[slot] = v.x;
    pose[slot + 1] = v.y;
    pose[slot + 2] = v.z;
  };
  const putRotation = (r: Quaternion) => {
    pose.set([r.x, r.y, r.z, r.w], SLOT.rotation);
  };
  const putModel = (model: SkierModel) => {
    if (model.lastStance) out.flags |= stanceToSlots(model.lastStance, pose);
    put(SLOT.up, model.lastUp);
    if (model.isStowed) out.flags |= Flag.Stowed;
  };

  if (mode === 'ski' || mode === 'ride') {
    // The skier's root: on the slope, mid-flip or sat on a chair.
    const root = src.ski.skier;
    put(SLOT.position, root.position);
    put(SLOT.velocity, mode === 'ski' ? src.ski.velocity : src.ride.velocity);
    putRotation(root.quaternion);
    putModel(src.ski.model);
  } else if (mode === 'glide') {
    const g = src.glider;
    put(SLOT.position, g.position);
    put(SLOT.velocity, g.velocity);
    putRotation(g.root.quaternion);
    putModel(g.pilot);
    pose[SLOT.extra] = g.bank;
  } else if (mode === 'sled') {
    const s = src.sled;
    put(SLOT.position, s.parts.root.position);
    put(SLOT.velocity, s.velocity);
    putRotation(s.parts.root.quaternion);
    putModel(s.rider);
    pose[SLOT.extra] = s.steer;
    pose[SLOT.extra + 1] = s.parts.body.position.y;
  } else {
    const f = src.fly;
    put(SLOT.position, f.position);
    put(SLOT.velocity, f.currentVelocity);
    putRotation(q.setFromAxisAngle(UP, f.look.yaw));
  }
}
