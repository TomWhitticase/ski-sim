import { describe, expect, it } from 'vitest';

import { DEFAULT_DISPLAY, loadDisplay, sanitizeDisplay, uiScale } from './display-settings';

describe('display settings', () => {
  it('falls back to defaults for missing or invalid values', () => {
    expect(sanitizeDisplay(null)).toEqual(DEFAULT_DISPLAY);
    expect(sanitizeDisplay({ glass: 'frosted', uiScale: 'big' })).toEqual(DEFAULT_DISPLAY);
  });

  it('keeps valid values and clamps the scale', () => {
    expect(sanitizeDisplay({ glass: 'tint', uiScale: 1.2 })).toEqual({
      glass: 'tint',
      uiScale: 1.2,
    });
    expect(sanitizeDisplay({ uiScale: 9 }).uiScale).toBe(1.5);
    expect(sanitizeDisplay({ uiScale: 0.1 }).uiScale).toBe(0.8);
  });

  it('scales with the window height within limits, times the choice', () => {
    expect(uiScale(900, 1)).toBe(1);
    expect(uiScale(1080, 1)).toBe(1.2);
    expect(uiScale(2160, 1)).toBe(1.3);
    expect(uiScale(600, 1)).toBe(0.85);
    expect(uiScale(900, 1.2)).toBe(1.2);
  });

  it('lets a phone go smaller, never a desktop window', () => {
    expect(uiScale(390, 1, 844)).toBe(0.7); // landscape phone
    expect(uiScale(844, 1, 390)).toBe(0.94); // portrait phone
    expect(uiScale(600, 1, 1000)).toBe(0.85);
  });

  it('starts a device on its own defaults until something is saved', () => {
    const none = { getItem: () => null };
    expect(loadDisplay(none, { glass: 'light' }).glass).toBe('light');
    const saved = { getItem: () => JSON.stringify({ glass: 'full', uiScale: 1 }) };
    expect(loadDisplay(saved, { glass: 'light' }).glass).toBe('full');
  });
});
