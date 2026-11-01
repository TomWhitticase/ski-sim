/**
 * Context hints: one line, once, the first time a feature is relevant ("Press 2 for peak
 * names" when a summit first comes into view), never again. Pure: main.ts says which
 * hints are relevant each moment; the scheduler picks at most one to show, spacing them
 * out so they never pile up, and remembers what's been seen (localStorage).
 */

export interface HintDef {
  id: string;
  /** The registry entry it's about (its key is shown, a tap runs it); none for the palette. */
  entry?: string;
  /** Keys to show instead of the entry's (the palette's Ctrl/⌘ + K). */
  keys?: 'palette';
  /** Desktop: after "Press <key> ": "for peak names". */
  desktop: string;
  /** Touch, where there are no keys: "Peak names ahead". */
  touch: string;
  /** Not on touch (keyboard-only, like the palette). */
  desktopOnly?: boolean;
}

/** Most useful first: when several are relevant at once, the first wins. */
export const HINTS: readonly HintDef[] = [
  {
    id: 'quick',
    entry: 'quick-settings',
    desktop: 'for Quick settings: labels, piste colours, view and sound',
    touch: 'Quick settings: labels, piste colours, view and sound',
  },
  {
    id: 'lift',
    entry: 'lift',
    desktop: 'for lift names',
    touch: 'Show the lift names?',
  },
  {
    id: 'pistes',
    entry: 'pistes',
    desktop: 'for piste colours on the snow',
    touch: 'Show the runs in their colours?',
  },
  {
    id: 'peak',
    entry: 'peak',
    desktop: 'for peak names',
    touch: 'Name the peaks in view?',
  },
  {
    id: 'restaurant',
    entry: 'restaurant',
    desktop: 'for restaurant names',
    touch: 'Show the restaurant names?',
  },
  {
    id: 'map',
    entry: 'map',
    desktop: 'for the map: find a run, drop a marker',
    touch: 'The map: find a run, drop a marker',
  },
  {
    id: 'palette',
    keys: 'palette',
    desktop: 'to search every setting and action',
    touch: '',
    desktopOnly: true,
  },
];

export interface HintTiming {
  /** Nothing in the first seconds of play (s). */
  settle: number;
  /** At least this long between two hints (s). */
  gap: number;
  /** How long one stays on screen (s). */
  show: number;
}

export const HINT_TIMING: HintTiming = { settle: 6, gap: 40, show: 7 };

const KEY = 'ski-sim.hints-seen';

export function loadSeen(storage: Pick<Storage, 'getItem'>): Set<string> {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveSeen(storage: Pick<Storage, 'setItem'>, seen: Set<string>): void {
  storage.setItem(KEY, JSON.stringify([...seen]));
}

/**
 * Which hint (if any) to show now. `relevant`: the hints whose moment it is (main.ts
 * checks: a summit in view with peak names off...); `playing`: seconds of play so far;
 * `lastShown`: when the previous hint went up (seconds of play), or null.
 */
export function nextHint(
  relevant: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  playing: number,
  lastShown: number | null,
  touch: boolean,
  timing: HintTiming = HINT_TIMING,
  hints: readonly HintDef[] = HINTS,
): HintDef | null {
  if (playing < timing.settle) return null;
  if (lastShown !== null && playing - lastShown < timing.gap) return null;
  return (
    hints.find((h) => relevant.has(h.id) && !seen.has(h.id) && !(touch && h.desktopOnly)) ?? null
  );
}

/**
 * The hints' running state: what's been seen, when the last went up. `tick` is called
 * every so often with what's relevant; it returns a hint to show (already marked seen and
 * saved), or null.
 */
export class HintScheduler {
  private lastShown: number | null = null;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    readonly seen: Set<string> = loadSeen(storage),
    private readonly timing: HintTiming = HINT_TIMING,
  ) {}

  tick(relevant: ReadonlySet<string>, playing: number, touch: boolean): HintDef | null {
    const hint = nextHint(relevant, this.seen, playing, this.lastShown, touch, this.timing);
    if (!hint) return null;
    this.markSeen(hint.id);
    this.lastShown = playing;
    return hint;
  }

  /** Seen without being shown (you used the feature first: no need to tell you). */
  markSeen(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    saveSeen(this.storage, this.seen);
  }

  /** Forget them all (Options: "Show tips again"). */
  reset(): void {
    this.seen.clear();
    this.lastShown = null;
    saveSeen(this.storage, this.seen);
  }
}
