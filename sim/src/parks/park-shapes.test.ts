import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { type SkiState, stepSki, type SkiTerrain } from '../controls/ski-physics';
import {
  type BermFeature,
  bermHeight,
  type LineFeature,
  profileAt,
  SnowParks,
} from './park-shapes';

const RAD = Math.PI / 180;
const GRADE = Math.tan(12 * RAD);
/** A 12° hill falling to the north (world -z... i.e. heights drop as north grows). */
const hill = (_x: number, z: number) => 2000 + GRADE * z;

/**
 * A medium kicker heading north with its lip at the origin, built like
 * pipeline/parks.py's kicker_profile: run-in curving from the hill to 25°, lip 1.5 m
 * above the hill, a level table to 7 m, then a 30° landing back to the hill.
 */
function kicker(): LineFeature {
  const ta = Math.tan(25 * RAD);
  const tl = Math.tan(30 * RAD);
  const h = 1.5;
  const runIn = (2 * h) / (ta + GRADE);
  const table = h * 0.7;
  const meet = (table + tl * 7) / (tl - GRADE);
  const profile: [number, number][] = [];
  // On a 0.25 m grid through u = 0, so the lip itself is a sample.
  for (let u = Math.floor((-runIn - 2) * 4) / 4; u <= meet + 4; u += 0.25) {
    let y: number;
    if (u < -runIn) y = -GRADE * u;
    else if (u <= 0) {
      const s = u + runIn;
      y = GRADE * runIn - GRADE * s + ((ta + GRADE) * s * s) / (2 * runIn);
    } else if (u < 0.4) y = h - (h - table) * (u / 0.4);
    else if (u < 7) y = table;
    else y = Math.max(table - tl * (u - 7), -GRADE * u);
    profile.push([u, y]);
  }
  return { kind: 'kicker', east: 0, north: 0, y: 2000, heading: 0, width: 6, side: 1.2, profile };
}

function terrainWith(parks: SnowParks): SkiTerrain {
  return {
    height: (x, z) => parks.height(x, z, hill(x, z)),
    normal: (x, z, out) => parks.normal(x, z, hill, out),
  };
}

describe('profile', () => {
  it('interpolates the profile and clamps at its ends', () => {
    const p: [number, number][] = [
      [0, 0],
      [2, 1],
      [4, 0],
    ];
    expect(profileAt(p, 1)).toBeCloseTo(0.5);
    expect(profileAt(p, 3)).toBeCloseTo(0.5);
    expect(profileAt(p, -5)).toBe(0);
  });
});

describe('SnowParks', () => {
  const parks = new SnowParks([
    { index: 1, style: 'jumps', synthetic: true, features: [kicker()] },
  ]);

  it('raises the snow over the kicker and leaves the hill alone elsewhere', () => {
    expect(Math.abs(parks.height(0, 0, hill(0, 0)) - 2001.5)).toBeLessThan(0.15); // the lip
    expect(parks.height(0, -4, hill(0, -4))).toBeCloseTo(2000 + 1.05, 1); // the table
    expect(parks.height(40, 0, hill(40, 0))).toBe(hill(40, 0));
    expect(parks.height(0, 30, hill(0, 30))).toBe(hill(0, 30)); // uphill of it
    // Where it starts on the hill there's no step: its end dives under the snow.
    for (let z = 6.2; z <= 8; z += 0.1) expect(parks.height(0, z, hill(0, z))).toBe(hill(0, z));
    // Off the side the kicker's wall falls away into the snow.
    expect(parks.height(5, -4, hill(5, -4))).toBeCloseTo(hill(5, -4), 1);
  });

  it('samples the normal finely enough to see the take-off angle', () => {
    const n = parks.normal(0, 0.3, hill, new Vector3());
    // Surface rising northward at ~25° just before the lip: normal tips back south (+z).
    expect(Math.atan2(n.z, n.y) / RAD).toBeGreaterThan(18);
  });

  it('launches a skier off the lip, who lands on the landing and skis on', () => {
    const terrain = terrainWith(parks);
    const state: SkiState = {
      position: new Vector3(0, 0, 25),
      velocity: new Vector3(0, 0, -6),
      yaw: 0,
      airborne: false,
    };
    state.position.y = terrain.height(0, 25);
    const intent = { tuck: false, push: false, brake: false, jump: false };
    let takeoff: number | null = null;
    let peak = 0;
    let landing = null;
    for (let i = 0; i < 600 && !landing; i++) {
      const wasAirborne = state.airborne;
      stepSki(state, intent, 1 / 60, terrain);
      const north = -state.position.z;
      if (state.airborne && !wasAirborne && takeoff === null) takeoff = north;
      const above = state.position.y - terrain.height(state.position.x, state.position.z);
      peak = Math.max(peak, above);
      if (state.landing && takeoff !== null) landing = { north, ...state.landing };
    }
    expect(takeoff).not.toBeNull();
    expect(Math.abs(takeoff!)).toBeLessThan(1.5); // off the lip, not before
    expect(peak).toBeGreaterThan(1); // real air
    expect(landing!.north).toBeGreaterThan(5); // cleared most of the table
    expect(landing!.outcome).toBe('clean'); // the skis spot the landing slope
  });
});

describe('berms', () => {
  const berm: BermFeature = {
    kind: 'berm',
    east: 0,
    north: 0,
    y: 2000,
    grad: [0, 0],
    radius: 9,
    start: 20,
    sweep: 140,
    width: 5,
    height: 2.2,
    side: 1.2,
  };

  it('is a wall rising outside the arc, highest mid-turn, absent off its ends', () => {
    const at = (bearing: number, r: number) =>
      bermHeight(berm, r * Math.sin(bearing * RAD), r * Math.cos(bearing * RAD));
    expect(at(90, 9 + 5)).toBeCloseTo(2000 + 2.2 - 0.25, 1); // crest, mid-turn
    expect(at(90, 9 + 2.5)).toBeLessThan(at(90, 9 + 5));
    expect(at(90, 9)).toBeLessThan(2000); // the riding line stays natural snow
    expect(at(25, 14)).toBeLessThan(at(90, 14)); // tapers toward the ends
    expect(at(0, 14)).toBe(-Infinity);
  });
});
