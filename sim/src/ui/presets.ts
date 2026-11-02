import type { Registry } from './registry';

/**
 * View presets: one choice sets the labels and overlays together. Each is the set of
 * registry toggles it turns on; every other toggle in `PRESET_TOGGLES` it turns off.
 * Toggles outside that list (HUD, sound, first person, snowboard) are left alone.
 */
export interface Preset {
  id: 'realistic' | 'navigator' | 'explorer';
  label: string;
  hint: string;
  on: readonly string[];
}

/** The toggles a preset sets. */
export const PRESET_TOGGLES = [
  'lift',
  'peak',
  'restaurant',
  'airfield',
  'pistes',
  'sign-readout',
  'debug',
] as const;

export const PRESETS: readonly Preset[] = [
  {
    id: 'realistic',
    label: 'Realistic',
    hint: 'No labels or overlays: just the mountain',
    on: [],
  },
  {
    id: 'navigator',
    label: 'Navigator',
    hint: 'Names and piste colours to find your way',
    on: ['lift', 'peak', 'restaurant', 'airfield', 'pistes', 'sign-readout'],
  },
  {
    id: 'explorer',
    label: 'Explorer',
    hint: 'Everything on, debug info too',
    on: [...PRESET_TOGGLES],
  },
];

/** Set every preset toggle to the preset's choice. */
export function applyPreset(registry: Registry, preset: Preset): void {
  for (const id of PRESET_TOGGLES) {
    const entry = registry.get(id);
    if (entry) registry.set(entry, preset.on.includes(id));
  }
}

/** The preset the toggles match now, if any (null once you've mixed your own). */
export function activePreset(registry: Registry): Preset | null {
  return (
    PRESETS.find((p) =>
      PRESET_TOGGLES.every((id) => {
        const entry = registry.get(id);
        return !entry || registry.isOn(entry) === p.on.includes(id);
      }),
    ) ?? null
  );
}
