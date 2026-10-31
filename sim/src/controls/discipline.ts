// The discipline the player rides as: on two skis, or one snowboard. This is a *setting*,
// not a game Mode — on-snow riding stays Mode `'ski'` (so lifts, fly, glide, sled, crashes
// all keep working unchanged), and the discipline flips the handling, the body/board model,
// the HUD label and the controls (no poles, no skating/double-poling on a board).
//
// Pure module (no Three.js, no DOM): unit-tested. The board's feel is expressed as a
// `SkiHandling` so it drops straight into `stepSki` with no physics fork — a snowboard is
// just a different handling plus a different pose and gated-off locomotion.

import { BASE_HANDLING, type SkiHandling } from './ski-setup';

export type Discipline = 'ski' | 'snowboard';

/** Which foot leads: regular = left foot forward, goofy = right foot forward. */
export type BoardStance = 'regular' | 'goofy';

export interface BoardSetup {
  stance: BoardStance;
  /** Effective edge / overall length (cm). Longer = more stable, less nimble. */
  length: number;
  /** Waist width (mm). Wider floats and slides, narrower rolls edge-to-edge faster. */
  waist: number;
  /** Sidecut radius (m): tight carves vs long drawn-out ones. */
  radius: number;
  /** Flex 1 (noodle) – 10 (plank). Soft = playful/slow, stiff = stable at speed. */
  flex: number;
  /** Binding angles (deg): front foot splay and back foot splay. Duck = negative back. */
  angleFront: number;
  angleBack: number;
}

export const BOARD_RANGES = {
  length: { min: 140, max: 165, step: 1 },
  waist: { min: 240, max: 270, step: 1 },
  radius: { min: 6, max: 11, step: 0.1 },
  flex: { min: 1, max: 10, step: 1 },
  angleFront: { min: 0, max: 30, step: 3 },
  angleBack: { min: -15, max: 15, step: 3 },
} as const;

export const BOARD_PRESETS = {
  'all-mountain': {
    name: 'All-mountain',
    setup: {
      stance: 'regular',
      length: 156,
      waist: 252,
      radius: 8,
      flex: 6,
      angleFront: 15,
      angleBack: -6,
    },
  },
  freestyle: {
    name: 'Freestyle / park',
    setup: {
      stance: 'regular',
      length: 150,
      waist: 254,
      radius: 7.5,
      flex: 4,
      angleFront: 15,
      angleBack: -15,
    },
  },
  freeride: {
    name: 'Freeride / powder',
    setup: {
      stance: 'regular',
      length: 162,
      waist: 262,
      radius: 9,
      flex: 8,
      angleFront: 21,
      angleBack: 0,
    },
  },
  carve: {
    name: 'Carve / alpine',
    setup: {
      stance: 'regular',
      length: 160,
      waist: 244,
      radius: 7,
      flex: 9,
      angleFront: 27,
      angleBack: 15,
    },
  },
} satisfies Record<string, { name: string; setup: BoardSetup }>;

export type BoardPresetId = keyof typeof BOARD_PRESETS;

export const DEFAULT_BOARD_SETUP: BoardSetup = { ...BOARD_PRESETS['all-mountain'].setup };

/** The preset a setup matches (ignoring stance), or null if it's custom. */
export function matchBoardPreset(setup: BoardSetup): BoardPresetId | null {
  for (const id of Object.keys(BOARD_PRESETS) as BoardPresetId[]) {
    const s = BOARD_PRESETS[id].setup;
    if (
      s.length === setup.length &&
      s.waist === setup.waist &&
      s.radius === setup.radius &&
      s.flex === setup.flex &&
      s.angleFront === setup.angleFront &&
      s.angleBack === setup.angleBack
    )
      return id;
  }
  return null;
}

const REF = DEFAULT_BOARD_SETUP;
const flexUnit = (flex: number) => (flex - 1) / 9;

/**
 * A snowboard's feel as a `SkiHandling`. Keyed off the same `BASE_HANDLING` reference as
 * skis, so tuning the base moves both together, with board-specific character baked in:
 *
 * - **Worse on flats.** Higher snow friction than waxed skis: a board drags on the flat and
 *   you can't skate or pole out of it (the controller gates those off). Riders straight-line
 *   flats to keep speed; this makes that necessary.
 * - **Strong edge hold, both edges equal.** `hardGrip` is high — a tuned board holds a hard
 *   carve on heel or toe edge.
 * - **Slower edge-to-edge.** One board rolled across both feet changes edge slower than two
 *   independent skis, so `turnRate` / `edgeRate` are lower; but a flat-based pivot (a skid or
 *   a flat spin) is *easier*, so `pivotRate` is higher.
 * - **Similar top speed** to skis, a touch lower stable speed (a board chatters sooner).
 */
export function boardHandling(s: BoardSetup): SkiHandling {
  const B = BASE_HANDLING;
  const length = s.length / REF.length;
  const waist = s.waist / REF.waist;
  const radius = s.radius / REF.radius;
  const stiff = flexUnit(s.flex) - flexUnit(REF.flex);

  // A board floats on its whole base; width and length both help in powder.
  const float = length * waist;
  const stableSpeed = B.stableSpeed * 0.92 * length ** 1.2 * (1 + 0.8 * stiff);

  return {
    // Dragier than waxed skis on the flat — the core "flats are worse" feel.
    snowFriction: 0.05,
    powderFriction: 0.05 + (B.powderExtraFriction * 0.8) / float ** 1.2,
    powderDrag: (B.powderDrag * 0.85) / float,
    // Edge-to-edge is slower on a board, so velocity swings toward the board a touch slower.
    carveRate: B.carveRate * 0.85 * radius ** -0.5 * length ** -0.3,
    // Boards hold a strong edge once set; stiffer and sharper radius hold harder.
    hardGrip: Math.max(0.7, 1.15 * (1 + 0.25 * stiff)),
    powderGrip: Math.min(1.4, Math.max(0.7, Math.sqrt(float) * 1.05)),
    skidDecel: B.skidDecel * (0.95 + 0.3 * stiff),
    stableSpeed,
    chatter: B.chatter * 1.15,
    stiffness: Math.max(0, stiff),
    maxSpeed: Math.min(B.maxSpeed, stableSpeed + B.maxSpeedMargin),
    // Rolling one board across both feet is slower than crossing two skis over.
    turnRate: 0.82 * length ** -0.7 * radius ** -0.3,
    // But a flat-base skid / flat spin is loose and easy on a board.
    pivotRate: 1.25 * length ** -0.8 * waist ** -0.1,
    edgeRate: 0.8 * waist ** -0.8 * (1 + 0.15 * stiff),
  };
}

export const DEFAULT_BOARD_HANDLING: SkiHandling = boardHandling(DEFAULT_BOARD_SETUP);

// --- catching an edge -------------------------------------------------------------------

/**
 * Thresholds for catching an edge (snowboard only). Deliberately high, so ordinary riding
 * — carves (little sideslip) and controlled skids (weighting the uphill edge) — never trip
 * it; only genuinely committing the *downhill* edge into a fast sideways slide does.
 */
export interface EdgeCatch {
  /** Minimum speed (m/s). */
  speed: number;
  /** Minimum sideways slip relative to the board (m/s). */
  slip: number;
  /** Minimum edge angle onto the wrong edge (rad). */
  edge: number;
}

export const EDGE_CATCH: EdgeCatch = { speed: 12, slip: 6, edge: 0.2 };

/**
 * Whether a snowboard catches its edge this instant. The signature board fall: skidding fast
 * with the board across the slide while weighted onto the **leading (downhill) edge** — the
 * edge on the side the board is sliding toward — instead of the trailing (uphill) edge a
 * controlled skid rides. That edge digs and throws the rider.
 *
 * `sideslip` > 0 = sliding toward the board's right; `balanceEdge` > 0 = leaning onto the
 * left edge. The leading edge digs when those signs disagree (sliding right on the right edge,
 * or sliding left on the left edge).
 */
export function catchesEdge(
  speed: number,
  sideslip: number,
  balanceEdge: number,
  p: EdgeCatch = EDGE_CATCH,
): boolean {
  if (speed < p.speed || Math.abs(sideslip) < p.slip || Math.abs(balanceEdge) < p.edge)
    return false;
  return Math.sign(sideslip) !== Math.sign(balanceEdge);
}

// --- riding switch ----------------------------------------------------------------------

/** Below this speed (m/s) shuffling tail-first isn't really "switch" — no penalty. */
export const SWITCH_MIN_SPEED = 3;

/**
 * Whether the board is travelling tail-first — riding switch (fakie). The nose points along
 * the board heading `boardYaw` (Look.yaw convention: 0 points −z, i.e. north, growing
 * clockwise); the rider travels along `(velX, velZ)` in the sim's world axes (x = east,
 * z = −north). Switch when the travel direction opposes the nose (their dot is negative),
 * above a walking shuffle. Landing a 180, or being pushed backwards, puts you here.
 */
export function ridingSwitch(
  boardYaw: number,
  velX: number,
  velZ: number,
  minSpeed = SWITCH_MIN_SPEED,
): boolean {
  if (Math.hypot(velX, velZ) < minSpeed) return false;
  // Nose = FORWARD (0,0,-1) rotated about up by boardYaw → (−sin, −cos).
  return velX * -Math.sin(boardYaw) + velZ * -Math.cos(boardYaw) < 0;
}

/** How much riding switch costs: a small, grounded stability lever (see `switchHandling`). */
export const SWITCH_PENALTY = {
  /** Chatters ~20% sooner. */
  stableSpeed: 0.8,
  /** Less edge hold off the back foot. */
  hardGrip: 0.8,
  /** Washes out faster once past the stable speed. */
  chatter: 1.4,
  /** A touch lazier onto a new edge. */
  carveRate: 0.85,
} as const;

/**
 * The same board, ridden switch: less stable and less grippy. The nose, sidecut and binding
 * splay all face the wrong way fakie, so a board holds a worse edge and chatters sooner —
 * modelled as a small penalty on the handling, not a different physics path.
 */
export function switchHandling(h: SkiHandling): SkiHandling {
  return {
    ...h,
    stableSpeed: h.stableSpeed * SWITCH_PENALTY.stableSpeed,
    hardGrip: h.hardGrip * SWITCH_PENALTY.hardGrip,
    chatter: h.chatter * SWITCH_PENALTY.chatter,
    carveRate: h.carveRate * SWITCH_PENALTY.carveRate,
  };
}

// --- persistence (mirrors ski-setup.ts) -------------------------------------------------

export const DISCIPLINE_KEY = 'ski-sim.discipline';
export const BOARD_SETUP_KEY = 'ski-sim.board-setup';

export function loadDiscipline(storage: Pick<Storage, 'getItem'>): Discipline {
  return storage.getItem(DISCIPLINE_KEY) === 'snowboard' ? 'snowboard' : 'ski';
}

export function saveDiscipline(storage: Pick<Storage, 'setItem'>, discipline: Discipline): void {
  storage.setItem(DISCIPLINE_KEY, discipline);
}

const clamp = (v: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, v));

export function parseBoardSetup(raw: unknown): BoardSetup {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BOARD_SETUP };
  const r = raw as Record<string, unknown>;
  const num = (key: keyof typeof BOARD_RANGES, fallback: number) =>
    typeof r[key] === 'number' && Number.isFinite(r[key])
      ? clamp(r[key] as number, BOARD_RANGES[key])
      : fallback;
  return {
    stance: r.stance === 'goofy' ? 'goofy' : 'regular',
    length: num('length', DEFAULT_BOARD_SETUP.length),
    waist: num('waist', DEFAULT_BOARD_SETUP.waist),
    radius: num('radius', DEFAULT_BOARD_SETUP.radius),
    flex: num('flex', DEFAULT_BOARD_SETUP.flex),
    angleFront: num('angleFront', DEFAULT_BOARD_SETUP.angleFront),
    angleBack: num('angleBack', DEFAULT_BOARD_SETUP.angleBack),
  };
}

export function loadBoardSetup(storage: Pick<Storage, 'getItem'>): BoardSetup {
  try {
    const raw = storage.getItem(BOARD_SETUP_KEY);
    return raw ? parseBoardSetup(JSON.parse(raw)) : { ...DEFAULT_BOARD_SETUP };
  } catch {
    return { ...DEFAULT_BOARD_SETUP };
  }
}

export function saveBoardSetup(storage: Pick<Storage, 'setItem'>, setup: BoardSetup): void {
  storage.setItem(BOARD_SETUP_KEY, JSON.stringify(setup));
}
