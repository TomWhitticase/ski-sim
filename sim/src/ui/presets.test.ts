import { describe, expect, it } from 'vitest';

import { EVERYTHING_ON } from '../game/rules';
import { activePreset, applyPreset, PRESET_TOGGLES, PRESETS } from './presets';
import { type Entry, Registry } from './registry';

/** A registry of plain boolean toggles, plus HUD and sound, which presets leave alone. */
function registry() {
  const state: Record<string, boolean> = { hud: true, sound: false };
  for (const id of PRESET_TOGGLES) state[id] = false;
  const entries: Entry[] = Object.keys(state).map((id) => ({
    id,
    label: id,
    hint: id,
    group: 'labels',
    kind: 'toggle',
    icon: 'map',
    get: () => state[id]!,
    run: () => (state[id] = !state[id]),
  }));
  return { state, reg: new Registry(entries, { rules: EVERYTHING_ON, message: () => '' }) };
}

const preset = (id: string) => PRESETS.find((p) => p.id === id)!;

describe('presets', () => {
  it('are the three agreed', () => {
    expect(PRESETS.map((p) => p.label)).toEqual(['Realistic', 'Navigator', 'Explorer']);
  });

  it('Realistic: every label and overlay off', () => {
    const { state, reg } = registry();
    for (const id of PRESET_TOGGLES) state[id] = true;
    applyPreset(reg, preset('realistic'));
    for (const id of PRESET_TOGGLES) expect(state[id], id).toBe(false);
    expect(activePreset(reg)?.id).toBe('realistic');
  });

  it('Navigator: names and piste colours, no debug', () => {
    const { state, reg } = registry();
    applyPreset(reg, preset('navigator'));
    expect([state.lift, state.peak, state.restaurant, state.pistes]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(state.debug).toBe(false);
    expect(activePreset(reg)?.id).toBe('navigator');
  });

  it('Explorer: everything, F3 debug included', () => {
    const { state, reg } = registry();
    applyPreset(reg, preset('explorer'));
    for (const id of PRESET_TOGGLES) expect(state[id], id).toBe(true);
    expect(activePreset(reg)?.id).toBe('explorer');
  });

  it('leave the HUD and sound alone', () => {
    const { state, reg } = registry();
    applyPreset(reg, preset('explorer'));
    applyPreset(reg, preset('realistic'));
    expect(state.hud).toBe(true);
    expect(state.sound).toBe(false);
  });

  it('a mix of your own matches none', () => {
    const { state, reg } = registry();
    applyPreset(reg, preset('navigator'));
    state.peak = false;
    expect(activePreset(reg)).toBeNull();
  });
});
