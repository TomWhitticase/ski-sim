import { describe, expect, it } from 'vitest';

import { boardFeet, boardGeometry, footYaw, pushAmount, stanceIsRegular } from './board-stance';
import { BOARD_PUSH, boardPushes, DEFAULT_BOARD_SETUP } from './discipline';
import { initialStance, updateStance, type StanceInput } from './ski-stance';

const regular = boardGeometry(DEFAULT_BOARD_SETUP);
const goofy = boardGeometry({ ...DEFAULT_BOARD_SETUP, stance: 'goofy' });
/** Where a boot with this yaw points its toes (board frame x, z). */
const toes = (yaw: number) => [-Math.sin(yaw), -Math.cos(yaw)] as const;

describe('boardGeometry', () => {
  it('puts the bindings ~55 cm apart on a 156', () => {
    expect(2 * regular.half).toBeGreaterThan(0.52);
    expect(2 * regular.half).toBeLessThan(0.58);
  });
});

describe('footYaw', () => {
  it('points the toes at the toe edge, turned toward the nose by the binding angle', () => {
    const [x, z] = toes(footYaw(15, true));
    expect(x).toBeCloseTo(Math.cos((15 * Math.PI) / 180)); // regular: toe edge at +x
    expect(z).toBeLessThan(0); // toward the nose (−z)
    const [bx, bz] = toes(footYaw(-6, true));
    expect(bx).toBeGreaterThan(0.99);
    expect(bz).toBeGreaterThan(0); // duck: the back foot turns toward the tail
    const [gx, gz] = toes(footYaw(15, false));
    expect(gx).toBeLessThan(-0.95); // goofy: toe edge at −x
    expect(gz).toBeLessThan(0);
  });
});

describe('boardFeet', () => {
  it('leads with the left foot regular and the right foot goofy, both at the nose', () => {
    const r = boardFeet(regular, 0, false, 0);
    expect(r.left.z).toBeCloseTo(-regular.half);
    expect(r.right.z).toBeCloseTo(regular.half);
    const g = boardFeet(goofy, 0, false, 0);
    expect(g.right.z).toBeCloseTo(-goofy.half);
    expect(g.left.z).toBeCloseTo(goofy.half);
    expect(stanceIsRegular(r.left, r.right, false)).toBe(true);
    expect(stanceIsRegular(g.left, g.right, true)).toBe(false);
  });

  it('rolls both bound feet with the edge', () => {
    const { left, right } = boardFeet(regular, 0.4, false, 0);
    expect(left.roll).toBe(0.4);
    expect(right.roll).toBe(0.4);
  });

  it('pushes with the back foot on the snow beside the toe edge, behind the front binding', () => {
    for (const geo of [regular, goofy]) {
      const toe = geo.regular ? 1 : -1;
      const zs: number[] = [];
      let lifted = false;
      for (let i = 0; i < 32; i++) {
        const phase = (i / 32) * 2 * Math.PI;
        const { left, right } = boardFeet(geo, 0.3, true, phase);
        const [lead, back] = geo.regular ? [left, right] : [right, left];
        expect(lead.z).toBeCloseTo(-geo.half); // the front foot stays strapped in
        expect(lead.roll).toBe(0); // the board rides flat while you push
        expect(back.x * toe).toBeGreaterThan(geo.halfWidth + 0.05); // off the toe edge
        expect(back.z).toBeGreaterThan(-geo.half + 0.05); // behind the front binding
        expect(back.z).toBeLessThan(geo.half + 0.1);
        expect(pushAmount(back, geo.halfWidth)).toBe(1);
        // Toes forward along the board, turned out a little to the toe side.
        const [tx, tz] = toes(back.yaw);
        expect(tz).toBeLessThan(-0.9);
        expect(tx * toe).toBeGreaterThan(0);
        zs.push(back.z);
        if (back.lift > 0.03) lifted = true;
      }
      // A stride: planted at the front, driven back, lifted forward again.
      expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.4);
      expect(zs[0]).toBeLessThan(zs[10]!);
      expect(lifted).toBe(true);
    }
  });

  it('reads a strapped-in back foot as not pushing', () => {
    const { right } = boardFeet(regular, 0, false, 0);
    expect(pushAmount(right, regular.halfWidth)).toBe(0);
  });
});

describe('board stance', () => {
  const input = (over: Partial<StanceInput> = {}): StanceInput => ({
    speed: 1,
    turnRate: 0,
    balanceEdge: 0,
    plough: false,
    skate: true,
    tuck: false,
    airborne: false,
    board: regular,
    ...over,
  });

  it('steps once per push stride, and settles the foot back in when you stop', () => {
    const stance = initialStance();
    let steps = 0;
    for (let i = 0; i < 60 * 4; i++) if (updateStance(stance, input(), 1 / 60).step) steps++;
    // ~0.95 strides a second.
    expect(steps).toBeGreaterThanOrEqual(3);
    expect(steps).toBeLessThanOrEqual(4);
    expect(pushAmount(stance.right, regular.halfWidth)).toBeGreaterThan(0.9);
    for (let i = 0; i < 60; i++) updateStance(stance, input({ skate: false }), 1 / 60);
    expect(pushAmount(stance.right, regular.halfWidth)).toBeLessThan(0.05);
    expect(stance.right.z).toBeCloseTo(regular.half, 2);
  });

  it('rides lower as the edge comes up, and tucks right down', () => {
    const at = (over: Partial<StanceInput>) => {
      const s = initialStance();
      for (let i = 0; i < 120; i++) updateStance(s, input({ skate: false, ...over }), 1 / 60);
      return s.crouch;
    };
    expect(at({ balanceEdge: 0.7 })).toBeGreaterThan(at({ balanceEdge: 0 }) + 0.3);
    expect(at({ tuck: true })).toBeGreaterThan(0.95);
  });
});

describe('boardPushes', () => {
  it('pushes slowly on the flat, not once you are moving, and resumes a little slower', () => {
    expect(boardPushes(0, 0, false)).toBe(true);
    expect(boardPushes(BOARD_PUSH.stopSpeed + 0.1, 0, true)).toBe(false);
    // At the push's own top speed it keeps pushing (no push–glide flicker)...
    expect(boardPushes(BOARD_PUSH.maxSpeed + 0.05, 0, true)).toBe(true);
    // ...and between the resume and stop speeds it keeps doing what it was doing.
    const mid = (BOARD_PUSH.stopSpeed + BOARD_PUSH.resumeSpeed) / 2;
    expect(boardPushes(mid, 0, true)).toBe(true);
    expect(boardPushes(mid, 0, false)).toBe(false);
  });

  it('glides instead on a slope steep enough, and always pushes uphill', () => {
    expect(boardPushes(0.5, Math.sin((8 * Math.PI) / 180), false)).toBe(false);
    expect(boardPushes(0.5, Math.sin((2 * Math.PI) / 180), false)).toBe(true);
    expect(boardPushes(0.5, -0.3, true)).toBe(true);
  });
});
