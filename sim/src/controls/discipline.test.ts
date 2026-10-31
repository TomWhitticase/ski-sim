import { describe, expect, it } from 'vitest';

import { DEFAULT_HANDLING } from './ski-setup';
import {
  BOARD_PRESETS,
  BOARD_RANGES,
  boardHandling,
  catchesEdge,
  DEFAULT_BOARD_SETUP,
  DISCIPLINE_KEY,
  EDGE_CATCH,
  loadBoardSetup,
  loadDiscipline,
  matchBoardPreset,
  parseBoardSetup,
  ridingSwitch,
  saveBoardSetup,
  saveDiscipline,
  switchHandling,
} from './discipline';

function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('discipline persistence', () => {
  it('defaults to ski and round-trips snowboard', () => {
    expect(loadDiscipline(store())).toBe('ski');
    expect(loadDiscipline(store({ [DISCIPLINE_KEY]: 'nonsense' }))).toBe('ski');
    const s = store();
    saveDiscipline(s, 'snowboard');
    expect(loadDiscipline(s)).toBe('snowboard');
  });

  it('round-trips a board setup and falls back on junk', () => {
    const s = store();
    const setup = { ...DEFAULT_BOARD_SETUP, stance: 'goofy' as const, flex: 9 };
    saveBoardSetup(s, setup);
    expect(loadBoardSetup(s)).toEqual(setup);
    expect(loadBoardSetup(store({ 'ski-sim.board-setup': '{bad json' }))).toEqual(
      DEFAULT_BOARD_SETUP,
    );
  });

  it('clamps out-of-range numbers when parsing', () => {
    const parsed = parseBoardSetup({ stance: 'regular', length: 9999, flex: -5 });
    expect(parsed.length).toBe(BOARD_RANGES.length.max);
    expect(parsed.flex).toBe(BOARD_RANGES.flex.min);
  });
});

describe('board presets', () => {
  it('matches a known preset and rejects a tweak', () => {
    for (const id of Object.keys(BOARD_PRESETS) as (keyof typeof BOARD_PRESETS)[]) {
      expect(matchBoardPreset(BOARD_PRESETS[id].setup)).toBe(id);
    }
    expect(matchBoardPreset({ ...BOARD_PRESETS['all-mountain'].setup, flex: 1 })).toBeNull();
  });
});

describe('board handling vs skis', () => {
  const board = boardHandling(DEFAULT_BOARD_SETUP);

  it('is draggier on flats than waxed skis (the core "flats are worse" feel)', () => {
    expect(board.snowFriction).toBeGreaterThan(DEFAULT_HANDLING.snowFriction);
  });

  it('turns edge-to-edge slower but pivots (skids) more easily', () => {
    expect(board.turnRate).toBeLessThan(DEFAULT_HANDLING.turnRate);
    expect(board.pivotRate).toBeGreaterThan(DEFAULT_HANDLING.pivotRate);
  });

  it('holds a strong edge and keeps a similar, capped top speed', () => {
    expect(board.hardGrip).toBeGreaterThan(1);
    expect(board.maxSpeed).toBeGreaterThan(20);
    expect(board.maxSpeed).toBeLessThanOrEqual(DEFAULT_HANDLING.maxSpeed + 1e-9);
  });

  it('stays playable at both ends of the flex range', () => {
    for (const flex of [BOARD_RANGES.flex.min, BOARD_RANGES.flex.max]) {
      const h = boardHandling({ ...DEFAULT_BOARD_SETUP, flex });
      expect(h.maxSpeed).toBeGreaterThan(15);
      expect(h.carveRate).toBeGreaterThan(0.5);
      expect(h.turnRate).toBeGreaterThan(0.2);
    }
  });
});

describe('riding switch', () => {
  it('detects travelling tail-first, ignores a slow shuffle', () => {
    // Board points north (yaw 0 → nose at -z). Travelling north (−z) is nose-first.
    expect(ridingSwitch(0, 0, -10)).toBe(false);
    // Travelling south (+z) is tail-first → switch.
    expect(ridingSwitch(0, 0, 10)).toBe(true);
    // Too slow to count either way.
    expect(ridingSwitch(0, 0, 2)).toBe(false);
  });

  it('penalises stability but keeps the board playable', () => {
    const board = boardHandling(DEFAULT_BOARD_SETUP);
    const sw = switchHandling(board);
    expect(sw.stableSpeed).toBeLessThan(board.stableSpeed);
    expect(sw.hardGrip).toBeLessThan(board.hardGrip);
    expect(sw.chatter).toBeGreaterThan(board.chatter);
    expect(sw.maxSpeed).toBe(board.maxSpeed); // cap unchanged
    expect(sw.carveRate).toBeGreaterThan(0.5);
  });
});

describe('catching an edge', () => {
  const fast = EDGE_CATCH.speed + 3;
  const slip = EDGE_CATCH.slip + 2;
  const edge = EDGE_CATCH.edge + 0.1;

  it('catches only the leading (downhill) edge of a fast sideways slide', () => {
    // Sliding right (+slip) on the right edge (lean right, -edge): leading edge digs → catch.
    expect(catchesEdge(fast, slip, -edge)).toBe(true);
    expect(catchesEdge(fast, -slip, edge)).toBe(true);
    // A controlled skid weights the uphill/trailing edge (same sign): safe.
    expect(catchesEdge(fast, slip, edge)).toBe(false);
    expect(catchesEdge(fast, -slip, -edge)).toBe(false);
  });

  it('leaves ordinary riding alone (slow, carving, or barely edged)', () => {
    // Too slow.
    expect(catchesEdge(EDGE_CATCH.speed - 1, slip, -edge)).toBe(false);
    // Carving: little sideslip.
    expect(catchesEdge(fast, EDGE_CATCH.slip - 1, -edge)).toBe(false);
    // Flat base: not committed to an edge.
    expect(catchesEdge(fast, slip, EDGE_CATCH.edge - 0.05)).toBe(false);
  });
});
