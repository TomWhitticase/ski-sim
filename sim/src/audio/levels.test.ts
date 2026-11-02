import { describe, expect, it } from 'vitest';

import type { SnowContact } from '../fx/intensity';
import {
  AIRCRAFT_HEARD_WITHIN,
  aircraftFalloff,
  aircraftSound,
  aircraftWindLevel,
  crashSeverity,
  flapMotorLevel,
  rollingSound,
  stallHornLevel,
  touchdownSound,
  DRONE_HEARD_WITHIN,
  droneFalloff,
  droneSound,
  engineSound,
  railSound,
  soundLevels,
} from './levels';

describe('soundLevels', () => {
  const contact = (over: Partial<SnowContact> = {}): SnowContact => ({
    speed: 15,
    sideslip: 0,
    edge: 0,
    onSnow: true,
    groomed: true,
    ...over,
  });

  it('is just wind when airborne or off the snow', () => {
    expect(soundLevels(30, null).glide).toBe(0);
    expect(soundLevels(30, contact({ onSnow: false })).skid).toBe(0);
    expect(soundLevels(30, null).wind).toBeGreaterThan(0);
  });

  it("a snowboard's glide is a broader, lower hiss than skis, and a touch louder", () => {
    const c = contact();
    const ski = soundLevels(10, c, 0, false);
    const board = soundLevels(10, c, 0, true);
    expect(board.glidePitch).toBeLessThan(ski.glidePitch);
    expect(board.glide).toBeGreaterThan(ski.glide);
  });

  it('a snowboard scrapes louder when it skids (one long edge chattering)', () => {
    const c = contact({ sideslip: 8 });
    expect(soundLevels(10, c, 0, true).skid).toBeGreaterThan(soundLevels(10, c, 0, false).skid);
  });
});

describe('engineSound', () => {
  it('is silent with the engine off', () => {
    expect(engineSound(8000, 1, false).level).toBe(0);
  });

  it('fires twice a revolution: ~53 Hz at idle, ~270 Hz near the limiter', () => {
    expect(engineSound(1600, 0, true).frequency).toBeCloseTo(53.3, 0);
    expect(engineSound(8000, 1, true).frequency).toBeCloseTo(266.7, 0);
  });

  it('gets louder and brighter on the throttle, and warbles only at idle', () => {
    const idle = engineSound(1600, 0, true);
    const wot = engineSound(8000, 1, true);
    expect(wot.level).toBeGreaterThan(idle.level * 2);
    expect(wot.cutoff).toBeGreaterThan(idle.cutoff * 4);
    expect(idle.warble).toBeGreaterThan(0.3);
    expect(wot.warble).toBeLessThan(0.01);
  });
});

describe('railSound', () => {
  it('is silent off the rail or standing still on it', () => {
    expect(railSound(8, 0, false).level).toBe(0);
    expect(railSound(0.1, 0, true).level).toBe(0);
  });

  it('gets louder and higher with speed', () => {
    const slow = railSound(3, 0, true);
    const fast = railSound(10, 0, true);
    expect(fast.level).toBeGreaterThan(slow.level);
    expect(fast.pitch).toBeGreaterThan(slow.pitch);
  });

  it('a boardslide (skis across) is grittier and louder than a 50-50', () => {
    const fifty = railSound(6, 0.2, true);
    const board = railSound(6, 6, true);
    expect(board.grit).toBeCloseTo(1);
    expect(fifty.grit).toBeLessThan(0.1);
    expect(board.level).toBeGreaterThan(fifty.level);
  });
});

describe('droneSound', () => {
  it('buzzes at ~160 Hz hovering, rising with speed', () => {
    const hover = droneSound(0);
    expect(hover.frequency).toBeCloseTo(160, 0);
    expect(hover.level).toBeGreaterThan(0);
    let last = hover;
    for (const speed of [5, 15, 30, 60, 300, 1500]) {
      const s = droneSound(speed);
      expect(s.frequency).toBeGreaterThan(last.frequency);
      expect(s.level).toBeGreaterThanOrEqual(last.level);
      last = s;
    }
    // Even flat out it's a buzz, not a whine.
    expect(droneSound(1500).frequency).toBeLessThan(450);
  });
});

describe('droneFalloff', () => {
  it('is full close by, quieter further off, and silent past hearing range', () => {
    expect(droneFalloff(0)).toBeCloseTo(1, 1);
    expect(droneFalloff(3)).toBeCloseTo(droneFalloff(0), 1);
    expect(droneFalloff(30)).toBeLessThan(0.25);
    expect(droneFalloff(100)).toBeLessThan(droneFalloff(30));
    expect(droneFalloff(100)).toBeGreaterThan(0);
    expect(droneFalloff(DRONE_HEARD_WITHIN)).toBe(0);
    expect(droneFalloff(5000)).toBe(0);
  });
});

describe('aircraftSound', () => {
  it('is silent with nothing turning', () => {
    expect(aircraftSound('plane', 0, 0).level).toBe(0);
    expect(aircraftSound('heli', 0.01, 1).level).toBe(0);
  });

  it("buzzes at a three-blade prop's 110 Hz, louder and brighter with power", () => {
    const idle = aircraftSound('plane', 0.62, 0);
    const full = aircraftSound('plane', 1, 1);
    expect(full.blade).toBeCloseTo(110, 0);
    expect(full.level).toBeGreaterThan(idle.level);
    expect(full.cutoff).toBeGreaterThan(idle.cutoff);
    expect(full.slap).toBe(0);
  });

  it("slaps at the H125's 19.5 Hz blade passage, harder under load", () => {
    const hover = aircraftSound('heli', 1, 0.6);
    expect(hover.blade).toBeCloseTo(19.5, 1);
    expect(aircraftSound('heli', 1, 1).slap).toBeGreaterThan(hover.slap);
    expect(hover.whine).toBeGreaterThan(4000);
  });

  it('carries a few kilometres, as loud as your own close by', () => {
    expect(aircraftFalloff(10)).toBeCloseTo(1, 1);
    expect(aircraftFalloff(500)).toBeGreaterThan(0.05);
    expect(aircraftFalloff(AIRCRAFT_HEARD_WITHIN)).toBe(0);
  });
});

describe('touchdownSound', () => {
  it('is silent for a touch with no sink, and thumps harder the firmer it lands', () => {
    expect(touchdownSound('plane', 0.05, 25, 'paved').thump).toBe(0);
    const greaser = touchdownSound('plane', 0.5, 25, 'paved');
    const firm = touchdownSound('plane', 3, 25, 'paved');
    expect(firm.thump).toBeGreaterThan(greaser.thump * 2);
    expect(firm.thump).toBeLessThanOrEqual(0.75);
  });

  it("chirps the plane's tyres on tarmac, crunches on snow", () => {
    const tarmac = touchdownSound('plane', 1, 25, 'paved');
    const snow = touchdownSound('plane', 1, 25, 'groomed');
    expect(tarmac.chirp).toBeGreaterThan(0.1);
    expect(tarmac.crunch).toBe(0);
    expect(snow.chirp).toBe(0);
    expect(snow.crunch).toBeGreaterThan(0.1);
    expect(touchdownSound('plane', 1, 25, 'powder').crunch).toBeLessThan(snow.crunch);
  });

  it("never chirps a helicopter's skids", () => {
    expect(touchdownSound('heli', 1, 0, 'paved').chirp).toBe(0);
    expect(touchdownSound('heli', 1, 0, 'groomed').crunch).toBeGreaterThan(0);
  });
});

describe('rollingSound', () => {
  it('is silent in the air and standing still', () => {
    expect(rollingSound('plane', false, 30, 'paved', false).rumble).toBe(0);
    expect(rollingSound('plane', true, 0, 'paved', true).squeal).toBe(0);
  });

  it('rumbles louder and brighter with speed; tarmac rumbles, snow crunches', () => {
    const taxi = rollingSound('plane', true, 5, 'paved', false);
    const roll = rollingSound('plane', true, 30, 'paved', false);
    expect(roll.rumble).toBeGreaterThan(taxi.rumble);
    expect(roll.rumbleCutoff).toBeGreaterThan(taxi.rumbleCutoff);
    expect(roll.crunch).toBe(0);
    const snow = rollingSound('plane', true, 30, 'groomed', false);
    expect(snow.crunch).toBeGreaterThan(0.1);
    expect(snow.rumble).toBeLessThan(roll.rumble);
  });

  it('squeals the brakes only braking hard on tarmac, above walking pace', () => {
    expect(rollingSound('plane', true, 20, 'paved', true).squeal).toBeGreaterThan(0.1);
    expect(rollingSound('plane', true, 20, 'paved', false).squeal).toBe(0);
    expect(rollingSound('plane', true, 20, 'groomed', true).squeal).toBe(0);
    expect(rollingSound('plane', true, 2, 'paved', true).squeal).toBe(0);
  });

  it("scrapes a helicopter's skids when they slide, brighter on a pad", () => {
    const snow = rollingSound('heli', true, 3, 'groomed', false);
    const pad = rollingSound('heli', true, 3, 'paved', false);
    expect(snow.crunch).toBeGreaterThan(0.15);
    expect(pad.crunchPitch).toBeGreaterThan(snow.crunchPitch);
    expect(rollingSound('heli', true, 0.1, 'groomed', false).crunch).toBe(0);
  });

  it("stays under the engine's level", () => {
    const loudest = rollingSound('plane', true, 40, 'paved', true);
    const engine = aircraftSound('plane', 1, 1).level;
    expect(Math.max(loudest.rumble, loudest.crunch, loudest.squeal)).toBeLessThan(engine);
  });
});

describe('warnings and the cockpit', () => {
  it('sounds the stall horn only with the warning, louder from the cockpit', () => {
    expect(stallHornLevel(false, true)).toBe(0);
    expect(stallHornLevel(true, true)).toBeGreaterThan(stallHornLevel(true, false));
    expect(stallHornLevel(true, true)).toBeLessThan(aircraftSound('plane', 1, 0).level);
  });

  it('whines the flap motor only while the flaps move', () => {
    expect(flapMotorLevel(false, true)).toBe(0);
    expect(flapMotorLevel(true, true)).toBeGreaterThan(flapMotorLevel(true, false));
  });

  it('hits harder the faster the crash', () => {
    expect(crashSeverity(5)).toBeGreaterThan(0.4);
    expect(crashSeverity(60)).toBe(1);
    expect(crashSeverity(30)).toBeGreaterThan(crashSeverity(10));
  });

  it('roars the slipstream with airspeed, muffled in the cockpit', () => {
    const slow = aircraftWindLevel(15, false);
    const cruise = aircraftWindLevel(60, false);
    expect(cruise).toBeGreaterThan(slow * 3);
    expect(aircraftWindLevel(60, true)).toBeLessThan(cruise / 2);
    expect(aircraftWindLevel(200, false)).toBeLessThanOrEqual(0.75);
    expect(aircraftWindLevel(200, true)).toBeLessThanOrEqual(0.3);
    // Still rising past skiing's 35 m/s, where its wind tops out.
    expect(aircraftWindLevel(60, true)).toBeGreaterThan(aircraftWindLevel(35, true));
    // A gale is heard over a slow taxi.
    expect(aircraftWindLevel(5, false, 25)).toBeGreaterThan(aircraftWindLevel(5, false));
  });
});
