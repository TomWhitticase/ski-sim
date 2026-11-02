import { describe, expect, it } from 'vitest';

import { HINTS, HintScheduler, loadSeen, nextHint, saveSeen } from './hints';

const T = { settle: 6, gap: 40, show: 7 };

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

describe('nextHint', () => {
  const all = new Set(HINTS.map((h) => h.id));

  it('waits for play to settle', () => {
    expect(nextHint(all, new Set(), 2, null, false, T)).toBeNull();
    expect(nextHint(all, new Set(), 6, null, false, T)?.id).toBe('quick');
  });

  it('shows only relevant, unseen hints, most useful first', () => {
    expect(nextHint(new Set(['peak']), new Set(), 10, null, false, T)?.id).toBe('peak');
    expect(nextHint(new Set(['peak']), new Set(['peak']), 10, null, false, T)).toBeNull();
    expect(nextHint(new Set(['peak', 'lift']), new Set(), 10, null, false, T)?.id).toBe('lift');
    expect(nextHint(new Set(), new Set(), 10, null, false, T)).toBeNull();
  });

  it('spaces hints out', () => {
    expect(nextHint(all, new Set(['quick']), 30, 10, false, T)).toBeNull();
    expect(nextHint(all, new Set(['quick']), 50, 10, false, T)?.id).toBe('lift');
  });

  it('skips keyboard-only hints on touch', () => {
    expect(nextHint(new Set(['palette']), new Set(), 10, null, true, T)).toBeNull();
    expect(nextHint(new Set(['palette']), new Set(), 10, null, false, T)?.id).toBe('palette');
  });
});

describe('HintScheduler', () => {
  it('shows each hint once, ever, and remembers it across sessions', () => {
    const storage = memory();
    const a = new HintScheduler(storage, undefined, T);
    expect(a.tick(new Set(['peak']), 10, false)?.id).toBe('peak');
    // Relevant again later: never repeated.
    expect(a.tick(new Set(['peak']), 100, false)).toBeNull();
    const b = new HintScheduler(storage, undefined, T);
    expect(b.tick(new Set(['peak']), 100, false)).toBeNull();
    expect([...loadSeen(storage)]).toEqual(['peak']);
  });

  it('one at a time: the next waits for the gap', () => {
    const s = new HintScheduler(memory(), undefined, T);
    expect(s.tick(new Set(['peak', 'lift']), 10, false)?.id).toBe('lift');
    expect(s.tick(new Set(['peak', 'lift']), 20, false)).toBeNull();
    expect(s.tick(new Set(['peak', 'lift']), 51, false)?.id).toBe('peak');
  });

  it('marks a hint seen when you find the feature yourself, and can start over', () => {
    const storage = memory();
    const s = new HintScheduler(storage, undefined, T);
    s.markSeen('peak');
    expect(s.tick(new Set(['peak']), 10, false)).toBeNull();
    s.reset();
    expect(loadSeen(storage).size).toBe(0);
    expect(s.tick(new Set(['peak']), 10, false)?.id).toBe('peak');
  });

  it('survives junk in storage', () => {
    const storage = memory();
    storage.setItem('ski-sim.hints-seen', '{nope');
    expect(loadSeen(storage).size).toBe(0);
    storage.setItem('ski-sim.hints-seen', '[1, "peak"]');
    expect([...loadSeen(storage)]).toEqual(['peak']);
    saveSeen(storage, new Set(['a']));
    expect(storage.getItem('ski-sim.hints-seen')).toBe('["a"]');
  });
});
