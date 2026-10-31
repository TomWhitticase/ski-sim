// What a player sends about themselves ~12 times a second, and its binary encoding.
// Everything a remote copy needs to draw them: where they are, how they're moving, the
// model's orientation and the skier's pose (`Stance`), so remote skiers carve, tuck,
// plough and flip exactly as the local one does.

import type { Stance } from '../controls/ski-stance';

export const AVATAR_MODES = [
  'fly',
  'ski',
  'glide',
  'ride',
  'sled',
  'plane',
  'heli',
  'freefall',
  'canopy',
] as const;
export type AvatarMode = (typeof AVATAR_MODES)[number];

/**
 * Pose vector layout. Position is a float32 (resort-sized coordinates need it); the rest
 * are int16 with a per-slot scale. Angle slots interpolate the short way round.
 */
export const SLOT = {
  position: 0, // x, y, z (world m): skier's feet, pilot's feet, sled's track, fly eye
  velocity: 3, // world m/s
  rotation: 6, // model root quaternion x, y, z, w
  up: 10, // body balance line in the model's frame
  stance: 13, // STANCE_SLOTS values (see stanceToSlots)
  extra: 37, // glider bank / sled steer / prop or rotor revs / canopy inflation, sled suspension / flaps or power / canopy bank
  spirit: 39, // out of body (Flag.Spirit): where you're flying, x, y, z from the body (m), and yaw; skydiving: the heading in its last slot
  // On a lift (Flag.OnCarrier): lift line, carrier and seat indices, then the feet in the
  // carrier's grip frame (m). `rotation` is then relative to the grip too, so receivers
  // put the rider on their own copy of the carrier (the lift clock is shared).
  // Flying a plane or helicopter, its first slot is the type (`AIRCRAFT_TYPES` index).
  carrier: 43,
} as const;
const STANCE_SLOTS = 24;
export const POSE_LENGTH = SLOT.carrier + 6;

/** `index` slots are whole numbers that never blend (the nearer sample's wins). */
type Kind = 'linear' | 'angle' | 'unit' | 'index' | 'sqrt';
interface SlotFormat {
  kind: Kind;
  /** int16 steps per unit ('sqrt': per square root of a unit). */
  scale: number;
}
const linear = (scale: number): SlotFormat => ({ kind: 'linear', scale });
const FORMATS: SlotFormat[] = [];
for (let i = 0; i < 3; i++) FORMATS.push(linear(1)); // float32, scale unused
for (let i = 0; i < 3; i++) FORMATS.push(linear(20)); // ±1638 m/s (top fly speed is 1500)
for (let i = 0; i < 7; i++) FORMATS.push({ kind: 'unit', scale: 32767 });
for (let i = 0; i < STANCE_SLOTS; i++) FORMATS.push(linear(2000)); // ±16 m or rad
FORMATS[SLOT.stance + 14] = { kind: 'angle', scale: 10_000 }; // skatePhase
FORMATS[SLOT.stance + 16] = { kind: 'angle', scale: 10_000 }; // polePhase
FORMATS.push(linear(2000), linear(2000));
// Flying the drone out of body: sent on a square-root scale, so it's ~2 cm steps hovering
// beside the skier, ~35 cm a kilometre away, and reaches ±33 km, enough for any resort.
const sqrt: SlotFormat = { kind: 'sqrt', scale: 180 };
FORMATS.push(sqrt, sqrt, sqrt, { kind: 'angle', scale: 10_000 });
for (let i = 0; i < 3; i++) FORMATS.push({ kind: 'index', scale: 1 });
for (let i = 0; i < 3; i++) FORMATS.push(linear(2000));

export const Flag = {
  /** Skis and poles stowed (in a cabin, on a sled). */
  Stowed: 1,
  HasSit: 2,
  HasGrip: 4,
  /** Out of body: the state is your frozen skier, and `SLOT.spirit` is where you fly. */
  Spirit: 8,
  /** On a lift's carrier, placed by `SLOT.carrier`. */
  OnCarrier: 16,
  /** On-snow rider is on a snowboard, not skis (the model shows a board, sideways stance). */
  Snowboard: 32,
} as const;

export interface PlayerState {
  /** Sender's clock when sampled (ms, performance.now()). */
  time: number;
  mode: AvatarMode;
  flags: number;
  pose: Float32Array;
}

export function createState(): PlayerState {
  return { time: 0, mode: 'ski', flags: 0, pose: new Float32Array(POSE_LENGTH) };
}

/** Bytes for one encoded state: time u32, mode u8, flags u8, position 3×f32, rest int16. */
export const STATE_BYTES = 4 + 1 + 1 + 12 + (POSE_LENGTH - 3) * 2;

export function writeState(view: DataView, offset: number, s: PlayerState): number {
  view.setUint32(offset, Math.round(s.time) >>> 0);
  view.setUint8(offset + 4, AVATAR_MODES.indexOf(s.mode));
  view.setUint8(offset + 5, s.flags);
  let o = offset + 6;
  for (let i = 0; i < 3; i++, o += 4) view.setFloat32(o, s.pose[i]!);
  for (let i = 3; i < POSE_LENGTH; i++, o += 2) {
    const f = FORMATS[i]!;
    const raw = s.pose[i]!;
    const v =
      f.kind === 'angle'
        ? wrapAngle(raw)
        : f.kind === 'sqrt'
          ? Math.sign(raw) * Math.sqrt(Math.abs(raw))
          : raw;
    view.setInt16(o, Math.max(-32767, Math.min(32767, Math.round(v * f.scale))));
  }
  return o;
}

export function readState(view: DataView, offset: number, out: PlayerState): number {
  out.time = view.getUint32(offset);
  out.mode = AVATAR_MODES[view.getUint8(offset + 4)] ?? 'ski';
  out.flags = view.getUint8(offset + 5);
  let o = offset + 6;
  for (let i = 0; i < 3; i++, o += 4) out.pose[i] = view.getFloat32(o);
  for (let i = 3; i < POSE_LENGTH; i++, o += 2) {
    const f = FORMATS[i]!;
    const v = view.getInt16(o) / f.scale;
    out.pose[i] = f.kind === 'sqrt' ? Math.sign(v) * v * v : v;
  }
  return o;
}

/** One player's state, as a guest sends it to the host. */
export function encodeState(s: PlayerState): ArrayBuffer {
  const buffer = new ArrayBuffer(STATE_BYTES);
  writeState(new DataView(buffer), 0, s);
  return buffer;
}

export function decodeState(data: ArrayBuffer): PlayerState | null {
  if (data.byteLength !== STATE_BYTES) return null;
  const s = createState();
  readState(new DataView(data), 0, s);
  return s;
}

/** The host's relay: everyone's latest state, each tagged with their player number. */
export function encodeBatch(entries: { player: number; state: PlayerState }[]): ArrayBuffer {
  const buffer = new ArrayBuffer(1 + entries.length * (1 + STATE_BYTES));
  const view = new DataView(buffer);
  view.setUint8(0, entries.length);
  let o = 1;
  for (const { player, state } of entries) {
    view.setUint8(o, player);
    o = writeState(view, o + 1, state);
  }
  return buffer;
}

export function decodeBatch(data: ArrayBuffer): { player: number; state: PlayerState }[] {
  const view = new DataView(data);
  if (data.byteLength < 1) return [];
  const count = view.getUint8(0);
  if (data.byteLength !== 1 + count * (1 + STATE_BYTES)) return [];
  const out: { player: number; state: PlayerState }[] = [];
  let o = 1;
  for (let i = 0; i < count; i++) {
    const player = view.getUint8(o);
    const state = createState();
    o = readState(view, o + 1, state);
    out.push({ player, state });
  }
  return out;
}

/** Stance into the pose vector (sit and grip, when present, are flagged). */
export function stanceToSlots(stance: Stance, pose: Float32Array): number {
  let i = SLOT.stance;
  for (const ski of [stance.left, stance.right]) {
    pose[i++] = ski.x;
    pose[i++] = ski.lift;
    pose[i++] = ski.z;
    pose[i++] = ski.yaw;
    pose[i++] = ski.roll;
  }
  pose[i++] = stance.crouch;
  pose[i++] = stance.lean;
  pose[i++] = stance.foreAft;
  pose[i++] = stance.twist;
  pose[i++] = stance.skatePhase;
  pose[i++] = stance.poleSweep;
  pose[i++] = stance.polePhase;
  pose[i++] = stance.armReach;
  const sit = stance.sit ?? { amount: 0, height: 0, back: 0 };
  pose[i++] = sit.amount;
  pose[i++] = sit.height;
  pose[i++] = sit.back;
  const grip = stance.grip ?? { x: 0, y: 0, z: 0 };
  pose[i++] = grip.x;
  pose[i++] = grip.y;
  pose[i] = grip.z;
  return (stance.sit ? Flag.HasSit : 0) | (stance.grip ? Flag.HasGrip : 0);
}

export function slotsToStance(pose: Float32Array, flags: number, out: Stance): Stance {
  let i = SLOT.stance;
  for (const ski of [out.left, out.right]) {
    ski.x = pose[i++]!;
    ski.lift = pose[i++]!;
    ski.z = pose[i++]!;
    ski.yaw = pose[i++]!;
    ski.roll = pose[i++]!;
  }
  out.crouch = pose[i++]!;
  out.lean = pose[i++]!;
  out.foreAft = pose[i++]!;
  out.twist = pose[i++]!;
  out.skatePhase = pose[i++]!;
  out.poleSweep = pose[i++]!;
  out.polePhase = pose[i++]!;
  out.armReach = pose[i++]!;
  if (flags & Flag.HasSit) {
    out.sit ??= { amount: 0, height: 0, back: 0 };
    out.sit.amount = pose[i]!;
    out.sit.height = pose[i + 1]!;
    out.sit.back = pose[i + 2]!;
  } else {
    out.sit = undefined;
  }
  i += 3;
  if (flags & Flag.HasGrip) {
    out.grip ??= { x: 0, y: 0, z: 0 };
    out.grip.x = pose[i]!;
    out.grip.y = pose[i + 1]!;
    out.grip.z = pose[i + 2]!;
  } else {
    out.grip = undefined;
  }
  return out;
}

/**
 * Blend two poses at `t` (0 = a, 1 = b): linear, angles the short way, and the
 * orientation quaternion normalised-lerped along the shorter arc.
 */
export function blendPose(a: Float32Array, b: Float32Array, t: number, out: Float32Array): void {
  for (let i = 0; i < POSE_LENGTH; i++) {
    const f = FORMATS[i]!;
    if (f.kind === 'angle') out[i] = a[i]! + wrapAngle(b[i]! - a[i]!) * t;
    else if (f.kind === 'index') out[i] = t < 0.5 ? a[i]! : b[i]!;
    else out[i] = a[i]! + (b[i]! - a[i]!) * t;
  }
  // Quaternions q and -q are the same rotation: blend toward whichever is nearer.
  const r = SLOT.rotation;
  let dot = 0;
  for (let k = 0; k < 4; k++) dot += a[r + k]! * b[r + k]!;
  const sign = dot < 0 ? -1 : 1;
  let len = 0;
  for (let k = 0; k < 4; k++) {
    out[r + k] = a[r + k]! + (sign * b[r + k]! - a[r + k]!) * t;
    len += out[r + k]! ** 2;
  }
  len = Math.sqrt(len) || 1;
  for (let k = 0; k < 4; k++) out[r + k] = out[r + k]! / len;
}

/** Both on the same carrier, or neither on one: safe to blend between. */
export function sameCarrier(a: PlayerState, b: PlayerState): boolean {
  const on = a.flags & Flag.OnCarrier;
  if (on !== (b.flags & Flag.OnCarrier)) return false;
  if (!on) return true;
  const c = SLOT.carrier;
  return a.pose[c] === b.pose[c] && a.pose[c + 1] === b.pose[c + 1];
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
