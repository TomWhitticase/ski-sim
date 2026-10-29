import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import {
  doublePoling,
  type Landing,
  SKI,
  type SkiIntent,
  type SkiState,
  skiDirection,
  type SkiTerrain,
  stepSki,
} from './ski-physics';
import { type LineFeature, type RailContact, SnowParks } from '../parks/park-shapes';
import { DEFAULT_HANDLING, SKI_PRESETS, type SkiHandling, skiHandling } from './ski-setup';

const RAD = Math.PI / 180;
const idle: SkiIntent = { tuck: false, push: false, brake: false, jump: false };

/** Plane falling away to the south (+z) at `degrees`. */
function slope(degrees: number): SkiTerrain {
  const grade = Math.tan(degrees * RAD);
  return { height: (_x, z) => 2000 - z * grade };
}

function skier(terrain: SkiTerrain, yaw: number): SkiState {
  return {
    position: new Vector3(0, terrain.height(0, 0), 0),
    velocity: new Vector3(),
    yaw,
    airborne: false,
  };
}

function run(
  state: SkiState,
  terrain: SkiTerrain,
  seconds: number,
  intent = idle,
  skis: SkiHandling = DEFAULT_HANDLING,
) {
  for (let t = 0; t < seconds; t += 1 / 60) stepSki(state, intent, 1 / 60, terrain, skis);
  return state;
}

// Yaw π faces south (downhill on these slopes); yaw π/2 faces west (across the slope).
const DOWNHILL = Math.PI;
const ACROSS = Math.PI / 2;

describe('stepSki', () => {
  it('stays put on the flat and on gentle slopes below the friction angle', () => {
    expect(run(skier(slope(0), DOWNHILL), slope(0), 5).velocity.length()).toBe(0);
    expect(run(skier(slope(2), DOWNHILL), slope(2), 5).velocity.length()).toBeLessThan(0.01);
  });

  it('accelerates down the fall line toward the drag-limited speed', () => {
    const t = slope(20);
    const state = run(skier(t, DOWNHILL), t, 60);
    const theta = 20 * RAD;
    const terminal = Math.sqrt(
      (SKI.gravity * Math.sin(theta) -
        DEFAULT_HANDLING.snowFriction * SKI.gravity * Math.cos(theta)) /
        SKI.dragUpright,
    );
    expect(state.velocity.length()).toBeGreaterThan(terminal * 0.95);
    expect(state.velocity.length()).toBeLessThan(terminal * 1.02);
    expect(state.velocity.z).toBeGreaterThan(0); // heading south
  });

  it('goes faster in a tuck, but never past the speed cap', () => {
    const t = slope(25);
    const upright = run(skier(t, DOWNHILL), t, 60).velocity.length();
    const tuck = run(skier(t, DOWNHILL), t, 60, { ...idle, tuck: true }).velocity.length();
    expect(tuck).toBeGreaterThan(upright);
    const steep = slope(45);
    const capped = run(skier(steep, DOWNHILL), steep, 60, { ...idle, tuck: true });
    expect(capped.velocity.length()).toBeLessThanOrEqual(DEFAULT_HANDLING.maxSpeed + 1e-6);
  });

  it('holds still when the skis are across a moderate slope', () => {
    const t = slope(20);
    expect(run(skier(t, ACROSS), t, 5).velocity.length()).toBeLessThan(0.5);
  });

  it('carves: turning the skis redirects the velocity and a hockey stop stops you', () => {
    const t = slope(15);
    const state = run(skier(t, DOWNHILL), t, 6);
    const before = state.velocity.length();
    state.yaw = DOWNHILL - 30 * RAD; // turn 30° right (facing south, right is west)
    run(state, t, 2);
    expect(state.velocity.x).toBeLessThan(-0.2 * state.velocity.length()); // now heading SSW
    expect(state.velocity.length()).toBeGreaterThan(before * 0.6);

    state.yaw = ACROSS; // skis sideways
    run(state, t, 4, { ...idle, brake: true });
    expect(state.velocity.length()).toBeLessThan(1);
  });

  it('skates along a traverse instead of being pinned by the side slope', () => {
    for (const degrees of [8, 15]) {
      const t = slope(degrees);
      const state = run(skier(t, ACROSS), t, 4, { ...idle, push: true });
      expect(state.velocity.length()).toBeGreaterThan(SKI.pushMaxSpeed * 0.8);
      expect(Math.abs(state.velocity.z)).toBeLessThan(0.2 * state.velocity.length()); // along it
    }
  });

  it('skates on the flat up to a walking-pace limit', () => {
    const state = run(skier(slope(0), DOWNHILL), slope(0), 10, { ...idle, push: true });
    expect(state.velocity.length()).toBeGreaterThan(SKI.pushMaxSpeed * 0.9);
    expect(state.velocity.length()).toBeLessThan(SKI.pushMaxSpeed * 1.1);
  });

  it('flies off a drop and lands back on the snow', () => {
    // 15° slope with a 5 m step down at z = 30.
    const t: SkiTerrain = { height: (_x, z) => 2000 - z * Math.tan(15 * RAD) - (z > 30 ? 5 : 0) };
    const state = skier(t, DOWNHILL);
    state.velocity.set(0, -15 * Math.sin(15 * RAD), 15 * Math.cos(15 * RAD));
    let wasAirborne = false;
    for (let i = 0; i < 300; i++) {
      stepSki(state, idle, 1 / 60, t);
      wasAirborne ||= state.airborne;
    }
    expect(wasAirborne).toBe(true);
    expect(state.airborne).toBe(false);
    expect(state.position.y).toBeCloseTo(t.height(state.position.x, state.position.z), 3);
    expect(state.velocity.length()).toBeGreaterThan(5);
  });

  it('jumps', () => {
    const t = slope(0);
    const state = skier(t, DOWNHILL);
    stepSki(state, { ...idle, jump: true }, 1 / 60, t);
    expect(state.airborne).toBe(true);
    expect(state.position.y).toBeGreaterThan(t.height(0, 0));
  });

  it('is slower off-piste than on a groomed run', () => {
    const groomed = slope(20);
    const powder: SkiTerrain = { ...slope(20), groomed: () => false };
    const onPiste = run(skier(groomed, DOWNHILL), groomed, 30).velocity.length();
    const offPiste = run(skier(powder, DOWNHILL), powder, 30).velocity.length();
    expect(offPiste).toBeLessThan(onPiste * 0.85);
    expect(offPiste).toBeGreaterThan(5); // still skiable
  });
});

describe('walking uphill', () => {
  const push = { ...idle, push: true };
  const UPHILL = 0; // yaw 0 faces north (-z): uphill on these south-falling slopes

  it('walks up even a steep 35° slope, slowly, instead of getting stuck', () => {
    const t = slope(35);
    const state = run(skier(t, UPHILL), t, 10, push);
    const climbed = state.position.y - t.height(0, 0);
    expect(climbed).toBeGreaterThan(1.5); // ~0.35-0.6 m/s along the slope
    expect(state.velocity.length()).toBeLessThan(1.4);
    expect(state.climbing).toBe(true);
  });

  it('climbs gentle grades faster than steep ones', () => {
    const gentle = slope(8);
    const steep = slope(30);
    const a = run(skier(gentle, UPHILL), gentle, 6, push);
    const b = run(skier(steep, UPHILL), steep, 6, push);
    expect(Math.abs(a.position.z)).toBeGreaterThan(Math.abs(b.position.z));
  });

  it('slides back down when you stop pushing', () => {
    const t = slope(25);
    const state = run(skier(t, UPHILL), t, 4, push);
    const top = state.position.y;
    run(state, t, 3);
    expect(state.position.y).toBeLessThan(top);
  });
});

describe('double-poling', () => {
  it('keeps you moving on the flat above skating speed, up to a limit', () => {
    const t = slope(0);
    const state = skier(t, DOWNHILL);
    state.velocity.set(0, 0, 5); // already gliding at 18 km/h
    run(state, t, 20, { ...idle, pole: true });
    expect(state.velocity.length()).toBeGreaterThan(7);
    expect(state.velocity.length()).toBeLessThan(SKI.poleMaxSpeed + 0.1);
    const coasting = skier(t, DOWNHILL);
    coasting.velocity.set(0, 0, 5);
    run(coasting, t, 20);
    expect(coasting.velocity.length()).toBeLessThan(state.velocity.length());
  });

  it('holds one mode while the speed hovers at the switch', () => {
    let poling = false;
    const modes = [4.4, 4.6, 4.4, 4.6, 4.0, 4.6, 3.6].map(
      (speed) => (poling = doublePoling(speed, poling)),
    );
    expect(modes).toEqual([false, true, true, true, true, true, true]);
    expect(doublePoling(3.4, true)).toBe(false);
  });

  it("doesn't flip between skating and poling on a climb poling can't hold", () => {
    // Up these grades skating gets you past the switch but poling slows you back down.
    for (const degrees of [6, 8, 10]) {
      const terrain = slope(degrees);
      const state = skier(terrain, 0); // facing uphill (north)
      state.velocity.set(0, 0, -4);
      let poling = false;
      let held = Infinity; // the run-up to the first switch doesn't count
      let shortest = Infinity;
      for (let t = 0; t < 10; t += 1 / 60) {
        const next = doublePoling(Math.hypot(state.velocity.x, state.velocity.z), poling);
        if (next !== poling) {
          shortest = Math.min(shortest, held);
          held = 0;
        }
        poling = next;
        held += 1 / 60;
        stepSki(state, { ...idle, push: !poling, pole: poling }, 1 / 60, terrain, DEFAULT_HANDLING);
      }
      // A single threshold switched 65-430 times in these 10 s, every frame or two.
      expect(shortest).toBeGreaterThan(1);
    }
  });
});

describe('ski setup', () => {
  const handling = (id: keyof typeof SKI_PRESETS) => skiHandling(SKI_PRESETS[id].setup);
  const DOWN = Math.PI;
  const speedAfter = (t: SkiTerrain, skis: SkiHandling, seconds: number, intent = idle) =>
    run(skier(t, DOWN), t, seconds, intent, skis).velocity.length();

  it('a GS ski is faster than a park ski on a groomed slope', () => {
    const t = slope(22);
    const gs = speedAfter(t, handling('gs'), 40, { ...idle, tuck: true });
    const park = speedAfter(t, handling('park'), 40, { ...idle, tuck: true });
    expect(gs).toBeGreaterThan(park * 1.15);
    expect(park).toBeGreaterThan(15); // still a usable ski
  });

  it('a wide rockered ski loses less speed in powder than a narrow race ski', () => {
    const powder: SkiTerrain = { ...slope(20), groomed: () => false };
    // Coast across a flat powder field at 54 km/h and see how much speed is lost.
    const flat: SkiTerrain = { height: () => 2000, groomed: () => false };
    const loss = (skis: SkiHandling) => {
      const state = skier(flat, DOWN);
      state.velocity.set(0, 0, 15);
      run(state, flat, 3, idle, skis);
      return 15 - state.velocity.length();
    };
    const freeride = loss(handling('freeride'));
    const slalom = loss(handling('slalom'));
    expect(freeride).toBeLessThan(slalom * 0.8);
    // And on a powder slope the wide ski runs faster.
    expect(speedAfter(powder, handling('freeride'), 30)).toBeGreaterThan(
      speedAfter(powder, handling('slalom'), 30),
    );
  });

  it('race wax glides further on the flat than an unwaxed base', () => {
    const glide = (skis: SkiHandling) => {
      const t = slope(0);
      const state = skier(t, DOWN);
      state.velocity.set(0, 0, 8);
      run(state, t, 4, idle, skis);
      return state.velocity.length();
    };
    const base = SKI_PRESETS['all-mountain'].setup;
    expect(glide(skiHandling({ ...base, wax: 'race' }))).toBeGreaterThan(
      glide(skiHandling({ ...base, wax: 'unwaxed' })) + 0.5,
    );
  });

  /** Heading change (rad) after 1 s with the skis turned 35° off the direction of travel. */
  function turned(skis: SkiHandling, speed: number, groomed = true): number {
    const t: SkiTerrain = { height: () => 2000, groomed: () => groomed };
    const state = skier(t, DOWN);
    state.velocity.set(0, 0, speed);
    state.yaw = DOWN - 35 * RAD;
    run(state, t, 1, idle, skis);
    return Math.atan2(-state.velocity.x, state.velocity.z);
  }

  it('a tighter sidecut and a shorter ski carve round quicker', () => {
    expect(turned(handling('slalom'), 15)).toBeGreaterThan(turned(handling('gs'), 15));
    const base = SKI_PRESETS['all-mountain'].setup;
    expect(turned(skiHandling({ ...base, length: 160 }), 15)).toBeGreaterThan(
      turned(skiHandling({ ...base, length: 195 }), 15),
    );
  });

  it('sharp edges hold on hard snow; dull edges skid', () => {
    const base = SKI_PRESETS['all-mountain'].setup;
    expect(turned(skiHandling({ ...base, tune: 'race' }), 15)).toBeGreaterThan(
      turned(skiHandling({ ...base, tune: 'dull' }), 15),
    );
  });

  it('soft skis wash out at speed where stiff ones still carve', () => {
    const base = SKI_PRESETS['all-mountain'].setup;
    const soft = skiHandling({ ...base, flex: 2 });
    const stiff = skiHandling({ ...base, flex: 10 });
    expect(turned(stiff, 30)).toBeGreaterThan(turned(soft, 30));
    // ...but at low speed the soft ski is the more forgiving one.
    expect(turned(soft, 4)).toBeGreaterThan(turned(stiff, 4));
  });

  it('every preset keeps the speed cap and still stops in a hockey stop', () => {
    for (const id of Object.keys(SKI_PRESETS) as (keyof typeof SKI_PRESETS)[]) {
      const skis = handling(id);
      const t = slope(15);
      const state = run(skier(t, DOWN), t, 6, idle, skis);
      expect(state.velocity.length()).toBeGreaterThan(5);
      state.yaw = ACROSS;
      run(state, t, 4, { ...idle, brake: true }, skis);
      expect(state.velocity.length(), id).toBeLessThan(1.5);
      const steep = slope(45);
      const capped = run(skier(steep, DOWN), steep, 60, { ...idle, tuck: true }, skis);
      expect(capped.velocity.length()).toBeLessThanOrEqual(skis.maxSpeed + 1e-6);
      expect(skis.maxSpeed).toBeLessThanOrEqual(40);
    }
  });
});

describe('flips', () => {
  const flat = slope(0);
  /** Launched off the flat lake: `up` m/s upward gives 2·up/g seconds of air. */
  function launch(up: number): SkiState {
    const state = skier(flat, DOWNHILL);
    state.velocity.set(0, up, 8);
    state.airborne = true;
    state.pitch = 0;
    state.takeoffPitch = 0;
    return state;
  }
  /** Step until touchdown, leaning while `lean(t)` says so; returns the landing. */
  function fly(state: SkiState, lean: (t: number, s: SkiState) => number, terrain = flat) {
    let landing: Landing | null = null;
    for (let t = 0; t < 10 && !landing; t += 1 / 60) {
      stepSki(state, { ...idle, lean: lean(t, state) }, 1 / 60, terrain);
      landing = state.landing ?? null;
    }
    return landing!;
  }

  it('holding ] through 2 s of air gives at least a full backflip', () => {
    const state = launch(SKI.gravity); // 2 s up and down
    let most = 0;
    fly(state, (_t, s) => {
      most = Math.max(most, s.pitch! - s.takeoffPitch!);
      return -1;
    });
    expect(most).toBeGreaterThan(2 * Math.PI);
  });

  it('builds rotation gradually, not instantly', () => {
    const state = launch(SKI.gravity);
    stepSki(state, { ...idle, lean: -1 }, 0.1, flat);
    expect(state.pitchRate!).toBeGreaterThan(0);
    expect(state.pitchRate!).toBeLessThan(SKI.flipRate / 2);
  });

  it('lands a backflip: hold ], let go at ~300°, and the momentum and spotting finish it', () => {
    const state = launch(SKI.gravity);
    const landing = fly(state, (_t, s) => (s.pitch! < (300 * Math.PI) / 180 ? -1 : 0));
    expect(landing.outcome).toBe('clean');
    expect(landing.flips).toBe(1);
    expect(state.crash ?? 0).toBe(0);
    expect(state.velocity.length()).toBeGreaterThan(6); // skis on
  });

  it('lands a double front flip with [ on a bigger jump', () => {
    const state = launch(15); // ~3 s of air
    const landing = fly(state, (_t, s) => (s.pitch! > -(660 * Math.PI) / 180 ? 1 : 0));
    expect(landing.flips).toBe(-2);
    expect(landing.outcome).not.toBe('crash');
  });

  it('lands flat skis and skis on without leaning', () => {
    const landing = fly(launch(5), () => 0);
    expect(landing).toEqual({ flips: 0, error: expect.closeTo(0, 2), outcome: 'clean' });
  });

  it('spots a landing on a steeper slope than the takeoff', () => {
    // Off a 10° slope, over a 3 m step onto 35°.
    const t: SkiTerrain = {
      height: (_x, z) =>
        2000 -
        (z < 10
          ? z * Math.tan(10 * RAD)
          : 10 * Math.tan(10 * RAD) + 3 + (z - 10) * Math.tan(35 * RAD)),
    };
    const state = skier(t, DOWNHILL);
    state.velocity.set(0, -12 * Math.sin(10 * RAD), 12 * Math.cos(10 * RAD));
    const landing = fly(state, () => 0, t);
    expect(landing.outcome).not.toBe('crash');
  });

  it('crashes landing 90° off the slope, slides to a stop, then stands facing downhill', () => {
    const t = slope(20);
    const state = skier(t, ACROSS);
    state.position.y += 0.05;
    state.velocity.set(0, -1, 10);
    state.airborne = true;
    state.pitch = Math.PI / 2;
    state.takeoffPitch = 0;
    const landing = fly(state, () => -1, t);
    expect(landing.outcome).toBe('crash');
    expect(state.crash).toBeGreaterThan(0);
    // Can't ski off while down: W, jump and steering do nothing.
    run(state, t, SKI.crashTime / 2, { ...idle, push: true, jump: true });
    expect(state.airborne).toBe(false);
    run(state, t, SKI.crashTime / 2 + 0.1);
    expect(state.crash).toBe(0);
    expect(state.velocity.length()).toBeLessThan(1);
    expect(Math.cos(state.yaw - DOWNHILL)).toBeGreaterThan(0.95);
  });

  /** Drop the last few centimetres onto the lake with the skis at `degrees` (tips up). */
  function touchdown(degrees: number): { state: SkiState; landing: Landing } {
    const state = launch(-2);
    state.position.y += 0.02;
    state.pitch = degrees * RAD;
    return { state, landing: fly(state, () => 0) };
  }

  it('grades landings: clean, sketchy (costs speed), crash', () => {
    const clean = touchdown(5);
    const sketchy = touchdown(25);
    expect(clean.landing.outcome).toBe('clean');
    expect(sketchy.landing.outcome).toBe('sketchy');
    expect(touchdown(-28).landing.outcome).toBe('sketchy');
    expect(sketchy.state.velocity.length()).toBeLessThan(clean.state.velocity.length() * 0.9);
    expect(sketchy.state.crash ?? 0).toBe(0);
    expect(touchdown(50).landing.outcome).toBe('crash');
    expect(touchdown(-50).landing.outcome).toBe('crash');
  });
});

describe('leaning on the snow', () => {
  it('forward lean turns a little quicker; it stays subtle', () => {
    const t = slope(15);
    const turned = (lean: number) => {
      const state = run(skier(t, DOWNHILL), t, 4);
      state.yaw = DOWNHILL - 40 * RAD;
      run(state, t, 0.4, { ...idle, lean });
      return Math.atan2(-state.velocity.x, state.velocity.z);
    };
    const neutral = turned(0);
    expect(turned(1)).toBeGreaterThan(neutral);
    expect(turned(1)).toBeLessThan(neutral * 1.3);
    expect(turned(-1)).toBeLessThan(neutral);
  });

  it('leaning back floats in powder', () => {
    const powder: SkiTerrain = { ...slope(15), groomed: () => false };
    const speed = (lean: number) =>
      run(skier(powder, DOWNHILL), powder, 20, { ...idle, lean }).velocity.length();
    expect(speed(-1)).toBeGreaterThan(speed(0));
    expect(speed(-1)).toBeLessThan(speed(0) * 1.3);
  });
});

describe('rails', () => {
  // A 0.6 m rail 1.3 m above a 15° slope, running down it (south, +z) from z = 0 to 12.
  const grade = Math.tan(15 * RAD);
  const hill = (z: number) => 2000 - z * grade;
  const onRail = (x: number, z: number) => Math.abs(x) <= 0.35 && z >= 0 && z <= 12;
  const terrain: SkiTerrain = {
    height: (x, z) => hill(z) + (onRail(x, z) ? 1.3 : 0),
    // The slope's own normal (the default 2 m sampling would straddle the rail's edge).
    normal: (_x, _z, out) => out.set(0, 1, grade).normalize(),
    groomed: () => true,
    rail: (x, z) => (onRail(x, z) ? { dirX: 0, dirZ: 1, offset: x, grade: -grade } : null),
  };
  const onIt = (x: number, yaw: number, speed: number): SkiState => ({
    position: new Vector3(x, terrain.height(x, 0.5), 0.5),
    velocity: new Vector3(0, -speed * Math.sin(15 * RAD), speed * Math.cos(15 * RAD)),
    yaw,
    airborne: false,
  });
  const slide = (state: SkiState, intent: SkiIntent) => {
    const speeds: number[] = [];
    let railed = 0;
    while (!state.airborne && state.position.z < 12) {
      stepSki(state, intent, 1 / 60, terrain);
      speeds.push(state.velocity.length());
      if (state.rail) railed++;
    }
    return { speeds, railed };
  };

  it('boardslides the whole rail with the skis across it (a hockey stop on snow)', () => {
    const state = onIt(0, ACROSS, 6);
    const { speeds, railed } = slide(state, idle);
    expect(state.position.z).toBeGreaterThan(11.5);
    // Barely slowed: it's steel, and sideways skis don't scrub on it.
    expect(Math.min(...speeds)).toBeGreaterThan(5.5);
    expect(railed).toBeGreaterThanOrEqual(speeds.length - 1);
  });

  it('slows a hockey stop on snow, but not on the rail', () => {
    const snow = run(skier(slope(15), ACROSS), slope(15), 0.5);
    const state = onIt(0, ACROSS, 6);
    snow.velocity.set(0, -6 * Math.sin(15 * RAD), 6 * Math.cos(15 * RAD));
    run(snow, slope(15), 0.5);
    run(state, terrain, 0.5);
    expect(state.velocity.length()).toBeGreaterThan(snow.velocity.length() + 2);
  });

  it('pulls you onto the centreline', () => {
    const state = onIt(0.25, ACROSS, 6);
    run(state, terrain, 1);
    expect(state.airborne).toBe(false);
    expect(Math.abs(state.position.x)).toBeLessThan(0.05);
  });

  it('flies off the end', () => {
    const state = onIt(0, DOWNHILL, 6);
    run(state, terrain, 2.5);
    expect(state.rail).toBe(false);
    expect(state.position.z).toBeGreaterThan(12);
  });
  // The sim's own surface: the snow park's height and its finely sampled normal, which
  // near the rail's end and edges straddles the 1.3 m drop to the snow.
  const parks = new SnowParks([
    {
      features: [
        {
          kind: 'box',
          east: 0,
          north: 0,
          y: 2000,
          heading: 180, // down the hill: south, +z
          width: 0.6,
          side: 20,
          profile: [
            [0, 1.3],
            [12, 1.3 - 12 * grade],
          ],
        } as LineFeature,
      ],
    } as never,
  ]);
  const contact: RailContact = { dirX: 0, dirZ: 0, offset: 0, grade: 0 };
  const park: SkiTerrain = {
    height: (x, z) => parks.height(x, z, hill(z)),
    normal: (x, z, out) => parks.normal(x, z, (_x, z2) => hill(z2), out),
    groomed: () => true,
    rail: (x, z) => parks.rail(x, z, hill(z), contact),
  };

  it('keeps its speed off the end and its corners of a real park rail (no wall, no sideways kick)', () => {
    for (const [x, across, yaw] of [
      [0, 0, DOWNHILL],
      [0.28, 0.4, ACROSS], // riding the edge into the corner
      [-0.28, -0.4, ACROSS],
    ] as const) {
      const state: SkiState = {
        position: new Vector3(x, park.height(x, 11.4), 11.4),
        velocity: new Vector3(across, -8 * Math.sin(15 * RAD), 8 * Math.cos(15 * RAD)),
        yaw,
        airborne: false,
      };
      const before = new Vector3();
      let worst = 0;
      for (let i = 0; i < 30; i++) {
        before.copy(state.velocity);
        stepSki(state, idle, 1 / 60, park);
        worst = Math.max(
          worst,
          Math.hypot(state.velocity.x - before.x, state.velocity.z - before.z),
        );
      }
      expect(state.position.z).toBeGreaterThan(13); // flew on, didn't stop at the end
      expect(worst).toBeLessThan(1); // m/s in one frame
      expect(Math.abs(state.velocity.x)).toBeLessThan(1);
    }
  });
});

describe('ski direction', () => {
  it('points the skis where the yaw points, seen from above, even on a near-vertical wall', () => {
    // A wall rising to the east at 84° (its normal points west, out of it).
    const wall = new Vector3(-Math.sin((84 * Math.PI) / 180), Math.cos((84 * Math.PI) / 180), 0);
    const yaw = (-45 * Math.PI) / 180; // north-east: diagonally up the wall
    const d = skiDirection(yaw, wall, new Vector3());
    expect(d.dot(wall)).toBeCloseTo(0); // in the surface
    expect(Math.atan2(d.x, -d.z)).toBeCloseTo(Math.PI / 4); // still north-east from above
    expect(d.y).toBeGreaterThan(0.9); // so mostly up the wall, not along it
  });
});
