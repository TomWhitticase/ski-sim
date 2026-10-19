import { describe, expect, it } from 'vitest';

import {
  decodeRunCode,
  PisteLookup,
  type PisteRecord,
  pisteColour,
  pisteKind,
  pisteTitle,
  runLabel,
} from './pistes';

const piste = (index: number, name: string | null, difficulty: 1 | 2 | 3 | 4 | 6) =>
  ({ index, name, difficulty, groomed: difficulty !== 6 }) as PisteRecord;

describe('PisteLookup', () => {
  // 3x2 grid, 8 m cells: indices [[0, 1, 300], [0, 0, 1]] (300 needs the high byte).
  const data = new Uint8ClampedArray(3 * 2 * 4);
  const put = (i: number, index: number) => {
    data[i * 4] = index & 255;
    data[i * 4 + 1] = index >> 8;
  };
  put(1, 1);
  put(2, 300);
  put(5, 1);
  data[1 * 4 + 2] = 3; // red downhill
  data[2 * 4 + 2] = (1 << 4) | 0; // snow park, no difficulty
  const pixels = { data, width: 3, height: 2, colorSpace: 'srgb' } as ImageData;
  const lookup = new PisteLookup(pixels, 8, { west: 0, east: 16, south: -8, north: 0 }, [
    piste(1, 'Christine', 3),
    piste(300, null, 2),
  ]);

  it('finds the nearest grid cell (row 0 = north)', () => {
    expect(lookup.at(0, 0)).toBeNull();
    expect(lookup.at(9, -1)?.name).toBe('Christine');
    expect(lookup.at(16, 0)?.index).toBe(300);
    expect(lookup.at(15, -7)?.name).toBe('Christine');
  });

  it('decodes the run type and difficulty from the grid', () => {
    expect(lookup.codeAt(9, -1)).toEqual({ difficulty: 3, type: 'downhill' });
    expect(lookup.codeAt(16, 0)).toEqual({ difficulty: 0, type: 'snow_park' });
    expect(lookup.codeAt(0, 0)).toBeNull();
  });

  it('is empty outside the grid', () => {
    expect(lookup.at(-50, 0)).toBeNull();
    expect(lookup.at(0, 50)).toBeNull();
  });
});

describe('pisteTitle', () => {
  it('names unnamed runs by colour', () => {
    expect(pisteTitle(piste(1, 'Christine', 3))).toBe('Christine');
    expect(pisteTitle(piste(2, null, 2))).toBe('Unnamed blue piste');
  });
});

describe('run types', () => {
  const of = (extra: Partial<PisteRecord>) => ({ ...piste(5, null, 2), ...extra }) as PisteRecord;

  it('decodes every type code, downhill being 0', () => {
    expect(decodeRunCode(4)).toEqual({ difficulty: 4, type: 'downhill' });
    expect(decodeRunCode((3 << 4) | 1)).toEqual({ difficulty: 1, type: 'nordic' });
    expect(decodeRunCode(7 << 4)).toEqual({ difficulty: 0, type: 'connection' });
  });

  it('colours parks orange, and connections by difficulty when they have one', () => {
    expect(pisteColour(of({ type: 'snow_park', difficulty: 0 }))).toBe('#ff6e00');
    expect(pisteColour(of({ type: 'connection', difficulty: 0 }))).toBe('#82828c');
    expect(pisteColour(of({ type: 'connection', difficulty: 3 }))).toBe('#d62828');
    expect(pisteColour(of({}))).toBe('#1c6edc'); // older builds: no type, downhill
    expect(pisteKind(of({ type: 'sled', difficulty: 0 }))).toBe('Sledging run');
  });

  it('labels the run row with its number and what it is', () => {
    expect(runLabel(of({ name: 'Bettex', ref: '107' }))).toBe('107 Bettex');
    expect(runLabel(of({ name: '12 Combe', ref: '12' }))).toBe('12 Combe');
    expect(runLabel(of({ name: 'BK Park', type: 'snow_park', difficulty: 0 }))).toBe('BK Park');
    expect(runLabel(of({ name: 'Cosmojet', type: 'sled', difficulty: 0 }))).toBe(
      'Cosmojet · Sledging run',
    );
    expect(runLabel(of({ name: 'Le Lac', type: 'nordic', difficulty: 0, oneway: true }))).toBe(
      'Le Lac · Cross-country track · one-way',
    );
    expect(runLabel(of({ type: 'playground', difficulty: 0 }))).toBe("Kids' area");
  });
});
