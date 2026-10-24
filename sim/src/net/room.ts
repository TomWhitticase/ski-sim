// Room codes, player names and the shared-clock maths for a multiplayer session.

import { type GameRules, sanitizeRules } from '../game/rules';

/** No 0/O or 1/I, so a code read out loud or off a screen can't be mistyped. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const MAX_PLAYERS = 16;
export const NAME_KEY = 'ski-sim.player-name';
const MAX_NAME = 20;

export function makeRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return code;
}

/** A typed or pasted code (any case, spaces or dashes), or null if it can't be one. */
export function parseRoomCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/** Signalling room for a code (namespaced so other apps on the same relays never collide). */
export function roomId(code: string): string {
  return `ski-sim/room/${code}`;
}

/** What an unnamed player is called on others' screens; nobody may choose it. */
export const DEFAULT_NAME = 'Skier';

/** Printable, trimmed, at most MAX_NAME characters ('' if nothing's left). */
export function cleanName(name: string): string {
  const printable = [...name].filter((c) => c >= ' ').join('');
  return printable.trim().slice(0, MAX_NAME);
}

/** Why a name can't be used to play (null: it can). Everyone must pick their own. */
export function nameProblem(name: string): string | null {
  const clean = cleanName(name);
  if (!clean) return 'Enter your name to play together';
  if (clean.toLowerCase() === DEFAULT_NAME.toLowerCase()) return 'Choose a name of your own';
  return null;
}

/** Your saved name ('' if you haven't chosen one, or it was the old default). */
export function loadName(storage: Pick<Storage, 'getItem'>): string {
  const name = cleanName(storage.getItem(NAME_KEY) ?? '');
  return nameProblem(name) ? '' : name;
}

/** The public site, for invites from a page friends can't open (a local dev server). */
export const PUBLIC_SITE = 'https://tomwhitticase.github.io/ski-sim/';

/** Only reachable from this machine or its LAN: an invite must point elsewhere. */
function isLocal(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$)/.test(hostname)
  );
}

/**
 * Invite link: this page with `?resort=` and `?join=` (and nothing else from the URL),
 * or the public site when hosting from a local server (the code works on either).
 */
export function inviteLink(href: string, resort: string, code: string): string {
  const here = new URL(href);
  const url = isLocal(here.hostname) ? new URL(PUBLIC_SITE) : here;
  url.search = `?resort=${encodeURIComponent(resort)}&join=${code}`;
  url.hash = '';
  return url.toString();
}

/**
 * This page at another resort, joining `code` (and starting at `start`): for following
 * the party, so it stays on this site (an invite goes to the public one).
 */
export function partyLink(href: string, resort: string, code: string, start?: string | null) {
  const url = new URL(href);
  url.search = `?resort=${encodeURIComponent(resort)}&join=${code}`;
  if (start) url.searchParams.set('start', start);
  for (const keep of ['net']) {
    const v = new URL(href).searchParams.get(keep);
    if (v) url.searchParams.set(keep, v);
  }
  url.hash = '';
  return url.toString();
}

/** The party you're in, kept for this tab across reloads and resort changes. */
export interface SavedParty {
  code: string;
  role: 'host' | 'guest';
  /** When you started hosting it (epoch ms), so a returning host keeps the party. */
  since?: number;
  /** The party's rules (the host's), so they hold across a reload or a hand-over. */
  rules?: GameRules;
}

const PARTY_KEY = 'ski-sim.party';

export function loadParty(storage: Pick<Storage, 'getItem'>): SavedParty | null {
  try {
    const p = JSON.parse(storage.getItem(PARTY_KEY) ?? 'null') as SavedParty | null;
    if (!p || !parseRoomCode(p.code) || (p.role !== 'host' && p.role !== 'guest')) return null;
    return p.rules ? { ...p, rules: sanitizeRules(p.rules) } : p;
  } catch {
    return null;
  }
}

export function saveParty(storage: Pick<Storage, 'setItem' | 'removeItem'>, p: SavedParty | null) {
  if (p) storage.setItem(PARTY_KEY, JSON.stringify(p));
  else storage.removeItem(PARTY_KEY);
}

/** The host's shared clocks: lift clock (s) and time of day (seconds, rate). */
export type SharedClock = {
  lift: number;
  seconds: number;
  rate: number;
};

/** The host's clocks `latency` seconds after they were read (one-way trip). */
export function advanceShared(s: SharedClock, latency: number): SharedClock {
  return { lift: s.lift + latency, seconds: s.seconds + s.rate * latency, rate: s.rate };
}

/** Lift clock errors bigger than this jump straight to the host's (s). */
const LIFT_SNAP = 2;
/** Smaller errors are worked off at this rate (1/s), so chairs never visibly jump. */
const LIFT_SLEW = 0.8;

/** How much to move the local lift clock this frame toward the host's (s). */
export function liftCorrection(error: number, dt: number): number {
  if (Math.abs(error) > LIFT_SNAP) return error;
  return error * Math.min(1, dt * LIFT_SLEW);
}
