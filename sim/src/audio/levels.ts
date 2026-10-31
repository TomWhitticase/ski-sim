import { carveAmount, type SnowContact, skidAmount } from '../fx/intensity';

export interface SoundLevels {
  /** Rushing air (all modes). */
  wind: number;
  /** Skis running on snow. */
  glide: number;
  /** Centre frequency of the glide hiss (Hz): rises with speed, lower in powder. */
  glidePitch: number;
  /** Scraping skid. */
  skid: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The weather's wind (m/s, gusting) as a level: a breeze is faint, a gale roars. */
export function weatherWindLevel(wind: number): number {
  return 0.55 * clamp01(wind / 24) ** 1.5;
}

/**
 * `airSpeed` is your speed through the air (m/s); `weatherWind` the weather's own wind
 * (m/s, 0 with weather off). The two add like noise does (root sum of squares).
 *
 * `snowboard` shapes the on-snow voice for a board instead of skis: the whole base runs
 * on the snow, so the glide is a broader, lower hiss (and a touch louder), and a skid
 * drags the single long edge rather than two narrow ones — a louder, gritty chatter.
 */
export function soundLevels(
  airSpeed: number,
  contact: SnowContact | null,
  weatherWind = 0,
  snowboard = false,
): SoundLevels {
  const rushing = 0.04 + 0.5 * clamp01((airSpeed / 35) ** 2);
  const wind = Math.min(0.75, Math.hypot(rushing, weatherWindLevel(weatherWind)));
  if (!contact || !contact.onSnow) return { wind, glide: 0, glidePitch: 800, skid: 0 };
  const moving = clamp01(contact.speed / 12);
  if (snowboard)
    return {
      wind,
      glide: moving * (0.22 + 0.38 * carveAmount(contact)),
      glidePitch: (contact.groomed ? 620 : 420) + contact.speed * 32,
      skid: 0.9 * skidAmount(contact),
    };
  return {
    wind,
    glide: moving * (0.18 + 0.35 * carveAmount(contact)),
    glidePitch: (contact.groomed ? 900 : 550) + contact.speed * 45,
    skid: 0.75 * skidAmount(contact),
  };
}

/** Drive hum near a lift station: loud beside it, gone ~150 m away. */
export function liftHumLevel(distanceToStation: number, riding: boolean): number {
  const near = Math.max(0, 1 - distanceToStation / 150) ** 2;
  return 0.3 * near + (riding ? 0.06 : 0);
}

export interface EngineSound {
  /** Overall loudness, 0 when the engine is off. */
  level: number;
  /** Firing frequency (Hz): a twin two-stroke fires twice per revolution. */
  frequency: number;
  /** Low-pass cutoff (Hz): the exhaust opens up and gets raspy under load. */
  cutoff: number;
  /** Depth of the idle "ring-ding" warble, 0..1 (gone at high revs). */
  warble: number;
}

const ENGINE_OFF: EngineSound = { level: 0, frequency: 40, cutoff: 300, warble: 0 };

/** A twin-cylinder two-stroke snowmobile engine at `rpm`, with the throttle 0..1. */
export function engineSound(rpm: number, throttle: number, running: boolean): EngineSound {
  if (!running) return ENGINE_OFF;
  const revs = clamp01((rpm - 1600) / (8300 - 1600));
  return {
    level: 0.1 + 0.12 * revs + 0.1 * throttle,
    frequency: (2 * rpm) / 60,
    cutoff: 350 + 2400 * revs * (0.5 + 0.5 * throttle),
    warble: 0.45 * (1 - revs) ** 2,
  };
}

export interface RailSound {
  /** Grind loudness, 0 off the rail. */
  level: number;
  /** Centre of the scrape's ring (Hz): rises with speed. */
  pitch: number;
  /** 0 (skis along it, a 50-50: a smooth hiss) to 1 (across it, a boardslide: gritty). */
  grit: number;
}

const RAIL_OFF: RailSound = { level: 0, pitch: 2400, grit: 0 };

/** Sliding a steel rail at `speed` m/s with `sideslip` m/s of it across the skis. */
export function railSound(speed: number, sideslip: number, onRail: boolean): RailSound {
  if (!onRail || speed < 0.3) return RAIL_OFF;
  const across = clamp01(Math.abs(sideslip) / Math.max(speed, 0.1));
  return {
    level: (0.12 + 0.22 * clamp01(speed / 10)) * (0.75 + 0.25 * across),
    pitch: 1900 + 90 * Math.min(speed, 15),
    grit: across,
  };
}

export interface DroneSound {
  /** Loudness, 0 when there's no drone flying. */
  level: number;
  /** Blade-pass frequency (Hz): two blades × the props' revs, rising with speed. */
  frequency: number;
}

export const DRONE_OFF: DroneSound = { level: 0, frequency: 160 };

/** Speed (m/s) at which the props are near full revs (a racing drone's dash). */
const DRONE_FAST = 30;

/**
 * A quadcopter's buzz at `speed` m/s: ~160 Hz hovering (≈ 4,800 rpm on two-blade props),
 * climbing toward ~400 Hz flat out and a little louder with it. Faster than a real drone
 * flies (fly speed reaches 1500 m/s), the pitch keeps creeping up but stays a buzz.
 */
export function droneSound(speed: number): DroneSound {
  const s = Math.max(0, speed);
  const revs = 1 - Math.exp(-s / DRONE_FAST);
  const beyond = Math.log1p(Math.max(0, s - 3 * DRONE_FAST) / 100);
  return {
    level: 0.08 + 0.06 * revs,
    frequency: 160 + 220 * revs + 40 * Math.min(1, beyond),
  };
}

/** Distance (m) at which someone else's drone sounds as loud as your own. */
const DRONE_NEAR = 6;
/** Beyond this (m) another player's drone isn't heard at all. */
export const DRONE_HEARD_WITHIN = 300;

/** How much of a drone's level reaches you from `distance` m: 1 close by, 0 by 300 m. */
export function droneFalloff(distance: number): number {
  const d = Math.max(0, distance);
  if (d >= DRONE_HEARD_WITHIN) return 0;
  const fade = 1 - d / DRONE_HEARD_WITHIN;
  return Math.min(1, DRONE_NEAR / Math.max(d, DRONE_NEAR)) * fade * fade;
}

export interface AircraftSound {
  /** Loudness, 0 when nothing's running. */
  level: number;
  /** The turbine's whine (Hz) and its share of the mix. */
  whine: number;
  whineLevel: number;
  /** Blade-pass frequency (Hz): a propeller's buzz, or a main rotor's beat. */
  blade: number;
  /** 0 a smooth buzz (propeller) … 1 sharp slaps (a rotor's blades through their own wake). */
  slap: number;
  /** Low-pass on the blades' sound (Hz): brighter as the prop takes a bite. */
  cutoff: number;
}

export const AIRCRAFT_OFF: AircraftSound = {
  level: 0,
  whine: 2000,
  whineLevel: 0,
  blade: 100,
  slap: 0,
  cutoff: 800,
};

/**
 * A turboprop or a turbine helicopter at `rpm` (share of governed revs) and `load` (power
 * lever or torque, 0..1). The PT6's whine is ~1.8–3.2 kHz; three prop blades at 2,200 rpm
 * buzz at 110 Hz, growling as the lever comes up. The H125's three blades at 390 rpm beat
 * at 19.5 Hz (the "wokka" slap, harder under load), over the Arriel's whine and the tail
 * rotor (heard in the slaps' noise).
 */
export function aircraftSound(kind: 'plane' | 'heli', rpm: number, load: number): AircraftSound {
  const r = clamp01(rpm);
  if (r < 0.02) return AIRCRAFT_OFF;
  const l = clamp01(load);
  const spool = Math.min(1, r / 0.4);
  if (kind === 'plane') {
    return {
      level: (0.12 + 0.2 * l) * spool,
      whine: 1800 + 1400 * r,
      whineLevel: 0.3 - 0.12 * l,
      blade: (3 * 2200 * r) / 60,
      slap: 0,
      cutoff: 450 + 2000 * l,
    };
  }
  return {
    level: (0.16 + 0.16 * l) * spool,
    whine: 2600 + 2200 * r,
    whineLevel: 0.22,
    blade: (3 * 390 * r) / 60,
    slap: 0.55 + 0.45 * l,
    cutoff: 700 + 600 * l,
  };
}

/** Within this (m) another player's aircraft is as loud as your own. */
const AIRCRAFT_NEAR = 25;
/** Beyond this (m) it isn't heard. */
export const AIRCRAFT_HEARD_WITHIN = 4000;

/** How much of an aircraft's sound reaches you from `distance` m. */
export function aircraftFalloff(distance: number): number {
  const d = Math.max(0, distance);
  if (d >= AIRCRAFT_HEARD_WITHIN) return 0;
  const fade = 1 - d / AIRCRAFT_HEARD_WITHIN;
  return Math.min(1, AIRCRAFT_NEAR / Math.max(d, AIRCRAFT_NEAR)) ** 0.8 * fade;
}
