import { describe, expect, it } from 'vitest';

import {
  BASE_HANDLING,
  DEFAULT_HANDLING,
  DEFAULT_SETUP,
  loadSetup,
  matchPreset,
  parseSetup,
  saveSetup,
  SETUP_KEY,
  SKI_PRESETS,
  skiDimensions,
  skiHandling,
} from './ski-setup';

describe('skiHandling', () => {
  it('maps the All-mountain reference onto the base physics exactly', () => {
    expect(DEFAULT_HANDLING.snowFriction).toBe(0.045);
    expect(DEFAULT_HANDLING.powderFriction).toBeCloseTo(0.08, 10);
    expect(DEFAULT_HANDLING.powderDrag).toBeCloseTo(BASE_HANDLING.powderDrag, 10);
    expect(DEFAULT_HANDLING.carveRate).toBeCloseTo(BASE_HANDLING.carveRate, 10);
    expect(DEFAULT_HANDLING.skidDecel).toBeCloseTo(BASE_HANDLING.skidDecel, 10);
    for (const k of ['hardGrip', 'powderGrip', 'turnRate', 'pivotRate', 'edgeRate'] as const) {
      expect(DEFAULT_HANDLING[k], k).toBeCloseTo(1, 10);
    }
    expect(DEFAULT_HANDLING.stiffness).toBe(0);
  });

  it('follows the rules of thumb', () => {
    const base = DEFAULT_SETUP;
    const h = (patch: Partial<typeof base>) => skiHandling({ ...base, ...patch });
    expect(h({ length: 195 }).stableSpeed).toBeGreaterThan(h({ length: 160 }).stableSpeed);
    expect(h({ length: 160 }).turnRate).toBeGreaterThan(h({ length: 195 }).turnRate);
    expect(h({ waist: 115 }).powderFriction).toBeLessThan(h({ waist: 70 }).powderFriction);
    expect(h({ waist: 70 }).edgeRate).toBeGreaterThan(h({ waist: 115 }).edgeRate);
    expect(h({ radius: 12 }).carveRate).toBeGreaterThan(h({ radius: 25 }).carveRate);
    expect(h({ flex: 10 }).stableSpeed).toBeGreaterThan(h({ flex: 2 }).stableSpeed);
    expect(h({ profile: 'full-rocker' }).powderFriction).toBeLessThan(
      h({ profile: 'camber' }).powderFriction,
    );
    expect(h({ profile: 'camber' }).hardGrip).toBeGreaterThan(
      h({ profile: 'full-rocker' }).hardGrip,
    );
    expect(h({ wax: 'race' }).snowFriction).toBeLessThan(h({ wax: 'unwaxed' }).snowFriction);
    expect(h({ tune: 'race' }).hardGrip).toBeGreaterThan(h({ tune: 'dull' }).hardGrip);
    expect(h({ mount: 3 }).pivotRate).toBeGreaterThan(h({ mount: -3 }).pivotRate);
  });

  it('keeps every extreme setup playable', () => {
    const extremes = [
      { length: 140, waist: 125, radius: 32, flex: 1, profile: 'full-rocker', tune: 'dull' },
      { length: 200, waist: 64, radius: 10, flex: 10, profile: 'camber', tune: 'race' },
    ] as const;
    for (const e of extremes) {
      const h = skiHandling({ ...DEFAULT_SETUP, ...e, wax: 'unwaxed', mount: 4 });
      expect(h.maxSpeed).toBeGreaterThan(15);
      expect(h.maxSpeed).toBeLessThanOrEqual(BASE_HANDLING.maxSpeed);
      expect(h.carveRate * h.hardGrip).toBeGreaterThan(1);
      expect(h.powderFriction).toBeLessThan(0.15);
      expect(h.turnRate).toBeGreaterThan(0.6);
      expect(h.turnRate).toBeLessThan(1.8);
    }
  });
});

describe('skiDimensions', () => {
  it('is chin-to-head height for the ~1.8 m skier, mounted just behind centre', () => {
    const d = skiDimensions(DEFAULT_SETUP);
    expect(d.length).toBeCloseTo(1.78, 5);
    expect(d.tail).toBeLessThan(d.length / 2);
    expect(d.tail).toBeGreaterThan(d.length / 2 - 0.1);
    expect(d.waistWidth).toBeCloseTo(0.088, 5);
    // Sidecut depth from the radius gives realistic tip/tail widths (~122/88/113 mm).
    expect(d.tipWidth).toBeGreaterThan(0.115);
    expect(d.tipWidth).toBeLessThan(0.13);
    expect(d.tailWidth).toBeLessThan(d.tipWidth);
  });

  it('tighter radius means deeper sidecut; rocker lifts the tip further back', () => {
    const sl = skiDimensions({ ...DEFAULT_SETUP, radius: 12 });
    const gs = skiDimensions({ ...DEFAULT_SETUP, radius: 25 });
    expect(sl.tipWidth - sl.waistWidth).toBeGreaterThan(gs.tipWidth - gs.waistWidth);
    const rocker = skiDimensions({ ...DEFAULT_SETUP, profile: 'full-rocker' });
    expect(rocker.rockerStart).toBeLessThan(skiDimensions(DEFAULT_SETUP).rockerStart);
  });
});

describe('presets and storage', () => {
  it('recognises presets and custom setups', () => {
    expect(matchPreset(SKI_PRESETS.gs.setup)).toBe('gs');
    expect(matchPreset(DEFAULT_SETUP)).toBe('all-mountain');
    expect(matchPreset({ ...DEFAULT_SETUP, length: 179 })).toBeNull();
  });

  it('round-trips through storage and repairs bad data', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadSetup(storage)).toEqual(DEFAULT_SETUP);
    saveSetup(storage, SKI_PRESETS.park.setup);
    expect(SETUP_KEY.startsWith('ski-sim.')).toBe(true);
    expect(loadSetup(storage)).toEqual(SKI_PRESETS.park.setup);
    store.set(SETUP_KEY, '{not json');
    expect(loadSetup(storage)).toEqual(DEFAULT_SETUP);
    expect(parseSetup({ length: 999, waist: 'wide', profile: 'banana', mount: -2 })).toEqual({
      ...DEFAULT_SETUP,
      length: 200,
      mount: -2,
    });
  });
});
