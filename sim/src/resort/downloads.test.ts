import { describe, expect, it } from 'vitest';

import { downloadFraction, formatBytes } from './downloads';

describe('downloadFraction', () => {
  it('is 0 with nothing started', () => {
    expect(downloadFraction([])).toBe(0);
  });

  it('weights files of known size by bytes', () => {
    const f = downloadFraction([
      { loaded: 50, total: 100, done: false },
      { loaded: 0, total: 300, done: false },
    ]);
    expect(f).toBeCloseTo(50 / 400);
  });

  it('counts a file of unknown size as the average known size, 0 until done', () => {
    const files = [
      { loaded: 100, total: 100, done: true },
      { loaded: 999, total: null, done: false },
    ];
    expect(downloadFraction(files)).toBeCloseTo(0.5);
    files[1]!.done = true;
    expect(downloadFraction(files)).toBe(1);
  });

  it('never goes past 1 when a server undercounts', () => {
    expect(downloadFraction([{ loaded: 150, total: 100, done: false }])).toBe(1);
  });
});

describe('formatBytes', () => {
  it('rounds to KB below a megabyte, else MB', () => {
    expect(formatBytes(850_000)).toBe('850 KB');
    expect(formatBytes(42_400_000)).toBe('42 MB');
  });
});
