import { describe, expect, it } from 'vitest';

import {
  advanceShared,
  CODE_LENGTH,
  cleanName,
  loadName,
  nameProblem,
  loadParty,
  partyLink,
  saveParty,
  inviteLink,
  PUBLIC_SITE,
  liftCorrection,
  makeRoomCode,
  parseRoomCode,
} from './room';

describe('room codes', () => {
  it('makes codes that parse back, from an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).not.toMatch(/[01OI]/);
      expect(parseRoomCode(code)).toBe(code);
    }
  });

  it('accepts sloppy typing, rejects what cannot be a code', () => {
    expect(parseRoomCode(' abc-def ')).toBe('ABCDEF');
    expect(parseRoomCode('abc de f')).toBe('ABCDEF');
    expect(parseRoomCode('ABCDE')).toBeNull();
    expect(parseRoomCode('ABCDEO')).toBeNull(); // no O (or 0) in codes
    expect(parseRoomCode('ABC!EF')).toBeNull();
  });

  it('builds an invite link with the resort and code only', () => {
    expect(inviteLink('http://x.test/ski/?at=1,2,3&resort=a#h', 'arlberg', 'ABCDEF')).toBe(
      'http://x.test/ski/?resort=arlberg&join=ABCDEF',
    );
  });

  it('points invites from a local dev server at the public site', () => {
    for (const host of ['localhost:5173', '127.0.0.1:5173', '192.168.1.20:5173', '[::1]:5173']) {
      expect(inviteLink(`http://${host}/?at=1,2,3`, 'paradiski', 'ABCDEF')).toBe(
        `${PUBLIC_SITE}?resort=paradiski&join=ABCDEF`,
      );
    }
  });

  it('cleans names', () => {
    expect(cleanName('  Ana  ')).toBe('Ana');
    expect(cleanName('   ')).toBe('');
    expect(cleanName('a\u0007b')).toBe('ab');
    expect(cleanName('x'.repeat(50))).toHaveLength(20);
  });
});

describe('shared clocks', () => {
  it('advances the host clocks by the one-way latency', () => {
    expect(advanceShared({ lift: 100, seconds: 3600, rate: 60 }, 0.05)).toEqual({
      lift: 100.05,
      seconds: 3603,
      rate: 60,
    });
  });

  it('slews small lift-clock errors and snaps big ones', () => {
    expect(liftCorrection(0.5, 1 / 60)).toBeCloseTo(0.5 * 0.8 * (1 / 60), 6);
    expect(liftCorrection(-0.5, 1 / 60)).toBeLessThan(0);
    expect(liftCorrection(30, 1 / 60)).toBe(30);
    // Worked off within a few seconds.
    let error = 1.5;
    for (let i = 0; i < 60 * 5; i++) error -= liftCorrection(error, 1 / 60);
    expect(Math.abs(error)).toBeLessThan(0.05);
  });
});

describe('names', () => {
  it('must be chosen: no blank names and not the default', () => {
    expect(nameProblem('')).toMatch(/Enter your name/);
    expect(nameProblem('   ')).toMatch(/Enter your name/);
    expect(nameProblem('skier')).toMatch(/of your own/);
    expect(nameProblem(' Ana ')).toBeNull();
  });

  it('a saved default or blank name loads as none, so the player is asked', () => {
    const storage = (v: string | null) => ({ getItem: () => v });
    expect(loadName(storage(null))).toBe('');
    expect(loadName(storage('Skier'))).toBe('');
    expect(loadName(storage(' Ana '))).toBe('Ana');
  });
});

describe('party', () => {
  it('follows the party on this site, keeping the transport for tests', () => {
    expect(
      partyLink('http://localhost:5173/?resort=a&net=loopback', 'zermatt', 'ABCDEF', 'Furi'),
    ).toBe('http://localhost:5173/?resort=zermatt&join=ABCDEF&start=Furi&net=loopback');
  });

  it('remembers the party for the tab, and ignores junk', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    saveParty(storage, { code: 'ABCDEF', role: 'host', since: 5 });
    expect(loadParty(storage)).toEqual({ code: 'ABCDEF', role: 'host', since: 5 });
    saveParty(storage, null);
    expect(loadParty(storage)).toBeNull();
    store.set('ski-sim.party', '{"code":"no","role":"x"}');
    expect(loadParty(storage)).toBeNull();
  });
});
