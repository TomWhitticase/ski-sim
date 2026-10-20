/**
 * Interface display preferences (Options → Display): how strong the glass is and how big
 * the UI is. Kept in localStorage and applied as CSS on the document root (`theme.css`).
 */

/** Full blur; a lighter blur; or no blur at all (tinted panels), for slower GPUs. */
export type GlassStrength = 'full' | 'light' | 'tint';

export interface DisplaySettings {
  glass: GlassStrength;
  /** × the automatic scale (which follows the window height). */
  uiScale: number;
}

export const DEFAULT_DISPLAY: Readonly<DisplaySettings> = { glass: 'full', uiScale: 1 };

export const UI_SCALE_RANGE = { min: 0.8, max: 1.5, step: 0.05 };

export const GLASS_STRENGTHS: { value: GlassStrength; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'light', label: 'Light' },
  { value: 'tint', label: 'Tint only' },
];

const KEY = 'ski-sim.display';

/** The live settings (mutated in place by the menu). */
export const displaySettings: DisplaySettings = { ...DEFAULT_DISPLAY };

export function sanitizeDisplay(raw: unknown): DisplaySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const glass = GLASS_STRENGTHS.some((g) => g.value === r.glass)
    ? (r.glass as GlassStrength)
    : DEFAULT_DISPLAY.glass;
  const scale =
    typeof r.uiScale === 'number' && Number.isFinite(r.uiScale)
      ? Math.min(UI_SCALE_RANGE.max, Math.max(UI_SCALE_RANGE.min, r.uiScale))
      : DEFAULT_DISPLAY.uiScale;
  return { glass, uiScale: scale };
}

export function loadDisplay(storage: Pick<Storage, 'getItem'>): DisplaySettings {
  try {
    return Object.assign(
      displaySettings,
      sanitizeDisplay(JSON.parse(storage.getItem(KEY) ?? 'null')),
    );
  } catch {
    return Object.assign(displaySettings, DEFAULT_DISPLAY);
  }
}

export function saveDisplay(storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(KEY, JSON.stringify(displaySettings));
}

/**
 * The UI's scale: 1 at a 900 px tall window, growing and shrinking with it (within
 * 0.85-1.3) so it reads the same on a laptop and a 4K screen, times the player's choice.
 */
export function uiScale(windowHeight: number, choice: number): number {
  const auto = Math.min(1.3, Math.max(0.85, windowHeight / 900));
  return Math.round(auto * choice * 100) / 100;
}

/** Put the settings on the document: `--ui-scale` and `data-glass`. */
export function applyDisplay(root: HTMLElement = document.documentElement): void {
  root.style.setProperty(
    '--ui-scale',
    String(uiScale(window.innerHeight, displaySettings.uiScale)),
  );
  root.dataset.glass = displaySettings.glass;
}
