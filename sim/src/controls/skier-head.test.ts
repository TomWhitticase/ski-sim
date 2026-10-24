import { describe, expect, it } from 'vitest';

import {
  FACE,
  GOGGLES,
  goggleOutline,
  gogglePoint,
  HELMET,
  headGeometries,
  helmetPoint,
  helmetRim,
} from './skier-head';

/** > 1 outside the helmet shell's ellipsoid, < 1 inside. */
const inShell = (x: number, y: number, z: number) =>
  (x / HELMET.rx) ** 2 + ((y - HELMET.y) / HELMET.ry) ** 2 + ((z - HELMET.z) / HELMET.rz) ** 2;
const inFace = (x: number, y: number, z: number) =>
  (x / FACE.rx) ** 2 + ((y - FACE.y) / FACE.ry) ** 2 + ((z - FACE.z) / FACE.rz) ** 2;

describe('skier head', () => {
  it('puts the lens in front of the helmet all the way across', () => {
    for (let u = -1; u <= 1; u += 0.1)
      for (const v of [0, 0.5, 1]) {
        const p = gogglePoint(u, v);
        expect(inShell(p.x, p.y, p.z)).toBeGreaterThan(1);
      }
  });

  it('keeps the helmet edge (and its peak) above the lens across the face', () => {
    for (let u = -0.6; u <= 0.6; u += 0.1) {
      const az = u * GOGGLES.span;
      const edge = helmetPoint(az, helmetRim(az));
      expect(edge.y).toBeGreaterThan(gogglePoint(u, 1).y);
    }
  });

  it('covers the ears and the back of the head lower than the forehead', () => {
    const front = helmetPoint(0, helmetRim(0)).y;
    expect(helmetPoint(Math.PI / 2, helmetRim(Math.PI / 2)).y).toBeLessThan(front - 0.07);
    expect(helmetPoint(Math.PI, helmetRim(Math.PI)).y).toBeLessThan(front - 0.09);
  });

  it('seals the goggles onto the face: no bare gap behind the frame', () => {
    for (let u = -0.8; u <= 0.8; u += 0.2) {
      const [bottom] = goggleOutline(u);
      expect(bottom).toBeLessThan(0);
      const back = gogglePoint(u, 0, -0.045, 0.006, GOGGLES.span * 1.03);
      expect(inFace(back.x, back.y, back.z)).toBeLessThan(1);
    }
  });

  it('fits the face inside the helmet', () => {
    expect(inShell(0, FACE.y + FACE.ry, FACE.z)).toBeLessThan(1);
  });

  it('builds each part once, shared by every skier', () => {
    const a = headGeometries();
    expect(headGeometries()).toBe(a);
    for (const g of Object.values(a)) expect(g.attributes.position!.count).toBeGreaterThan(0);
    expect(a.lens.attributes.color).toBeDefined();
  });
});
