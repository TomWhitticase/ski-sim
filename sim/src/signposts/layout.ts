/**
 * Pure helpers for the signpost renderer (`signposts.ts`): what a blade says, which colour
 * it is, which side its arm points, and which ink reads on it. No Three.js or DOM here, so
 * it's unit-tested in `layout.test.ts`.
 */
import { DIFFICULTY, RUN_TYPES, type RunType } from '../pistes/pistes';

export interface Blade {
  kind: 'piste' | 'lift';
  name: string | null;
  ref?: string | null;
  difficulty?: number;
  type?: RunType;
  liftType?: string;
  /** Bearing of this way out relative to the direction skiers arrive in (deg, + = right). */
  rel: number;
  /** Where the run leads (lift or village at its bottom). */
  to?: string | null;
}

/** The blade's background: a run's piste colour, or dark slate for a lift. */
export function bladeColour(b: Blade): string {
  if (b.kind === 'lift') return '#2b2f36';
  const type = b.type ?? 'downhill';
  if ((type === 'downhill' || type === 'connection') && b.difficulty) {
    return DIFFICULTY[b.difficulty as keyof typeof DIFFICULTY].colour;
  }
  return RUN_TYPES[type].colour ?? '#82828c';
}

export function bladeTitle(b: Blade): string {
  if (b.kind === 'lift') return b.name ?? 'Lift';
  if (b.name) return b.name;
  const type = b.type ?? 'downhill';
  if (type !== 'downhill') return RUN_TYPES[type].name;
  const d = DIFFICULTY[(b.difficulty || 2) as keyof typeof DIFFICULTY];
  return `${d.name} run`;
}

/** The small line under the title: "Lift", or "to <destination>", else nothing. */
export function bladeSub(b: Blade): string {
  if (b.kind === 'lift') return 'Lift';
  return b.to ? `to ${b.to}` : '';
}

/** A fingerpost blade points left (−1), right (+1) or straight on (0, a centred plate). */
export function bladeSide(rel: number): -1 | 0 | 1 {
  return rel < -25 ? -1 : rel > 25 ? 1 : 0;
}

/** Arrow bearing quantised to 45° steps and clamped to the drawable range. */
export function quantiseArrow(rel: number): number {
  return Math.max(-135, Math.min(135, Math.round(rel / 45) * 45));
}

const HUD_ARROWS = ['↙', '←', '↖', '↑', '↗', '→', '↘'] as const;
/** The Unicode arrow for a relative bearing, for the HUD readout. */
export function hudArrow(rel: number): string {
  return HUD_ARROWS[Math.max(0, Math.min(6, Math.round(rel / 45) + 3))]!;
}

/** sRGB hex → relative luminance (WCAG 2.1). */
export function relLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1]!, 16) : 0;
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}

/** The ink (near-white or near-black) that reads best on `background`, by WCAG contrast. */
export function inkFor(background: string): '#f7f8fa' | '#17181b' {
  const l = relLuminance(background);
  const onLight = (l + 0.05) / 0.05; // contrast vs black
  const onDark = 1.05 / (l + 0.05); // contrast vs white
  return onDark >= onLight ? '#f7f8fa' : '#17181b';
}

/** Difficulty shape for the North-American style (null for an unrated run). */
export function naShape(b: Blade): 'circle' | 'square' | 'diamond' | 'double-diamond' | null {
  if (b.kind !== 'piste' || (b.type ?? 'downhill') !== 'downhill') return null;
  const d = b.difficulty ?? 0;
  if (d === 1) return 'circle';
  if (d === 2) return 'square';
  if (d === 3) return 'diamond';
  if (d >= 4) return 'double-diamond';
  return null;
}
