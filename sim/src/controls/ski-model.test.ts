import { Box3, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { createSkiGeometry, SkierModel, skiProfile } from './ski-model';
import { boardFeet, boardGeometry } from './board-stance';
import { DEFAULT_BOARD_SETUP } from './discipline';
import { initialStance, type Stance } from './ski-stance';

describe('skiProfile', () => {
  it('has a sidecut: narrower at the waist than at the shovel and tail', () => {
    const waist = skiProfile(0.48).halfWidth;
    expect(skiProfile(0.86).halfWidth).toBeGreaterThan(waist + 0.008);
    expect(skiProfile(0.06).halfWidth).toBeGreaterThan(waist + 0.004);
  });

  it('is flat underfoot with the tip turned up and a small tail kick', () => {
    expect(skiProfile(0.5).rise).toBe(0);
    expect(skiProfile(1).rise).toBeGreaterThan(0.05);
    expect(skiProfile(0).rise).toBeGreaterThan(0.015);
    expect(skiProfile(0).rise).toBeLessThan(skiProfile(1).rise);
  });
});

describe('createSkiGeometry', () => {
  it('points the top face up and the base face down', () => {
    const g = createSkiGeometry();
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const index = g.getIndex()!;
    // The first triangle of the first strip is on the top sheet; the base strip follows.
    const firstNormal = (tri: number) => {
      const i = index.getX(tri * 3);
      return new Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    };
    const trianglesPerStrip = 64 * 2;
    // Mid-ski, away from the curved ends.
    const mid = 32 * 2;
    expect(firstNormal(mid).y).toBeGreaterThan(0.9);
    expect(firstNormal(trianglesPerStrip + mid).y).toBeLessThan(-0.9);
    expect(pos.count).toBe(4 * 65 * 2);
  });
});

describe('solveJoint', () => {
  it('keeps both bone lengths and bends toward the hint', async () => {
    const { solveJoint } = await import('./ski-model');
    const hip = new Vector3(0, 1, 0);
    const ankle = new Vector3(0, 0.25, 0.05);
    const knee = solveJoint(hip, ankle, 0.43, 0.42, new Vector3(0, 0, -1));
    expect(knee.distanceTo(hip)).toBeCloseTo(0.43, 5);
    expect(knee.distanceTo(ankle)).toBeCloseTo(0.42, 5);
    expect(knee.z).toBeLessThan(0); // knee forward
  });

  it('straightens when the target is out of reach', async () => {
    const { solveJoint } = await import('./ski-model');
    const knee = solveJoint(
      new Vector3(0, 2, 0),
      new Vector3(0, 0, 0),
      0.43,
      0.42,
      new Vector3(0, 0, -1),
    );
    expect(knee.y).toBeCloseTo(2 - 0.43, 2);
  });
});

describe('SkierModel arms', () => {
  it.each([1, -1])('keeps hands and pole tips out of the snow in a deep carve (lean %i)', (dir) => {
    const model = new SkierModel();
    const stance = { ...initialStance(), crouch: 0.4, lean: dir * 0.95 };
    // Balance line tilted 55° into the turn, as in a hard carve.
    const up = new Vector3(dir * Math.sin(0.96), Math.cos(0.96), 0);
    model.apply(stance, up);
    for (const h of model.clearance.hands) expect(h).toBeGreaterThanOrEqual(0.4);
    for (const t of model.clearance.tips) expect(t).toBeGreaterThanOrEqual(0.05);
  });

  it('leaves the arms alone skiing straight', () => {
    const model = new SkierModel();
    model.apply(initialStance());
    const [l, r] = model.clearance.hands;
    expect(l).toBeCloseTo(r!, 5);
    expect(l).toBeGreaterThan(0.6);
  });
});

describe('SkierModel snowboard hands', () => {
  const gloves = (model: SkierModel) => {
    const found: { visible: boolean; pos: Vector3 }[] = [];
    model.root.updateMatrixWorld(true);
    model.root.traverse((o) => {
      if (o.name === 'board-glove')
        found.push({ visible: o.visible, pos: o.getWorldPosition(new Vector3()) });
    });
    return found;
  };

  it('gives a boarder a glove on each bare hand, hidden for a skier', () => {
    const model = new SkierModel();
    // Skiing: the gloves ride on the pole grips, so the bare-hand gloves stay hidden.
    model.apply(initialStance());
    const skiing = gloves(model);
    expect(skiing).toHaveLength(2);
    expect(skiing.every((g) => !g.visible)).toBe(true);
    // On a board: both hands get a visible glove.
    model.setSnowboard(true);
    model.apply(initialStance());
    const riding = gloves(model);
    expect(riding.filter((g) => g.visible)).toHaveLength(2);
  });

  it('keeps the boarder hands above the board in a deep carve (both edges)', () => {
    for (const dir of [1, -1]) {
      const model = new SkierModel();
      model.setSnowboard(true);
      const up = new Vector3(dir * Math.sin(0.9), Math.cos(0.9), 0);
      model.apply({ ...initialStance(), crouch: 0.4 }, up);
      // Hands never drop into the deck/snow, and each wears a visible glove near that hand.
      for (const h of model.clearance.hands) expect(h).toBeGreaterThan(0.3);
      const g = gloves(model).filter((x) => x.visible);
      expect(g).toHaveLength(2);
    }
  });

  it('hides the boarder gloves in first person (the upper body is gone)', () => {
    const model = new SkierModel();
    model.setSnowboard(true);
    model.setFirstPerson(true);
    model.apply(initialStance());
    expect(gloves(model).some((g) => g.visible)).toBe(false);
  });
});

describe('SkierModel snowboard pose', () => {
  const geoFor = (stance: 'regular' | 'goofy') => boardGeometry({ ...DEFAULT_BOARD_SETUP, stance });
  /** A riding stance and its balance line for this edge (rad, > 0 lifts the +x edge). */
  const riding = (
    stance: 'regular' | 'goofy',
    { edge = 0, push = false, phase = 0, crouch = 0.1 } = {},
  ) => {
    const s: Stance = { ...initialStance(), ...boardFeet(geoFor(stance), edge, push, phase) };
    s.crouch = crouch;
    return { s, up: new Vector3(-Math.sin(edge), Math.cos(edge), 0) };
  };
  const model = (stance: 'regular' | 'goofy') => {
    const m = new SkierModel();
    m.setSnowboard(true, stance === 'regular');
    m.setBoardSetup({ ...DEFAULT_BOARD_SETUP, stance });
    return m;
  };
  const world = (m: SkierModel, name: string) => {
    m.root.updateMatrixWorld(true);
    return m.root.getObjectByName(name)!.getWorldPosition(new Vector3());
  };
  const toeDir = (m: SkierModel, side: 'left' | 'right') =>
    new Vector3(0, 0, -1).applyQuaternion(m.footRig(side).quaternion);
  const ankle = (m: SkierModel, side: 'left' | 'right') =>
    new Vector3(0, 0.2, 0.03).applyMatrix4(m.footRig(side).matrix);

  const cases = [
    ['flat', {}],
    ['heelside', { edge: 0.6, crouch: 0.5 }],
    ['toeside', { edge: -0.6, crouch: 0.5 }],
    ['tuck', { crouch: 1 }],
    ['push', { push: true, phase: 1.5 }],
  ] as const;

  for (const stance of ['regular', 'goofy'] as const) {
    for (const [name, opts] of cases) {
      // Goofy mirrors the edges: its toe edge is at −x.
      const o = stance === 'goofy' && 'edge' in opts ? { ...opts, edge: -opts.edge } : opts;
      it(`${stance} ${name}: knees over the toes, legs uncrossed, joints in range`, () => {
        const m = model(stance);
        const { s, up } = riding(stance, o);
        m.apply(s, up);
        m.root.updateMatrixWorld(true);
        (['left', 'right'] as const).forEach((side, i) => {
          const hip = m.boardHips[i]!;
          const knee = m.boardKnees[i]!;
          const a = ankle(m, side);
          const other = ankle(m, side === 'left' ? 'right' : 'left');
          // Each hip drives its own foot (no crossed legs). Pushing, the weight is over the
          // front foot, so check the order instead: the pushing leg's hip is on its side.
          if (name !== 'push') expect(hip.distanceTo(a)).toBeLessThan(hip.distanceTo(other));
          else {
            const t = stance === 'regular' ? 1 : -1;
            const otherHip = m.boardHips[1 - i]!;
            expect(Math.sign((hip.x - otherHip.x) * t)).toBe(Math.sign((a.x - other.x) * t));
          }
          // The knee is out ahead of the hip–ankle line toward that boot's toes...
          const bend = knee.clone().sub(hip.clone().lerp(a, 0.5));
          const toe = toeDir(m, side);
          expect(bend.dot(toe)).toBeGreaterThan(0.04);
          // ...and points over them, not along the board or sideways.
          const flat = new Vector3(bend.x, 0, bend.z).normalize();
          const flatToe = new Vector3(toe.x, 0, toe.z).normalize();
          expect(flat.dot(flatToe)).toBeGreaterThan(Math.cos((40 * Math.PI) / 180));
          // Knee angle (thigh to shin): bent, never locked straight or folded flat.
          const k = hip.clone().sub(knee).angleTo(a.clone().sub(knee)) * (180 / Math.PI);
          expect(k).toBeGreaterThan(name === 'tuck' ? 40 : 70);
          expect(k).toBeLessThan(165);
        });
      });
    }

    it(`${stance}: boots stand on their bindings, at the binding angles`, () => {
      const m = model(stance);
      const { s, up } = riding(stance, { edge: 0.4 });
      m.apply(s, up);
      const leadSide = stance === 'regular' ? 'left' : 'right';
      const backSide = stance === 'regular' ? 'right' : 'left';
      for (const [side, binding] of [
        [leadSide, 'binding-lead'],
        [backSide, 'binding-back'],
      ] as const) {
        const foot = m.footRig(side).getWorldPosition(new Vector3());
        const b = world(m, binding);
        expect(Math.hypot(foot.x - b.x, foot.z - b.z)).toBeLessThan(0.02);
        expect(Math.abs(foot.y - b.y)).toBeLessThan(0.03);
      }
      // The lead foot is at the nose (−z), the boots point at the toe edge.
      expect(m.footRig(leadSide).position.z).toBeLessThan(-0.2);
      const t = stance === 'regular' ? 1 : -1;
      expect(toeDir(m, leadSide).x * t).toBeGreaterThan(0.85);
    });

    it(`${stance}: sits back over the heels heelside, drives forward toeside`, () => {
      const t = stance === 'regular' ? 1 : -1;
      const hipsAt = (edge: number) => {
        const m = model(stance);
        const { s, up } = riding(stance, { edge: -t * edge, crouch: 0.4 });
        m.apply(s, up);
        return world(m, 'chest');
      };
      const toeside = hipsAt(0.6); // toe edge down: −t · edge lifts the heel edge
      const heelside = hipsAt(-0.6);
      expect(toeside.x * t - heelside.x * t).toBeGreaterThan(0.2);
    });

    it(`${stance}: pushing, the back boot is on the snow beside the toe edge, its binding empty`, () => {
      const m = model(stance);
      const { s, up } = riding(stance, { push: true, phase: 1 });
      m.apply(s, up);
      const backSide = stance === 'regular' ? 'right' : 'left';
      const foot = m.footRig(backSide).getWorldPosition(new Vector3());
      const t = stance === 'regular' ? 1 : -1;
      expect(foot.x * t).toBeGreaterThan(0.2); // out past the toe edge
      const b = world(m, 'binding-back');
      expect(Math.hypot(foot.x - b.x, foot.z - b.z)).toBeGreaterThan(0.2);
      // The body turns to face down the board (the chest's forward points at the nose).
      const chest = m.root.getObjectByName('chest')!;
      const fwd = new Vector3(0, 0, -1).applyQuaternion(chest.quaternion);
      expect(fwd.z).toBeLessThan(-0.5);
    });
  }

  it('hangs the board below the lead boot on a chairlift, not up past the chest', () => {
    const m = model('regular');
    const s = { ...initialStance(), sit: { amount: 1, height: 0.6, back: 0.48 }, crouch: 0.62 };
    m.apply(s);
    m.root.updateMatrixWorld(true);
    const board = m.boardGroup;
    const box = new Box3().setFromObject(board);
    const foot = m.footRig('left').getWorldPosition(new Vector3());
    expect(board.visible).toBe(true);
    expect(box.max.y).toBeLessThan(foot.y + 0.65); // only the short nose end rises past the boot
    expect(box.min.y).toBeLessThan(foot.y - 0.8); // the tail hangs down
    const lead = world(m, 'binding-lead');
    expect(lead.distanceTo(foot)).toBeLessThan(0.03); // still strapped to the lead foot
  });

  it('keeps the board under the rider flying the drone', () => {
    const m = model('regular');
    const { s, up } = riding('regular');
    m.apply(s, up);
    m.setFlyingDrone(true);
    expect(m.boardGroup.visible).toBe(true);
    const foot = m.footRig('left').getWorldPosition(new Vector3());
    expect(Math.abs(foot.z + geoFor('regular').half)).toBeLessThan(0.02);
  });
});
