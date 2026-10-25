/**
 * Runway and helipad paint, laid out to the ICAO Annex 14 standard (Vol. I runways,
 * Vol. II heliports). None of it is data: OSM maps where a runway is, its ref and width,
 * not its paint, so the build records the markings as synthetic.
 *
 * Runway marks are rectangles in the runway's frame: `u` metres along the centreline
 * from a threshold, `v` metres across it, positive to the right looking down the runway
 * from that threshold (the way an aircraft landing on that designator sees it).
 */

export type Paint = 'white' | 'yellow' | 'red';

export interface Mark {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  paint: Paint;
}

/** Threshold stripes: start this far in, this long, and how many for a runway width. */
export const THRESHOLD = { start: 6, length: 30, edgeClear: 3, maxHalf: 27 } as const;
const STRIPES_BY_WIDTH: [number, number][] = [
  [60, 16],
  [45, 12],
  [30, 8],
  [23, 6],
  [0, 4],
];
/** Designator: starts this far past the stripes; digits this tall along the runway. */
export const DESIGNATOR = { gap: 12, height: 9, width: 3, spacing: 1.5 } as const;
/** Centreline: stripes and gaps (m), stripe width. */
export const CENTRELINE = { stripe: 30, gap: 20, width: 0.45, clear: 12 } as const;
/** Aiming point (runways under 800 m): from 150 m in, 30 m long, 4 m wide, 6 m apart. */
export const AIMING = { start: 150, length: 30, width: 4, inner: 6 } as const;

export function thresholdStripes(width: number): number {
  return STRIPES_BY_WIDTH.find(([w]) => width >= w)![1];
}

/** 3 x 5 pixel glyphs, top row first: blocky like painted runway numbers. */
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  L: ['#..', '#..', '#..', '#..', '###'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  C: ['###', '#..', '#..', '#..', '###'],
};

/**
 * A string of glyphs as marks, read from the threshold: the glyphs' bottoms at `u`, the
 * text centred on the centreline, `height` long and each glyph `width` wide.
 */
export function glyphMarks(
  text: string,
  u: number,
  height: number,
  width: number,
  spacing: number,
  paint: Paint,
): Mark[] {
  const glyphs = [...text].map((c) => GLYPHS[c.toUpperCase()]).filter((g) => g !== undefined);
  const total = glyphs.length * width + (glyphs.length - 1) * spacing;
  const pw = width / 3;
  const ph = height / 5;
  const out: Mark[] = [];
  glyphs.forEach((rows, k) => {
    const left = -total / 2 + k * (width + spacing);
    rows.forEach((row, r) => {
      // Merge each row's lit pixels into runs: fewer, cleaner rectangles.
      let c = 0;
      while (c < 3) {
        if (row[c] !== '#') {
          c++;
          continue;
        }
        let end = c;
        while (end + 1 < 3 && row[end + 1] === '#') end++;
        out.push({
          u0: u + (4 - r) * ph,
          u1: u + (5 - r) * ph,
          v0: left + c * pw,
          v1: left + (end + 1) * pw,
          paint,
        });
        c = end + 1;
      }
    });
  });
  return out;
}

/**
 * Every paint mark on a runway, as seen from each end: threshold stripes, designator,
 * aiming point (where it fits), plus the centreline and side stripes between. Marks for
 * the far end are in the near end's frame too (u from the first threshold).
 */
export function runwayMarks(length: number, width: number, designators: [string, string]): Mark[] {
  const half = width / 2;
  const out: Mark[] = [];
  // Side stripes along both edges: 0.9 m on runways 30 m wide or more, else 0.45 m.
  const side = width >= 30 ? 0.9 : 0.45;
  out.push({ u0: 0, u1: length, v0: -half, v1: -half + side, paint: 'white' });
  out.push({ u0: 0, u1: length, v0: half - side, v1: half, paint: 'white' });

  const scale = Math.min(1, (width - 2 * side - 2) / (2 * DESIGNATOR.width + DESIGNATOR.spacing));
  const stripesEnd = THRESHOLD.start + THRESHOLD.length;
  const designatorEnd = stripesEnd + DESIGNATOR.gap + DESIGNATOR.height;
  const aiming = length >= 2 * (AIMING.start + AIMING.length);
  // One end's marks in its own frame (u from its threshold, v to its right).
  const end = (designator: string): Mark[] => {
    const marks: Mark[] = [];
    const n = thresholdStripes(width);
    // Stripes reach to within 3 m of the edges (at most 27 m from the centreline), in n
    // equal slots each side of a double-width gap on the centreline.
    const reach = Math.min(half - THRESHOLD.edgeClear, THRESHOLD.maxHalf);
    const slot = reach / n;
    for (let k = 0; k < n / 2; k++) {
      const inner = slot * (0.5 + 2 * k + 0.5);
      for (const s of [-1, 1]) {
        const a = s * inner;
        const b = s * (inner + slot);
        marks.push({
          u0: THRESHOLD.start,
          u1: stripesEnd,
          v0: Math.min(a, b),
          v1: Math.max(a, b),
          paint: 'white',
        });
      }
    }
    // A letter (L/R/C) goes nearer the threshold than the number, both readable.
    const number = designator.replace(/[^0-9]/g, '');
    const letter = designator.replace(/[0-9]/g, '');
    let u = stripesEnd + DESIGNATOR.gap;
    const h = DESIGNATOR.height * scale;
    const w = DESIGNATOR.width * scale;
    const sp = DESIGNATOR.spacing * scale;
    if (letter) {
      marks.push(...glyphMarks(letter, u, h, w, sp, 'white'));
      u += h + 3;
    }
    marks.push(...glyphMarks(number, u, h, w, sp, 'white'));
    if (aiming) {
      for (const s of [-1, 1]) {
        const a = (s * AIMING.inner) / 2;
        const b = s * (AIMING.inner / 2 + AIMING.width);
        marks.push({
          u0: AIMING.start,
          u1: AIMING.start + AIMING.length,
          v0: Math.min(a, b),
          v1: Math.max(a, b),
          paint: 'white',
        });
      }
    }
    return marks;
  };
  // The far end's frame is turned round: u' = length - u, v' = -v.
  out.push(...end(designators[0]));
  for (const m of end(designators[1])) {
    out.push({ u0: length - m.u1, u1: length - m.u0, v0: -m.v1, v1: -m.v0, paint: m.paint });
  }
  // Centreline: 30 m stripes, 20 m gaps, between the designators (centred on the gap).
  const lettered = (d: string) => (/[LRC]/i.test(d) ? DESIGNATOR.height * scale + 3 : 0);
  const from = designatorEnd + lettered(designators[0]) + CENTRELINE.clear;
  const to = length - designatorEnd - lettered(designators[1]) - CENTRELINE.clear;
  const pitch = CENTRELINE.stripe + CENTRELINE.gap;
  const count = Math.floor((to - from + CENTRELINE.gap) / pitch);
  if (count > 0) {
    const start = (from + to - (count * pitch - CENTRELINE.gap)) / 2;
    for (let k = 0; k < count; k++) {
      const u0 = start + k * pitch;
      out.push({
        u0,
        u1: u0 + CENTRELINE.stripe,
        v0: -CENTRELINE.width / 2,
        v1: CENTRELINE.width / 2,
        paint: 'white',
      });
    }
  }
  return out;
}

/** A helipad mark in the pad's frame: x across, y along its heading, from its centre. */
export interface PadMark {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  paint: Paint;
}

/** A ring as `segments` thin quads: inner radius, width. Returned as quads (4 corners). */
export function ringQuads(radius: number, width: number, segments = 32): [number, number][][] {
  const out: [number, number][][] = [];
  for (let k = 0; k < segments; k++) {
    const a0 = (k / segments) * Math.PI * 2;
    const a1 = ((k + 1) / segments) * Math.PI * 2;
    const r1 = radius + width;
    out.push([
      [Math.cos(a0) * radius, Math.sin(a0) * radius],
      [Math.cos(a0) * r1, Math.sin(a0) * r1],
      [Math.cos(a1) * r1, Math.sin(a1) * r1],
      [Math.cos(a1) * radius, Math.sin(a1) * radius],
    ]);
  }
  return out;
}

export interface PadPaint {
  /** The white H: three bars. */
  h: PadMark[];
  /** Touchdown/positioning circle (yellow): inner radius and line width. */
  circle: { radius: number; width: number };
  /** TLOF perimeter line (white) just inside the pad's edge: half-size and width. */
  perimeter: { half: number; width: number } | null;
}

/**
 * A helipad's paint (ICAO Annex 14 Vol. II): the heliport H (white; red on a snow pad,
 * which has no perimeter line), the yellow touchdown/positioning circle of half the
 * pad's size, and the white TLOF perimeter line.
 */
export function helipadPaint(size: number, snow: boolean): PadPaint {
  // H: 0.3 of the pad, 3-6 m tall, 0.6 of that wide, bars a seventh of its height.
  const height = Math.max(3, Math.min(6, size * 0.3));
  const width = height * 0.6;
  const bar = height / 7;
  const paint: Paint = snow ? 'red' : 'white';
  const h: PadMark[] = [
    { x0: -width / 2, x1: -width / 2 + bar, y0: -height / 2, y1: height / 2, paint },
    { x0: width / 2 - bar, x1: width / 2, y0: -height / 2, y1: height / 2, paint },
    { x0: -width / 2 + bar, x1: width / 2 - bar, y0: -bar / 2, y1: bar / 2, paint },
  ];
  const line = Math.max(0.3, size * 0.03);
  return {
    h,
    circle: { radius: Math.max(height * 0.75, size * 0.25), width: Math.max(0.5, size * 0.03) },
    perimeter: snow ? null : { half: size / 2 - line, width: line },
  };
}
