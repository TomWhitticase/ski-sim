import { describe, expect, it } from 'vitest';

import { DESKTOP_QUALITY, MOBILE_QUALITY } from './quality';
import {
  applyGraphics,
  defaultPreset,
  GRAPHICS_KEY,
  GRAPHICS_PRESETS,
  graphics,
  isGraphicsPreset,
  loadGraphics,
  minTerrainDetail,
  optionsEqual,
  presetFor,
  sanitizeGraphics,
  saveGraphics,
  setGraphicsPreset,
  TERRAIN_DETAIL_TIERS,
  terrainDetailCeiling,
  terrainDetailFor,
} from './graphics';

const fakeGet = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => value });

describe('graphics presets', () => {
  it('orders the presets cheapest → richest by terrain detail', () => {
    expect(GRAPHICS_PRESETS.fast.terrainDetail).toBe('off');
    expect(GRAPHICS_PRESETS.default.terrainDetail).toBe('high');
    expect(GRAPHICS_PRESETS.fancy.terrainDetail).toBe('ultra');
  });

  it('Default high tier equals today’s desktop look, and its disabled off tier is truly off', () => {
    expect(TERRAIN_DETAIL_TIERS.high).toEqual(DESKTOP_QUALITY.terrainDetail);
    expect(TERRAIN_DETAIL_TIERS.off.enabled).toBe(false);
  });

  it('Low tier equals today’s mobile look (so the phone tier is unchanged)', () => {
    expect(TERRAIN_DETAIL_TIERS.low).toEqual(MOBILE_QUALITY.terrainDetail);
  });

  it('Ultra is richer than High (stronger and reaching further), not just more octaves', () => {
    expect(TERRAIN_DETAIL_TIERS.ultra.strength).toBeGreaterThan(TERRAIN_DETAIL_TIERS.high.strength);
    expect(TERRAIN_DETAIL_TIERS.ultra.fadeScale).toBeGreaterThan(
      TERRAIN_DETAIL_TIERS.high.fadeScale,
    );
  });
});

describe('preset ↔ options matching (Custom detection)', () => {
  it('reports the matching preset for its own options', () => {
    expect(presetFor(GRAPHICS_PRESETS.fast)).toBe('fast');
    expect(presetFor(GRAPHICS_PRESETS.default)).toBe('default');
    expect(presetFor(GRAPHICS_PRESETS.fancy)).toBe('fancy');
  });

  it('reports null (Custom) when an option is overridden off a preset', () => {
    expect(presetFor({ terrainDetail: 'low' })).toBeNull();
  });

  it('optionsEqual compares every field', () => {
    expect(optionsEqual({ terrainDetail: 'high' }, { terrainDetail: 'high' })).toBe(true);
    expect(optionsEqual({ terrainDetail: 'high' }, { terrainDetail: 'ultra' })).toBe(false);
  });
});

describe('device tier ↔ preset interaction', () => {
  it('every device starts on Default (the tier changes the cap, not the start preset)', () => {
    expect(defaultPreset()).toBe('default');
  });

  it('caps terrain detail to low on touch devices, leaves desktop uncapped', () => {
    expect(terrainDetailCeiling(true)).toBe('low');
    expect(terrainDetailCeiling(false)).toBe('ultra');
    // Fancy (ultra) requested on a phone resolves to the low tier, not ultra.
    expect(terrainDetailFor('ultra', true)).toEqual(TERRAIN_DETAIL_TIERS.low);
    // The same request on desktop runs ultra in full.
    expect(terrainDetailFor('ultra', false)).toEqual(TERRAIN_DETAIL_TIERS.ultra);
    // Fast (off) still drops detail even on a phone.
    expect(terrainDetailFor('off', true)).toEqual(TERRAIN_DETAIL_TIERS.off);
  });

  it('Default on a phone resolves to today’s mobile look', () => {
    expect(terrainDetailFor(GRAPHICS_PRESETS.default.terrainDetail, true)).toEqual(
      MOBILE_QUALITY.terrainDetail,
    );
  });

  it('minTerrainDetail picks the lower level either way round', () => {
    expect(minTerrainDetail('high', 'low')).toBe('low');
    expect(minTerrainDetail('off', 'ultra')).toBe('off');
    expect(minTerrainDetail('ultra', 'ultra')).toBe('ultra');
  });

  it('applyGraphics overrides only terrainDetail on the quality budget', () => {
    const q = applyGraphics(DESKTOP_QUALITY, { terrainDetail: 'off' }, false);
    expect(q.terrainDetail.enabled).toBe(false);
    // Hardware budgets are left to the device tier.
    expect(q.shadowMapSize).toBe(DESKTOP_QUALITY.shadowMapSize);
    expect(q.maxPixelRatio).toBe(DESKTOP_QUALITY.maxPixelRatio);
  });
});

describe('sanitize / persistence', () => {
  it('falls back to the given preset for missing or invalid values', () => {
    expect(sanitizeGraphics(null)).toEqual(GRAPHICS_PRESETS.default);
    expect(sanitizeGraphics({ terrainDetail: 'cinematic' })).toEqual(GRAPHICS_PRESETS.default);
    expect(sanitizeGraphics({}, GRAPHICS_PRESETS.fast)).toEqual(GRAPHICS_PRESETS.fast);
  });

  it('keeps a valid stored level', () => {
    expect(sanitizeGraphics({ terrainDetail: 'ultra' })).toEqual({ terrainDetail: 'ultra' });
  });

  it('loads the Default preset when nothing is stored', () => {
    expect(loadGraphics(fakeGet(null))).toEqual(GRAPHICS_PRESETS.default);
  });

  it('loads and honours a saved choice', () => {
    const stored = JSON.stringify({ terrainDetail: 'ultra' });
    expect(loadGraphics(fakeGet(stored))).toEqual({ terrainDetail: 'ultra' });
  });

  it('survives malformed JSON', () => {
    expect(loadGraphics(fakeGet('{not json'))).toEqual(GRAPHICS_PRESETS.default);
  });

  it('round-trips through save/load', () => {
    setGraphicsPreset('fancy');
    let written = '';
    saveGraphics({ setItem: (_k, v) => (written = v) });
    expect(JSON.parse(written)).toEqual(GRAPHICS_PRESETS.fancy);
    // reset the shared singleton so other tests are not affected by order
    setGraphicsPreset('default');
    expect(graphics).toEqual(GRAPHICS_PRESETS.default);
  });

  it('uses the documented localStorage key', () => {
    expect(GRAPHICS_KEY).toBe('ski-sim.graphics');
  });
});

describe('url override guard', () => {
  it('recognises the three preset names and rejects others', () => {
    expect(isGraphicsPreset('fast')).toBe(true);
    expect(isGraphicsPreset('fancy')).toBe(true);
    expect(isGraphicsPreset('turbo')).toBe(false);
    expect(isGraphicsPreset(null)).toBe(false);
  });
});
