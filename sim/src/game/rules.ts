/**
 * Game rules: what the game lets you do beyond skiing and riding lifts (Options → Rules).
 * Switch them all off for a "realistic" game. In multiplayer the host's rules apply to the
 * whole party; alone, your own (kept in localStorage).
 */
// A type, not an interface: it travels as JSON in a control message (`net/session.ts`).
export type GameRules = {
  /** Map teleports, J to the guide marker, "Go to" a player or a start point in game. */
  teleport: boolean;
  /** B: the snowmobile. */
  snowmobile: boolean;
  /** P: the paraglider. */
  paraglider: boolean;
  /** On a lift: S skips to the end, W fast-forwards. */
  liftSkip: boolean;
  /** U / Y: the plane and helicopter at the airfields (anywhere, if teleporting's on too). */
  aircraft: boolean;
};

export type Rule = keyof GameRules;

export const EVERYTHING_ON: Readonly<GameRules> = {
  teleport: true,
  snowmobile: true,
  paraglider: true,
  liftSkip: true,
  aircraft: true,
};

/** Ski it like the real thing: everything off. */
export const REALISTIC: Readonly<GameRules> = {
  teleport: false,
  snowmobile: false,
  paraglider: false,
  liftSkip: false,
  aircraft: false,
};

/** The Rules tab's rows, in order, and what a refused action says. */
export const RULES: readonly { name: Rule; label: string; detail: string; off: string }[] = [
  {
    name: 'teleport',
    label: 'Teleporting',
    detail: 'Map teleports, J to the guide marker, going to a player or a start point',
    off: 'Teleporting is off',
  },
  {
    name: 'snowmobile',
    label: 'Snowmobile',
    detail: 'B gets on one anywhere',
    off: 'The snowmobile is off',
  },
  {
    name: 'paraglider',
    label: 'Paraglider',
    detail: 'P deploys one anywhere',
    off: 'The paraglider is off',
  },
  {
    name: 'liftSkip',
    label: 'Skipping lifts',
    detail: 'On a lift, S skips to the end and W fast-forwards',
    off: 'Skipping lifts is off',
  },
  {
    name: 'aircraft',
    label: 'Aircraft',
    detail: 'U flies a plane, Y a helicopter from the airfields (anywhere, with teleporting)',
    off: 'Aircraft are off',
  },
];

/** What a refused action says: in a game it's the game's rule, alone it's your setting. */
export function ruleOffMessage(rule: Rule, inGame: boolean): string {
  const off = RULES.find((r) => r.name === rule)!.off;
  return inGame ? `${off} in this game` : `${off} · Options → Rules`;
}

/** Every rule a boolean, defaulting to on (so new rules don't take things away). */
export function sanitizeRules(raw: unknown): GameRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...EVERYTHING_ON };
  for (const { name } of RULES) if (typeof r[name] === 'boolean') out[name] = r[name];
  return out;
}

export function sameRules(a: GameRules, b: GameRules): boolean {
  return RULES.every(({ name }) => a[name] === b[name]);
}

/** Which preset the rules match, if any. */
export function rulesPreset(rules: GameRules): 'realistic' | 'everything' | null {
  if (sameRules(rules, REALISTIC)) return 'realistic';
  if (sameRules(rules, EVERYTHING_ON)) return 'everything';
  return null;
}

const KEY = 'ski-sim.rules';

/** Your own rules (for playing alone or hosting). */
export function loadRules(storage: Pick<Storage, 'getItem'>): GameRules {
  try {
    return sanitizeRules(JSON.parse(storage.getItem(KEY) ?? 'null'));
  } catch {
    return { ...EVERYTHING_ON };
  }
}

export function saveRules(storage: Pick<Storage, 'setItem'>, rules: GameRules): void {
  storage.setItem(KEY, JSON.stringify(rules));
}

/** The rules in force right now (the host's in someone else's game); everything checks these. */
export const gameRules: GameRules = { ...EVERYTHING_ON };
