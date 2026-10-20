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

export function soundLevels(airSpeed: number, contact: SnowContact | null): SoundLevels {
  const wind = 0.04 + 0.5 * clamp01((airSpeed / 35) ** 2);
  if (!contact || !contact.onSnow) return { wind, glide: 0, glidePitch: 800, skid: 0 };
  const moving = clamp01(contact.speed / 12);
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
