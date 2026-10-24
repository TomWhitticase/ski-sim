import { describe, expect, it } from 'vitest';
import {
  EVERYTHING_ON,
  loadRules,
  REALISTIC,
  RULES,
  ruleOffMessage,
  rulesPreset,
  sameRules,
  sanitizeRules,
  saveRules,
} from './rules';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

describe('game rules', () => {
  it('defaults to everything on when nothing is stored or it is garbage', () => {
    expect(loadRules(memory())).toEqual(EVERYTHING_ON);
    const s = memory();
    s.setItem('ski-sim.rules', '{not json');
    expect(loadRules(s)).toEqual(EVERYTHING_ON);
  });

  it('round-trips through storage', () => {
    const s = memory();
    const rules = { ...EVERYTHING_ON, snowmobile: false, liftSkip: false };
    saveRules(s, rules);
    expect(loadRules(s)).toEqual(rules);
  });

  it('keeps only boolean rules and fills missing ones in as on', () => {
    expect(sanitizeRules({ teleport: false, snowmobile: 'no', extra: false })).toEqual({
      ...EVERYTHING_ON,
      teleport: false,
    });
    expect(sanitizeRules(null)).toEqual(EVERYTHING_ON);
    expect(sanitizeRules([false])).toEqual(EVERYTHING_ON);
  });

  it('realistic switches every rule off', () => {
    for (const { name } of RULES) {
      expect(REALISTIC[name]).toBe(false);
      expect(EVERYTHING_ON[name]).toBe(true);
    }
    expect(Object.keys(REALISTIC).sort()).toEqual(RULES.map((r) => r.name).sort());
  });

  it('names the preset the rules match', () => {
    expect(rulesPreset(REALISTIC)).toBe('realistic');
    expect(rulesPreset({ ...EVERYTHING_ON })).toBe('everything');
    expect(rulesPreset({ ...REALISTIC, paraglider: true })).toBeNull();
    expect(sameRules(REALISTIC, { ...REALISTIC })).toBe(true);
  });

  it('says why an action is refused, and where to change it when alone', () => {
    expect(ruleOffMessage('teleport', true)).toBe('Teleporting is off in this game');
    expect(ruleOffMessage('snowmobile', false)).toBe('The snowmobile is off · Options → Rules');
  });
});
