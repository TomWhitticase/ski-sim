import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { createSkiGeometry, SkierModel, skiProfile } from './ski-model';
import { initialStance } from './ski-stance';

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
