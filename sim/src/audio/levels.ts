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
