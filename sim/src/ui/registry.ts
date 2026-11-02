import type { GameRules, Rule } from '../game/rules';
import type { IconName } from './icons';

/**
 * The toggle and settings registry: one entry per thing the player can switch or do from
 * a key, a button or a menu (peak names, the HUD, the drone, the map, Options tabs...).
 * Every surface reads it: the key handler (`main.ts` act()), the Quick settings panel,
 * the command palette, the Display tab, the touch tools and the context hints. Adding a
 * toggle is one entry (`ui/toggles.ts`); it then shows up everywhere.
 *
 * This module is pure (no DOM): the entries carry their own behaviour as closures.
 */

/** Where an entry sits in the Quick settings panel and the palette, in this order. */
export const GROUPS = [
  { id: 'labels', label: 'Labels' },
  { id: 'map', label: 'On the snow' },
  { id: 'view', label: 'View & sound' },
  { id: 'interface', label: 'Interface' },
  { id: 'go', label: 'Go' },
  { id: 'presets', label: 'Presets' },
  { id: 'menus', label: 'Menus' },
] as const;

export type GroupId = (typeof GROUPS)[number]['id'];

/** A key that runs an entry: `code` (KeyboardEvent.code), plus `glyph`, what we show. */
export interface KeyBinding {
  code: string;
  /** Other codes that do the same (the numpad's digits). */
  also?: readonly string[];
  /** Needs Shift held (Shift+M); without it, Shift must not be held for this binding. */
  shift?: boolean;
  glyph: string;
}

export interface Entry {
  /** Stable: used in storage, the DOM (`data-id`) and code. */
  id: string;
  /** "Peak names". */
  label: string;
  /** A shorter label where room is tight (the HUD strip, touch tools). */
  short?: string;
  /** One line: what it does (the panel's subtitle, the palette). */
  hint: string;
  group: GroupId;
  /** A toggle has an on/off state (`get`); an action just does something. */
  kind: 'toggle' | 'action';
  key?: KeyBinding;
  /** Icon (`ui/icons.ts`). */
  icon: IconName;
  /** Other words the palette finds it by ("labels", "tags", "mute"...). */
  synonyms?: readonly string[];
  /** Listed in Quick settings (toggles, and a few actions). */
  panel?: boolean;
  /** One of the world switches in Options → Display. */
  display?: boolean;
  /**
   * A touch tool button: its `data-touch` id, its label there, and when it's left off
   * the row even though the entry could run (none by default).
   */
  tool?: { id: string; label: string; hidden?: () => boolean };
  /** Its key works with an Options dialog open (it opens or switches the tab). */
  overDialogs?: boolean;
  /** Reachable on a touchscreen at all (no keys there): false hides it from touch. */
  touch?: boolean;
  /** Off when this game rule is (unless it's on right now: you can always get off). */
  rule?: Rule;
  /** Toggles: on? Actions that are modes (drone, paraglider): in it now? */
  get?(): boolean;
  /** Flip the toggle, or do the action. */
  run(): void;
  /** Toggles: set to a given state (presets); defaults to run() when it differs. */
  set?(on: boolean): void;
  /** Why it can't be used right now (wrong mode, no world), or null when it can. */
  unavailable?(): string | null;
}

export interface Status {
  enabled: boolean;
  /** Why not, when not enabled. */
  reason: string | null;
}

/** What the registry needs to know about the game: the rules and how to word them. */
export interface RuleContext {
  rules: Readonly<GameRules>;
  message(rule: Rule): string;
}

/** Can the entry be used now: its context first, then the game's rules. */
export function statusOf(entry: Entry, ctx: RuleContext): Status {
  const why = entry.unavailable?.() ?? null;
  if (why) return { enabled: false, reason: why };
  if (entry.rule && !ctx.rules[entry.rule] && !entry.get?.()) {
    return { enabled: false, reason: ctx.message(entry.rule) };
  }
  return { enabled: true, reason: null };
}

/**
 * Does this key press (code, Shift held) match the binding? A Shift binding needs Shift;
 * a plain one doesn't mind it (Shift + 2 is still peak names, as it always was), but
 * `Registry.forKey` tries the Shift bindings first.
 */
export function matchesKey(key: KeyBinding, code: string, shift: boolean): boolean {
  if (key.code !== code && !key.also?.includes(code)) return false;
  return !key.shift || shift;
}

/** "Shift + M", "F3", "2": the binding as it's shown. */
export function keyLabel(key: KeyBinding): string {
  return key.shift ? `Shift + ${key.glyph}` : key.glyph;
}

/** Lower case, no accents: what search compares. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * How well an entry matches a query (0: not at all). Every word must match something:
 * the start of the label scores highest, then a word in it, its synonyms, the hint,
 * the group, the key.
 */
export function searchScore(entry: Entry, query: string): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const label = fold(entry.label);
  const labelWords = label.split(/[\s&/-]+/);
  const synonyms = (entry.synonyms ?? []).map(fold);
  const hint = fold(entry.hint);
  const group = fold(GROUPS.find((g) => g.id === entry.group)?.label ?? '');
  const key = entry.key ? fold(entry.key.glyph) : '';
  let score = 0;
  for (const w of words) {
    let s = 0;
    if (label.startsWith(w)) s = 100;
    else if (labelWords.some((lw) => lw.startsWith(w))) s = 80;
    else if (synonyms.some((syn) => syn.startsWith(w))) s = 60;
    else if (label.includes(w) || synonyms.some((syn) => syn.includes(w))) s = 40;
    else if (hint.includes(w)) s = 20;
    else if (group.startsWith(w)) s = 15;
    else if (key === w) s = 10;
    if (s === 0) return 0;
    score += s;
  }
  return score;
}

/** Entries matching the query, best first (ties keep the registry's order). */
export function search(entries: readonly Entry[], query: string): Entry[] {
  return entries
    .map((entry, i) => ({ entry, i, score: searchScore(entry, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.entry);
}

type Listener = (id: string | null, announce: boolean) => void;

/**
 * The live registry: the entries, key lookup, and change notification. Whoever changes
 * a toggle's state calls `changed(id, announce)` (announce: the player just did it, so
 * say so); every surface listening re-reads `get()`.
 */
export class Registry {
  private readonly byId = new Map<string, Entry>();
  private readonly listeners: Listener[] = [];

  constructor(
    readonly entries: readonly Entry[],
    private readonly ctx: RuleContext,
  ) {
    for (const e of entries) {
      if (this.byId.has(e.id)) throw new Error(`Duplicate registry id ${e.id}`);
      this.byId.set(e.id, e);
    }
  }

  get(id: string): Entry | undefined {
    return this.byId.get(id);
  }

  /**
   * The entry a key press runs, if any: Shift bindings first (Shift+M before M), and of
   * those matching, the first that's usable now (Shift+M with the map open closes it).
   */
  forKey(code: string, shift: boolean): Entry | undefined {
    const matches = [
      ...this.entries.filter((e) => e.key?.shift && matchesKey(e.key, code, shift)),
      ...this.entries.filter((e) => e.key && !e.key.shift && matchesKey(e.key, code, shift)),
    ];
    return matches.find((e) => !e.unavailable?.()) ?? matches[0];
  }

  status(entry: Entry): Status {
    return statusOf(entry, this.ctx);
  }

  /** On (toggles) or active (mode actions); false for plain actions. */
  isOn(entry: Entry): boolean {
    return entry.get?.() ?? false;
  }

  /** Set a toggle to a state (a preset): its own `set`, else run() if it differs. */
  set(entry: Entry, on: boolean): void {
    if (entry.kind !== 'toggle') return;
    if (entry.set) entry.set(on);
    else if (this.isOn(entry) !== on) entry.run();
  }

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  /** Something's state changed (null: anything might have, e.g. the mode or rules). */
  changed(id: string | null, announce = false): void {
    for (const fn of this.listeners) fn(id, announce);
  }
}
