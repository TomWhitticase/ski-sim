/**
 * Graphics presets (Options → Graphics): one place to describe how rich the rendering is,
 * as a small set of named presets (**Fast / Default / Fancy**) over a typed options object.
 * The player picks a preset, or overrides individual options (then the preset reads
 * "Custom"). Persisted in localStorage; read once at world load (see "Applying" below).
 *
 * **Extensible by design.** Today the only graphics feature that exists is the procedural
 * close-up terrain detail (`config.TERRAIN_DETAIL`, `terrain/terrain-material.ts`), so that
 * is the only option. As lighting, shadows, effects etc. arrive, add a field to
 * `GraphicsOptions`, a scale/enum it ranges over, and a value for it in each preset below —
 * nothing else has to change (the menu renders every option, "Custom" detection is generic,
 * persistence round-trips the whole object). See the "how to add a graphics option" note in
 * the repo CLAUDE.md.
 *
 * **Device tier vs preset.** `render/quality.ts` still picks the hardware budget (pixel
 * ratio, shadow maps, LOD distances, MSAA) from the device at start-up — that is adaptation,
 * not a user choice. The preset layers the *look* on top. The auto tier also picks the
 * initial preset (both tiers start on Default) and **caps** the heavy knobs so a phone is
 * never asked to run more than it should: terrain detail is capped to `low` on touch devices,
 * so Default and Fancy both resolve to today's mobile look there, while Fast still drops it.
 *
 * **Applying.** Terrain detail is folded into the TSL terrain material when it is built
 * (`createTerrainMaterial`), so a change takes effect on the next world load, not live — the
 * menu persists immediately and offers "Apply & reload". Future options that map to a live
 * uniform or a CSS variable can be applied without a reload; keep the reload-scoped ones and
 * the live ones clearly separated when you add them.
 */

import type { Quality, TerrainDetailTier } from './quality';

/** The named presets, cheapest first. */
export type GraphicsPreset = 'fast' | 'default' | 'fancy';

export const GRAPHICS_PRESETS_ORDER: readonly GraphicsPreset[] = ['fast', 'default', 'fancy'];

export const GRAPHICS_PRESET_LABELS: Record<GraphicsPreset, string> = {
  fast: 'Fast',
  default: 'Default',
  fancy: 'Fancy',
};

/** Close-up procedural terrain detail, as a user-facing level (maps to a `TerrainDetailTier`). */
export type TerrainDetailLevel = 'off' | 'low' | 'high' | 'ultra';

export const TERRAIN_DETAIL_ORDER: readonly TerrainDetailLevel[] = ['off', 'low', 'high', 'ultra'];

export const TERRAIN_DETAIL_LABELS: Record<TerrainDetailLevel, string> = {
  off: 'Off',
  low: 'Low',
  high: 'High',
  ultra: 'Ultra',
};

/**
 * The full set of graphics options. One field per graphics feature; add more as they land.
 * Every field must be a small enum/scalar with a value in each preset below.
 */
export interface GraphicsOptions {
  /** Procedural close-up terrain detail (`config.TERRAIN_DETAIL`). */
  terrainDetail: TerrainDetailLevel;
}

/**
 * How each terrain-detail level maps to the shader tier. `off` runs none; `low` is today's
 * phone tier; `high` is today's desktop look; `ultra` pushes the eased detail toward full
 * strength and lets it reach further (octaves are capped to the shader's base counts of 4,
 * so richness here comes from `strength` and `fadeScale`, not more octaves).
 */
export const TERRAIN_DETAIL_TIERS: Record<TerrainDetailLevel, TerrainDetailTier> = {
  off: { enabled: false, strength: 0, octaves: 1, fadeScale: 1 },
  low: { enabled: true, strength: 0.6, octaves: 2, fadeScale: 0.6 },
  high: { enabled: true, strength: 1, octaves: 4, fadeScale: 1 },
  ultra: { enabled: true, strength: 1.3, octaves: 4, fadeScale: 1.4 },
};

/** The look each preset commits to. */
export const GRAPHICS_PRESETS: Record<GraphicsPreset, GraphicsOptions> = {
  fast: { terrainDetail: 'off' },
  default: { terrainDetail: 'high' },
  fancy: { terrainDetail: 'ultra' },
};

/** The highest terrain-detail level a device tier will run (the cap applied at resolve). */
export function terrainDetailCeiling(mobile: boolean): TerrainDetailLevel {
  return mobile ? 'low' : 'ultra';
}

/** The lower of two levels, by the `off < low < high < ultra` ordering. */
export function minTerrainDetail(a: TerrainDetailLevel, b: TerrainDetailLevel): TerrainDetailLevel {
  return TERRAIN_DETAIL_ORDER.indexOf(a) <= TERRAIN_DETAIL_ORDER.indexOf(b) ? a : b;
}

/**
 * The concrete terrain-detail tier for a chosen level on a given device: the level, capped to
 * what the tier allows. On touch this never exceeds `low`, protecting the phone budget while
 * the far layer (which passes no detail) is unaffected.
 */
export function terrainDetailFor(level: TerrainDetailLevel, mobile: boolean): TerrainDetailTier {
  return TERRAIN_DETAIL_TIERS[minTerrainDetail(level, terrainDetailCeiling(mobile))];
}

/** Lay the graphics options over a device quality budget (only terrain detail today). */
export function applyGraphics(base: Quality, options: GraphicsOptions, mobile: boolean): Quality {
  return { ...base, terrainDetail: terrainDetailFor(options.terrainDetail, mobile) };
}

const OPTION_KEYS = Object.keys(GRAPHICS_PRESETS.default) as (keyof GraphicsOptions)[];

export function optionsEqual(a: GraphicsOptions, b: GraphicsOptions): boolean {
  return OPTION_KEYS.every((k) => a[k] === b[k]);
}

/** The preset these options match exactly, or `null` ("Custom") if none does. */
export function presetFor(options: GraphicsOptions): GraphicsPreset | null {
  return GRAPHICS_PRESETS_ORDER.find((p) => optionsEqual(GRAPHICS_PRESETS[p], options)) ?? null;
}

/**
 * The preset a fresh install starts on: Default on every device. The device tier doesn't
 * change the *starting preset* — it changes the *cap* (`terrainDetailCeiling`), so Default
 * on touch resolves to today's phone look while Default on desktop is today's desktop look.
 */
export function defaultPreset(): GraphicsPreset {
  return 'default';
}

export function isGraphicsPreset(v: unknown): v is GraphicsPreset {
  return typeof v === 'string' && v in GRAPHICS_PRESETS;
}

export function isTerrainDetailLevel(v: unknown): v is TerrainDetailLevel {
  return typeof v === 'string' && TERRAIN_DETAIL_ORDER.includes(v as TerrainDetailLevel);
}

export const GRAPHICS_KEY = 'ski-sim.graphics';

/** The live options (mutated in place by the menu; read by `applyGraphics` at load). */
export const graphics: GraphicsOptions = { ...GRAPHICS_PRESETS.default };

/** Validate stored/partial options, filling anything missing or invalid from `fallback`. */
export function sanitizeGraphics(
  raw: unknown,
  fallback: GraphicsOptions = GRAPHICS_PRESETS.default,
): GraphicsOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    terrainDetail: isTerrainDetailLevel(r.terrainDetail) ? r.terrainDetail : fallback.terrainDetail,
  };
}

/**
 * The saved options, or the starting preset (Default) when nothing's been saved yet. A saved
 * choice is honoured on any device and capped at resolve (`terrainDetailFor`), so a
 * desktop-chosen Fancy still runs safely if the same browser is later opened on a phone.
 */
export function loadGraphics(storage: Pick<Storage, 'getItem'>): GraphicsOptions {
  const start = GRAPHICS_PRESETS[defaultPreset()];
  try {
    const saved: unknown = JSON.parse(storage.getItem(GRAPHICS_KEY) ?? 'null');
    return Object.assign(graphics, saved ? sanitizeGraphics(saved, start) : { ...start });
  } catch {
    return Object.assign(graphics, { ...start });
  }
}

export function saveGraphics(storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(GRAPHICS_KEY, JSON.stringify(graphics));
}

/** Set the live options to a preset (used by the menu and the `?graphics=` URL override). */
export function setGraphicsPreset(preset: GraphicsPreset): GraphicsOptions {
  return Object.assign(graphics, { ...GRAPHICS_PRESETS[preset] });
}
