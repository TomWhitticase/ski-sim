import { describe, expect, it } from 'vitest';

import type { Runway } from '../features/types';
import { approachCue, GLIDE_PATH, landingEnds, touchdownRating } from './approach-guide';

/** A runway from (0, 0) to 500 m north, rising `rise` m. */
const runway = (rise: number): Runway => ({
  id: 1,
  ref: '36/18',
  designators: ['36', '18'],
  line: [
    [0, 0],
    [0, 500],
  ],
  length: 500,
  width: 30,
  heading: 0,
  surface: 'asphalt',
  winter: 'cleared',
  ends: [1000, 1000 + rise],
  source: 'osm',
});

describe('landing ends', () => {
  it('lands either way on a level runway, uphill only on a steep one', () => {
    expect(landingEnds([runway(0)]).map((e) => e.name)).toEqual(['36', '18']);
    expect(landingEnds([runway(60)]).map((e) => e.name)).toEqual(['36']);
    expect(landingEnds([runway(-60)]).map((e) => e.name)).toEqual(['18']);
  });

  it('aims 60 m past the threshold, at the runway there', () => {
    const [end] = landingEnds([runway(60)]);
    expect(end!.aimX).toBeCloseTo(0);
    expect(end!.aimZ).toBeCloseTo(-60); // north is −z
    expect(end!.aimY).toBeCloseTo(1000 + 60 * 0.12);
    expect(end!.dirZ).toBeCloseTo(-1);
  });
});

describe('approach cue', () => {
  const ends = landingEnds([runway(60)]);
  const aimY = 1000 + 60 * 0.12;
  /** Flying north `out` m before the aim point, `deg` above it. */
  const at = (out: number, deg: number, vx = 0, vz = -30) =>
    approachCue(ends, 0, aimY + out * Math.tan((deg * Math.PI) / 180), -60 + out, vx, vz);

  it('two white, two red on the glide path; more white high, more red low', () => {
    expect(at(1500, GLIDE_PATH)!.white).toBe(2);
    expect(at(1500, GLIDE_PATH)!.deviation).toBeCloseTo(0, 5);
    expect(at(1500, GLIDE_PATH + 0.3)!.white).toBe(3);
    expect(at(1500, GLIDE_PATH + 1)!.white).toBe(4);
    expect(at(1500, GLIDE_PATH - 0.3)!.white).toBe(1);
    expect(at(1500, GLIDE_PATH - 1)!.white).toBe(0);
  });

  it('only on final: ahead, in range, roughly lined up and heading for it', () => {
    expect(at(1500, GLIDE_PATH, 0, 30)).toBeNull(); // flying away
    expect(at(1500, GLIDE_PATH, 30, 0)).toBeNull(); // crossing it
    expect(at(9000, GLIDE_PATH)).toBeNull(); // too far
    expect(at(-200, GLIDE_PATH)).toBeNull(); // past the aim point
    // Not downhill onto the one-way runway.
    expect(approachCue(ends, 0, 1200, -2000, 0, 30)).toBeNull();
    expect(at(1500, GLIDE_PATH)!.end.name).toBe('36');
  });
});

describe('touchdown rating', () => {
  it('smooth under 1.5 m/s, firm to 3, hard beyond', () => {
    expect(touchdownRating(0.8)).toBe('smooth');
    expect(touchdownRating(2.4)).toBe('firm');
    expect(touchdownRating(3.6)).toBe('hard');
  });
});
