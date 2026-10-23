import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { type SkiState, stepSki, type SkiTerrain } from '../controls/ski-physics';
import {
  type BermFeature,
  bermHeight,
  type HalfpipeFeature,
  halfpipeEdges,
  halfpipeHeight,
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

describe('halfpipes', () => {
  const PITCH = Math.tan(17 * RAD);
  /** A 17° hill falling to the north, the pipe's floor lying on it. */
  const slope = (_x: number, z: number) => 2000 + PITCH * z;
  // Built like pipeline/parks.py's _halfpipe_feature on that hill.
  const a = 85 * RAD;
  const pipe: HalfpipeFeature = {
    kind: 'halfpipe',
    east: 0,
    north: 0,
    y: 2000,
    heading: 0,
    profile: [
      [-15, 15 * PITCH],
      [165, -165 * PITCH],
    ],
    length: 150,
    flat: 15,
    radius: (5.5 - 0.4) / (1 - Math.cos(a)),
    vert: 85,
    height: 5.5,
    deck: 4,
    dropIn: 24,
    exit: 10,
    side: 1.2,
  };
  const edges = halfpipeEdges(pipe);
  const floor = (u: number) => 2000 - PITCH * u;

  it('has a flat bottom, transitions up to a near-vertical coping and level decks', () => {
    const at = (v: number) => halfpipeHeight(pipe, 60, v) - floor(60);
    expect(at(0)).toBeCloseTo(0);
    expect(at(7)).toBeCloseTo(0);
    expect(edges.coping - edges.flat).toBeGreaterThan(5);
    expect(edges.coping - edges.flat).toBeLessThan(6);
    expect(at(edges.coping)).toBeCloseTo(5.5);
    expect(at(-edges.coping)).toBeCloseTo(5.5); // both walls
    expect(at(edges.coping + 2)).toBeCloseTo(5.5); // the deck
    expect(at(edges.deck + 2)).toBeCloseTo(5.5 - 2 * 1.2); // the outer wall falls away
    // The wall steepens all the way up: ~45° halfway round, past 80° below the coping.
    const angle = (v: number) => Math.atan((at(v + 0.01) - at(v - 0.01)) / 0.02) / RAD;
    expect(angle(edges.flat + pipe.radius * Math.sin(45 * RAD))).toBeCloseTo(45, 0);
    expect(angle(edges.coping - 0.03)).toBeGreaterThan(80);
    expect(angle(edges.coping - 0.03)).toBeLessThan(86);
  });

  it('grows its walls out of the floor at the drop-in and ends on the hill', () => {
    const wall = (u: number) => halfpipeHeight(pipe, u, edges.coping) - floor(u);
    expect(wall(0)).toBeCloseTo(0);
    expect(wall(12)).toBeCloseTo(2.75, 1);
    expect(wall(30)).toBeCloseTo(5.5);
    expect(wall(150)).toBeCloseTo(0);
    expect(halfpipeHeight(pipe, -16, 0)).toBe(-Infinity);
    expect(halfpipeHeight(pipe, 166, 0)).toBe(-Infinity);
    // Its ends dive under the snow: no step where the floor meets the hill.
    expect(halfpipeHeight(pipe, -15, 0)).toBeLessThan(floor(-15));
  });

  /** Ride from the middle of the floor toward the east wall, `angle` deg off the pipe. */
  function ride(speed: number, angle: number) {
    const parks = new SnowParks([{ index: 1, style: 'jumps', synthetic: true, features: [pipe] }]);
    const terrain: SkiTerrain = {
      height: (x, z) => parks.height(x, z, slope(x, z)),
      normal: (x, z, out) => parks.normal(x, z, slope, out),
    };
    const yaw = -angle * RAD; // positive yaw turns left (west); the east wall is to the right
    const state: SkiState = {
      position: new Vector3(0, 0, -60),
      velocity: new Vector3(Math.sin(angle * RAD) * speed, 0, -Math.cos(angle * RAD) * speed),
      yaw,
      airborne: false,
    };
    state.position.y = terrain.height(0, -60);
    const n = new Vector3();
    terrain.normal!(0, -60, n);
    state.velocity.addScaledVector(n, -state.velocity.dot(n));
    const intent = { tuck: false, push: false, brake: false, jump: false };
    let takeoff: { across: number; height: number } | null = null;
    let air = -Infinity;
    let landing: { across: number; outcome: string } | null = null;
    for (let i = 0; i < 600 && !landing; i++) {
      const was = state.airborne;
      stepSki(state, intent, 1 / 60, terrain);
      const across = state.position.x; // the pipe runs north, so east is across it
      const u = -state.position.z;
      const lip = floor(u) + pipe.height;
      if (state.airborne && !was) takeoff = { across, height: state.position.y - lip };
      if (state.airborne) air = Math.max(air, state.position.y - lip);
      if (state.landing && takeoff) landing = { across, outcome: state.landing.outcome };
    }
    return { takeoff, air, landing };
  }

  it('carves up a wall, flies above the coping and lands back on the transition', () => {
    const { takeoff, air, landing } = ride(15, 55);
    expect(takeoff).not.toBeNull();
    expect(Math.abs(takeoff!.across - edges.coping)).toBeLessThan(0.3); // off the coping
    expect(takeoff!.height).toBeGreaterThan(-0.3);
    expect(air).toBeGreaterThan(1.5); // real air above the lip
    expect(landing).not.toBeNull();
    expect(landing!.across).toBeLessThan(edges.coping - 0.3); // back in the pipe, not the deck
    expect(landing!.across).toBeGreaterThan(edges.flat);
    expect(landing!.outcome).toBe('clean'); // skis aligned with the steep transition
  });

  it('without the speed to reach the coping, rides back down the wall', () => {
    const { takeoff } = ride(8, 70);
    expect(takeoff).toBeNull();
  });
});
