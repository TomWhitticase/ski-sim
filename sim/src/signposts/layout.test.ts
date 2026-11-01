import { describe, expect, it } from 'vitest';

import {
  type Blade,
  bladeColour,
  bladeSide,
  bladeSub,
  bladeTitle,
  hudArrow,
  inkFor,
  naShape,
  quantiseArrow,
  relLuminance,
} from './layout';

const piste = (b: Partial<Blade> = {}): Blade => ({ kind: 'piste', name: null, rel: 0, ...b });

describe('bladeColour', () => {
  it('uses the difficulty colour for downhill runs', () => {
    expect(bladeColour(piste({ difficulty: 1, type: 'downhill' }))).toBe('#2e9e44');
    expect(bladeColour(piste({ difficulty: 2 }))).toBe('#1c6edc');
    expect(bladeColour(piste({ difficulty: 3 }))).toBe('#d62828');
    expect(bladeColour(piste({ difficulty: 4 }))).toBe('#19191c');
  });
  it('uses the type colour for non-downhill runs, and dark slate for lifts', () => {
    expect(bladeColour(piste({ type: 'snow_park' }))).toBe('#ff6e00');
    expect(bladeColour({ kind: 'lift', name: 'X', rel: 0 })).toBe('#2b2f36');
  });
});

describe('bladeTitle / bladeSub', () => {
  it('prefers the name, else a difficulty-named fallback', () => {
    expect(bladeTitle(piste({ name: 'Bellecombe' }))).toBe('Bellecombe');
    expect(bladeTitle(piste({ difficulty: 3 }))).toBe('Red run');
    expect(bladeTitle(piste({ difficulty: 1 }))).toBe('Green run');
  });
  it('subtitle is the destination for runs and "Lift" for lifts', () => {
    expect(bladeSub(piste({ to: 'Toura' }))).toBe('to Toura');
    expect(bladeSub(piste())).toBe('');
    expect(bladeSub({ kind: 'lift', name: 'X', rel: 0 })).toBe('Lift');
  });
});

describe('bladeSide', () => {
  it('splits into left / ahead / right at ±25°', () => {
    expect(bladeSide(-90)).toBe(-1);
    expect(bladeSide(-25)).toBe(0);
    expect(bladeSide(0)).toBe(0);
    expect(bladeSide(25)).toBe(0);
    expect(bladeSide(26)).toBe(1);
    expect(bladeSide(80)).toBe(1);
  });
});

describe('quantiseArrow / hudArrow', () => {
  it('snaps to 45° and clamps to ±135°', () => {
    expect(quantiseArrow(0)).toBe(0);
    expect(quantiseArrow(20)).toBe(0);
    expect(quantiseArrow(30)).toBe(45);
    expect(quantiseArrow(200)).toBe(135);
    expect(quantiseArrow(-200)).toBe(-135);
  });
  it('maps to the right unicode arrow', () => {
    expect(hudArrow(0)).toBe('↑');
    expect(hudArrow(-90)).toBe('←');
    expect(hudArrow(90)).toBe('→');
    expect(hudArrow(45)).toBe('↗');
    expect(hudArrow(-45)).toBe('↖');
  });
});

describe('inkFor (WCAG contrast)', () => {
  it('white on dark run colours, dark on bright ones', () => {
    expect(inkFor('#1c6edc')).toBe('#f7f8fa'); // blue
    expect(inkFor('#d62828')).toBe('#f7f8fa'); // red
    expect(inkFor('#19191c')).toBe('#f7f8fa'); // black
    // Light colours get dark ink, as the user asked for green: #2e9e44 reads 6.1:1 with
    // dark text vs 3.5:1 with white, and bright orange likewise.
    expect(inkFor('#2e9e44')).toBe('#17181b'); // green
    expect(inkFor('#ff6e00')).toBe('#17181b'); // bright orange
    expect(inkFor('#ffffff')).toBe('#17181b');
  });
  it('relLuminance is 0 for black and ~1 for white', () => {
    expect(relLuminance('#000000')).toBeCloseTo(0, 6);
    expect(relLuminance('#ffffff')).toBeCloseTo(1, 6);
  });
});

describe('naShape', () => {
  it('maps difficulty to the North-American shape', () => {
    expect(naShape(piste({ difficulty: 1 }))).toBe('circle');
    expect(naShape(piste({ difficulty: 2 }))).toBe('square');
    expect(naShape(piste({ difficulty: 3 }))).toBe('diamond');
    expect(naShape(piste({ difficulty: 5 }))).toBe('double-diamond');
    expect(naShape(piste({ type: 'snow_park' }))).toBe(null);
    expect(naShape({ kind: 'lift', name: 'X', rel: 0 })).toBe(null);
  });
});
