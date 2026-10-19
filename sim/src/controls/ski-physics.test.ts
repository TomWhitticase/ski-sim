import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import {
  type Landing,
  SKI,
  type SkiIntent,
  type SkiState,
  type SkiTerrain,
  stepSki,
} from './ski-physics';
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
