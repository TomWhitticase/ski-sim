import { describe, expect, it } from 'vitest';

import { initialStance } from '../controls/ski-stance';
import {
  blendPose,
  createState,
  decodeBatch,
  decodeState,
  encodeBatch,
  encodeState,
  Flag,
  POSE_LENGTH,
  SLOT,
  slotsToStance,
  STATE_BYTES,
  stanceToSlots,
} from './codec';

function sampleState() {
  const s = createState();
  s.time = 123_456.7;
  s.mode = 'sled';
  s.pose.set([3512.25, 2304.5, -1890.75], SLOT.position);
  s.pose.set([12.3, -4.5, 0.06], SLOT.velocity);
  const q = [0.1, 0.7, -0.1, 0.7];
  const len = Math.hypot(...q);
  s.pose.set(
    q.map((v) => v / len),
    SLOT.rotation,
  );
  s.pose.set([0.05, 0.99, -0.1], SLOT.up);
  const stance = initialStance();
  stance.crouch = 0.8;
  stance.lean = -0.4;
  stance.left.roll = 0.6;
  stance.right.yaw = -0.2;
  stance.skatePhase = 50; // keeps advancing; only its angle matters
  stance.sit = { amount: 1, height: 0.55, back: 0.2 };
  stance.grip = { x: 0.3, y: 0.6, z: -0.5 };
  s.flags = stanceToSlots(stance, s.pose) | Flag.Stowed;
  s.pose[SLOT.extra] = 0.25;
  return { s, stance };
}

describe('state codec', () => {
  it('round-trips a state within the quantisation step', () => {
    const { s } = sampleState();
    const buffer = encodeState(s);
    expect(buffer.byteLength).toBe(STATE_BYTES);
    expect(STATE_BYTES).toBeLessThan(100); // ~1 kB/s per player at 12 Hz
    const back = decodeState(buffer)!;
    expect(back.time).toBe(Math.round(s.time));
    expect(back.mode).toBe('sled');
    expect(back.flags).toBe(s.flags);
    // Position stays float32-exact (needed at resort scale).
    for (let k = 0; k < 3; k++) expect(back.pose[k]).toBeCloseTo(s.pose[k]!, 2);
    for (let i = 3; i < POSE_LENGTH; i++) {
      if (i === SLOT.stance + 14) continue; // phase, checked below
      expect(Math.abs(back.pose[i]! - s.pose[i]!)).toBeLessThan(0.05);
    }
    // Phases are sent as angles (wrapped), so sin/cos survive.
    const phase = back.pose[SLOT.stance + 14]!;
    expect(Math.sin(phase)).toBeCloseTo(Math.sin(50), 3);
  });

  it('restores the stance, sit and grip included', () => {
    const { s, stance } = sampleState();
    const back = slotsToStance(decodeState(encodeState(s))!.pose, s.flags, initialStance());
    expect(back.crouch).toBeCloseTo(stance.crouch, 3);
    expect(back.left.roll).toBeCloseTo(stance.left.roll, 3);
    expect(back.right.yaw).toBeCloseTo(stance.right.yaw, 3);
    expect(back.sit?.height).toBeCloseTo(0.55, 3);
    expect(back.grip?.z).toBeCloseTo(-0.5, 3);
    // Without the flags there's no sit or grip.
    const plain = slotsToStance(s.pose, 0, initialStance());
    expect(plain.sit).toBeUndefined();
    expect(plain.grip).toBeUndefined();
  });

  it('rejects malformed packets', () => {
    expect(decodeState(new ArrayBuffer(5))).toBeNull();
    expect(decodeBatch(new ArrayBuffer(0))).toEqual([]);
    const batch = encodeBatch([{ player: 2, state: sampleState().s }]);
    expect(decodeBatch(batch.slice(0, batch.byteLength - 1))).toEqual([]);
  });

  it('batches several players with their numbers', () => {
    const a = sampleState().s;
    const b = createState();
    b.mode = 'fly';
    b.pose[0] = -42;
    const out = decodeBatch(
      encodeBatch([
        { player: 0, state: a },
        { player: 7, state: b },
      ]),
    );
    expect(out.map((e) => e.player)).toEqual([0, 7]);
    expect(out[1]!.state.mode).toBe('fly');
    expect(out[1]!.state.pose[0]).toBe(-42);
  });

  it('blends angles the short way and keeps the quaternion unit length', () => {
    const a = new Float32Array(POSE_LENGTH);
    const b = new Float32Array(POSE_LENGTH);
    const out = new Float32Array(POSE_LENGTH);
    a[SLOT.stance + 14] = 3.0;
    b[SLOT.stance + 14] = -3.0; // 0.28 rad on, across ±π
    // 170° apart about y, with b given as the "far" sign of the same rotation.
    const half = (deg: number) => (deg * Math.PI) / 360;
    a.set([0, Math.sin(half(0)), 0, Math.cos(half(0))], SLOT.rotation);
    b.set([0, -Math.sin(half(20)), 0, -Math.cos(half(20))], SLOT.rotation);
    blendPose(a, b, 0.5, out);
    expect(Math.abs(out[SLOT.stance + 14]!)).toBeGreaterThan(3.1);
    const q = [...out.subarray(SLOT.rotation, SLOT.rotation + 4)];
    expect(Math.hypot(...q)).toBeCloseTo(1, 5);
    // Halfway is 10°, not the long way round.
    expect(2 * Math.acos(Math.abs(q[3]!)) * (180 / Math.PI)).toBeCloseTo(10, 1);
  });
});
