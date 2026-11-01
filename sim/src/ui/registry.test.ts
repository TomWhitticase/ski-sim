import { describe, expect, it } from 'vitest';

import { EVERYTHING_ON, type GameRules } from '../game/rules';
import { type Entry, GROUPS, keyLabel, matchesKey, Registry, search, statusOf } from './registry';
import { createEntries, type PlayMode, type TabName, type ToggleDeps, touchTools } from './toggles';

/** A fake game: every toggle a boolean, every action logged. */
function fakeGame() {
  const state: Record<string, boolean> = {
    lift: false,
    peak: false,
    restaurant: false,
    pistes: false,
    hud: true,
    sound: true,
    firstPerson: false,
    snowboard: false,
    sign: true,
    debug: false,
  };
  const calls: string[] = [];
  const game = { mode: 'ski' as PlayMode, mapOpen: false, marker: false };
  const flag = (k: string) => ({
    get: () => state[k]!,
    set: (on: boolean) => {
      state[k] = on;
    },
  });
  const deps: ToggleDeps = {
    label: (kind) => state[kind]!,
    setLabel: (kind, on) => (state[kind] = on),
    pistes: flag('pistes').get,
    setPistes: flag('pistes').set,
    hud: flag('hud').get,
    setHud: flag('hud').set,
    sound: flag('sound').get,
    setSound: flag('sound').set,
    firstPerson: flag('firstPerson').get,
    setFirstPerson: flag('firstPerson').set,
    snowboard: flag('snowboard').get,
    setSnowboard: flag('snowboard').set,
    signReadout: flag('sign').get,
    setSignReadout: flag('sign').set,
    debug: flag('debug').get,
    setDebug: flag('debug').set,
    fullscreen: () => false,
    fullscreenEnabled: () => true,
    toggleFullscreen: () => calls.push('fullscreen'),
    mode: () => game.mode,
    mapOpen: () => game.mapOpen,
    hasMarker: () => game.marker,
    hasBody: () => false,
    toggleMap: () => calls.push('map'),
    drone: () => calls.push('drone'),
    skiHere: () => calls.push('ski-here'),
    paraglider: () => calls.push('paraglider'),
    snowmobile: () => calls.push('snowmobile'),
    dropMarker: () => calls.push('drop-marker'),
    goToMarker: () => calls.push('go-to-marker'),
    screenshot: () => calls.push('screenshot'),
    openTab: (tab: TabName) => calls.push(`tab:${tab}`),
    quickOpen: () => false,
    toggleQuick: () => calls.push('quick'),
  };
  const rules: GameRules = { ...EVERYTHING_ON };
  const registry = new Registry(createEntries(deps), {
    rules,
    message: (rule) => `${rule} is off`,
  });
  return { state, calls, game, rules, registry };
}

describe('the registry', () => {
  it('has unique ids, a known group and icon, and no key bound twice', () => {
    const { registry } = fakeGame();
    const groups = new Set<string>(GROUPS.map((g) => g.id));
    const keys = new Set<string>();
    for (const e of registry.entries) {
      expect(groups.has(e.group), e.id).toBe(true);
      expect(e.label.length, e.id).toBeGreaterThan(0);
      expect(e.hint.length, e.id).toBeGreaterThan(0);
      if (!e.key) continue;
      const k = `${e.key.shift ? 'shift+' : ''}${e.key.code}`;
      expect(keys.has(k), k).toBe(false);
      keys.add(k);
    }
  });

  it('keeps every single-key shortcut players know', () => {
    const { registry } = fakeGame();
    const at = (code: string, shift = false) => registry.forKey(code, shift)?.id;
    expect(at('Digit1')).toBe('lift');
    expect(at('Numpad1')).toBe('lift');
    expect(at('Digit2')).toBe('peak');
    expect(at('Digit3')).toBe('pistes');
    expect(at('Digit4')).toBe('restaurant');
    expect(at('KeyH')).toBe('hud');
    expect(at('KeyV')).toBe('view');
    expect(at('KeyK')).toBe('sound');
    expect(at('KeyY')).toBe('discipline');
    expect(at('KeyM')).toBe('map');
    expect(at('KeyM', true)).toBe('drop-marker');
    expect(at('KeyF')).toBe('drone');
    expect(at('KeyR')).toBe('ski-here');
    expect(at('KeyP')).toBe('paraglider');
    expect(at('KeyB')).toBe('snowmobile');
    expect(at('KeyJ')).toBe('go-to-marker');
    expect(at('KeyG')).toBe('tab-ski');
    expect(at('KeyT')).toBe('tab-time');
    expect(at('KeyC')).toBe('tab-weather');
    expect(at('KeyO')).toBe('tab-camera');
    expect(at('KeyN')).toBe('tab-multiplayer');
    expect(at('F2')).toBe('screenshot');
    expect(at('F3')).toBe('debug');
    expect(at('Tab')).toBe('quick-settings');
    // Not the registry's: they mean different things by context (main.ts act()).
    expect(at('KeyE')).toBeUndefined();
    expect(at('KeyU')).toBeUndefined();
    // Shift doesn't stop a plain key (Shift + 2 is still peak names).
    expect(at('Digit2', true)).toBe('peak');
  });

  it('Shift+M with the map open falls back to M (closing it)', () => {
    const { registry, game } = fakeGame();
    game.mapOpen = true;
    expect(registry.forKey('KeyM', true)?.id).toBe('map');
  });

  it('toggles flip their state; presets set it', () => {
    const { registry, state } = fakeGame();
    registry.get('peak')!.run();
    expect(state.peak).toBe(true);
    registry.set(registry.get('peak')!, true);
    expect(state.peak).toBe(true);
    registry.set(registry.get('hud')!, false);
    expect(state.hud).toBe(false);
    // Setting an action does nothing.
    registry.set(registry.get('map')!, true);
  });

  it('all names: on if any is, and sets every kind together', () => {
    const { registry, state } = fakeGame();
    const names = registry.get('names')!;
    expect(registry.isOn(names)).toBe(false);
    state.peak = true;
    expect(registry.isOn(names)).toBe(true);
    names.run();
    expect([state.lift, state.peak, state.restaurant]).toEqual([false, false, false]);
    names.run();
    expect([state.lift, state.peak, state.restaurant]).toEqual([true, true, true]);
  });

  it('disables entries by mode, with the reason', () => {
    const { registry, game } = fakeGame();
    const status = (id: string) => registry.status(registry.get(id)!);
    expect(status('view').enabled).toBe(true);
    game.mode = 'fly';
    expect(status('view')).toEqual({ enabled: false, reason: 'The drone has no first person' });
    expect(status('ski-here').enabled).toBe(true);
    game.mode = 'ride';
    expect(status('drone').reason).toBe('Not on a lift');
    expect(status('snowmobile').reason).toBe('Not on a lift');
    game.mode = 'plane';
    expect(status('paraglider').reason).toBe('Not in an aircraft');
    expect(status('go-to-marker').reason).toBe('No guide marker set');
    game.mapOpen = true;
    expect(status('tab-weather').reason).toBe('Close the map first');
  });

  it('disables entries the game rules switch off, unless you are on one now', () => {
    const { registry, rules, game } = fakeGame();
    const glider = registry.get('paraglider')!;
    expect(registry.status(glider).enabled).toBe(true);
    rules.paraglider = false;
    expect(registry.status(glider)).toEqual({ enabled: false, reason: 'paraglider is off' });
    // Already gliding: you can always drop the wing.
    game.mode = 'glide';
    expect(registry.status(glider).enabled).toBe(true);
    rules.teleport = false;
    game.marker = true;
    expect(registry.status(registry.get('go-to-marker')!).reason).toBe('teleport is off');
  });

  it('touch tools: the row in order, labels as one button, HUD and sound added', () => {
    const { registry } = fakeGame();
    expect(touchTools(registry.entries).map((e) => e.tool!.id)).toEqual([
      'map',
      'fly',
      'glider',
      'sled',
      'view',
      'labels',
      'pistes',
      'sound',
      'hud',
      'fullscreen',
    ]);
  });

  it('notifies listeners of changes', () => {
    const { registry } = fakeGame();
    const heard: [string | null, boolean][] = [];
    registry.subscribe((id, announce) => heard.push([id, announce]));
    registry.changed('peak', true);
    registry.changed(null);
    expect(heard).toEqual([
      ['peak', true],
      [null, false],
    ]);
  });

  it('refuses duplicate ids', () => {
    const e: Entry = {
      id: 'x',
      label: 'X',
      hint: 'x',
      group: 'view',
      kind: 'action',
      icon: 'map',
      run() {},
    };
    expect(() => new Registry([e, e], { rules: EVERYTHING_ON, message: () => '' })).toThrow(/x/);
  });
});

describe('keys', () => {
  it('matches codes, the numpad and Shift', () => {
    expect(matchesKey({ code: 'Digit1', also: ['Numpad1'], glyph: '1' }, 'Numpad1', false)).toBe(
      true,
    );
    expect(matchesKey({ code: 'KeyM', shift: true, glyph: 'M' }, 'KeyM', false)).toBe(false);
    expect(matchesKey({ code: 'KeyM', shift: true, glyph: 'M' }, 'KeyM', true)).toBe(true);
    expect(matchesKey({ code: 'KeyM', glyph: 'M' }, 'KeyN', false)).toBe(false);
  });

  it('labels them as shown', () => {
    expect(keyLabel({ code: 'KeyM', shift: true, glyph: 'M' })).toBe('Shift + M');
    expect(keyLabel({ code: 'F3', glyph: 'F3' })).toBe('F3');
  });
});

describe('search', () => {
  const ids = (q: string) => search(fakeGame().registry.entries, q).map((e) => e.id);

  it('finds by label, best first', () => {
    expect(ids('peak')[0]).toBe('peak');
    expect(ids('snowm')[0]).toBe('snowmobile');
    expect(ids('weather')[0]).toBe('tab-weather');
  });

  it('finds by synonym, ignoring case and accents', () => {
    expect(ids('mute')).toEqual(['sound']);
    expect(ids('FPS')).toContain('debug');
    expect(ids('skidoo')).toEqual(['snowmobile']);
    expect(ids('café')).toContain('restaurant');
  });

  it('needs every word to match', () => {
    expect(ids('names')).toEqual(expect.arrayContaining(['lift', 'peak', 'restaurant', 'names']));
    expect(ids('peak names')[0]).toBe('peak');
    expect(ids('peak zebra')).toEqual([]);
  });

  it('lists everything for an empty query, in registry order', () => {
    const { registry } = fakeGame();
    expect(ids('')).toEqual(registry.entries.map((e) => e.id));
  });
});

describe('statusOf', () => {
  it('reports the context reason before the rule', () => {
    const e: Entry = {
      id: 'x',
      label: 'X',
      hint: 'x',
      group: 'go',
      kind: 'action',
      icon: 'map',
      rule: 'snowmobile',
      run() {},
      unavailable: () => 'Not now',
    };
    const ctx = { rules: { ...EVERYTHING_ON, snowmobile: false }, message: () => 'Off' };
    expect(statusOf(e, ctx)).toEqual({ enabled: false, reason: 'Not now' });
  });
});
