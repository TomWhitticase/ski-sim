import { describe, expect, it } from 'vitest';

import {
  AIMING,
  glyphMarks,
  helipadPaint,
  runwayMarks,
  THRESHOLD,
  thresholdStripes,
} from './airfield-markings';

describe('runway markings (ICAO Annex 14)', () => {
  it('picks the number of threshold stripes by runway width', () => {
    expect(thresholdStripes(15)).toBe(4);
    expect(thresholdStripes(23)).toBe(6);
    expect(thresholdStripes(40)).toBe(8);
    expect(thresholdStripes(45)).toBe(12);
    expect(thresholdStripes(60)).toBe(16);
  });

  it('lays out Courchevel: stripes, designators, aiming points and centreline inside the runway', () => {
    const length = 537;
    const width = 40;
    const marks = runwayMarks(length, width, ['22', '04']);
    for (const m of marks) {
      expect(m.u0).toBeGreaterThanOrEqual(-1e-9);
      expect(m.u1).toBeLessThanOrEqual(length + 1e-9);
      expect(Math.abs(m.v0)).toBeLessThanOrEqual(width / 2 + 1e-9);
      expect(Math.abs(m.v1)).toBeLessThanOrEqual(width / 2 + 1e-9);
      expect(m.u1).toBeGreaterThan(m.u0);
      expect(m.v1).toBeGreaterThan(m.v0);
    }
    // Eight stripes at each end, 30 m long from 6 m in, within 3 m of the edges.
    const stripes = marks.filter((m) => m.u1 - m.u0 === THRESHOLD.length && m.v1 - m.v0 < 4);
    const near = stripes.filter((m) => m.u0 === THRESHOLD.start);
    const far = stripes.filter((m) => m.u1 === length - THRESHOLD.start);
    expect(near).toHaveLength(8);
    expect(far).toHaveLength(8);
    expect(Math.max(...near.map((m) => m.v1))).toBeCloseTo(width / 2 - THRESHOLD.edgeClear);
    // A double-width gap on the centreline.
    const inner = Math.min(...near.filter((m) => m.v0 > 0).map((m) => m.v0));
    const stripeWidth = near[0]!.v1 - near[0]!.v0;
    expect(inner * 2).toBeCloseTo(stripeWidth * 2);
    // Aiming points from 150 m in at both ends (the runway is long enough for both).
    const aiming = marks.filter(
      (m) => m.u1 - m.u0 === AIMING.length && m.v1 - m.v0 === AIMING.width,
    );
    expect(aiming).toHaveLength(4);
    expect(aiming.filter((m) => m.u0 === AIMING.start)).toHaveLength(2);
    // A centreline between the designators, and no stripe overlapping a designator.
    const centre = marks.filter((m) => m.v1 - m.v0 < 0.5 && m.u1 - m.u0 === 30);
    expect(centre.length).toBeGreaterThanOrEqual(5);
  });

  it('turns the far end round, so its designator reads from its own approach', () => {
    const marks = runwayMarks(500, 30, ['09', '27']);
    // The "9" glyph's top row is far from the 09 threshold; the "27" glyphs sit at the
    // other end and their tops face u = 0 (toward its threshold's far side).
    const nearDigits = marks.filter((m) => m.u0 >= 48 && m.u1 <= 57.01);
    const farDigits = marks.filter((m) => m.u0 >= 500 - 57.01 && m.u1 <= 500 - 48);
    expect(nearDigits.length).toBeGreaterThan(4);
    expect(farDigits.length).toBeGreaterThan(4);
    // Seen from the 09 approach, "0" is on the left (negative v): its middle row is
    // "#.#" (two marks), the "9"'s on the right is "###" (one).
    const middle = glyphMarks('09', 48, 9, 3, 1.5, 'white').filter((m) => m.u0 === 48 + 2 * 1.8);
    expect(middle.filter((m) => m.v1 <= 0)).toHaveLength(2);
    expect(middle.filter((m) => m.v0 >= 0)).toHaveLength(1);
    // From the 27 end, its "2" is on its approach's left: +v in the 09 frame.
    expect(farDigits.some((m) => m.v0 >= 0.7)).toBe(true);
  });

  it('fits a narrow runway: Méribel is 15 m wide', () => {
    const marks = runwayMarks(406, 15, ['15', '33']);
    for (const m of marks) expect(Math.abs(m.v0)).toBeLessThanOrEqual(7.5 + 1e-9);
    // Side stripes 0.45 m on a runway under 30 m wide.
    expect(
      marks.some((m) => m.u0 === 0 && m.u1 === 406 && Math.abs(m.v1 - m.v0 - 0.45) < 1e-9),
    ).toBe(true);
  });

  it('leaves the aiming point off a short strip', () => {
    const marks = runwayMarks(250, 30, ['02', '20']);
    expect(marks.some((m) => m.u0 === AIMING.start)).toBe(false);
  });
});

describe('helipad paint (ICAO Annex 14 Vol. II)', () => {
  it('has an H, a touchdown circle and a perimeter; snow pads a red H and no perimeter', () => {
    const paved = helipadPaint(20, false);
    expect(paved.h).toHaveLength(3);
    expect(paved.h.every((m) => m.paint === 'white')).toBe(true);
    expect(paved.circle.radius).toBeLessThan(10);
    expect(paved.perimeter!.half + paved.perimeter!.width).toBeCloseTo(10);
    const snow = helipadPaint(20, true);
    expect(snow.h.every((m) => m.paint === 'red')).toBe(true);
    expect(snow.perimeter).toBeNull();
    // The H fits inside the circle.
    const reach = Math.max(...paved.h.map((m) => Math.hypot(m.x1, m.y1)));
    expect(reach).toBeLessThan(paved.circle.radius + 0.01);
  });
});
