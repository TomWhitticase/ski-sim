import { describe, expect, it } from 'vitest';

import { DEFAULT_HANDLING } from './ski-setup';
import {
  BOARD_PRESETS,
  BOARD_RANGES,
  boardEdgeAngle,
  boardHandling,
  catchesEdge,
  DEFAULT_BOARD_SETUP,
  DISCIPLINE_KEY,
  EDGE_CATCH,
  EDGE_FLAT,
  engagedEdge,
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

describe('edging — the deck tilts onto the edge the rider weights', () => {
  // `up` is the balance line in the board's slope-aligned frame (x = board right, y = board
  // up). The physics uses `balanceEdge = atan2(-up.x, up.y)` and the torso aligns Y → up, so
  // the rider leans toward the +x side when up.x > 0. The deck must roll onto the SAME side.

  // The side of the board the low (weighted) edge is on, from the signed deck roll: a positive
  // roll lifts +x, so the low edge is at −x; a negative roll rides +x.
  const lowEdgeX = (edge: number) => (edge > 0 ? -1 : 1);
  // The side the torso leans toward (aligning Y → up): the +x side when up.x > 0.
  const leanX = (upX: number) => Math.sign(upX);
  // The OLD, buggy formula the deck used before the fix.
  const buggyEdge = (upX: number, upY: number) => Math.atan2(upX, upY);

  it('matches the physics / body balance-edge formula exactly (single source of truth)', () => {
    for (const upX of [-0.5, -0.2, 0, 0.2, 0.5]) {
      expect(boardEdgeAngle(upX, 1)).toBeCloseTo(Math.atan2(-upX, 1), 12);
    }
  });

  it('rolls the deck onto the SAME side the body leans (reproduces the old inversion)', () => {
    for (const upX of [-0.5, -0.2, 0.2, 0.5]) {
      const edge = boardEdgeAngle(upX, 1);
      // Fixed: low edge is on the side the body leans toward.
      expect(lowEdgeX(edge)).toBe(leanX(upX));
      // The old formula put the low edge on the opposite side — the bug the user saw.
      expect(lowEdgeX(buggyEdge(upX, 1))).toBe(-leanX(upX));
    }
  });

  it('on a traverse weights the uphill edge, in both directions', () => {
    // Traversing with the hill up to the board's LEFT (−x): the vertical balance line tilts
    // uphill, i.e. toward −x in the slope frame, so up.x < 0.
    const upLeftHill = boardEdgeAngle(-0.3, 1);
    expect(lowEdgeX(upLeftHill)).toBe(-1); // weighted edge on the uphill (−x / left) side
    // Hill up to the RIGHT (+x): up.x > 0, weighted edge on the +x / right (uphill) side.
    const upRightHill = boardEdgeAngle(0.3, 1);
    expect(lowEdgeX(upRightHill)).toBe(1);
  });

  it('labels toe vs heel from the edge sign and the stance (regular and goofy)', () => {
    // Toe edge at +x for regular, −x for goofy. Positive roll rides the −x edge.
    expect(engagedEdge(0.3, true)).toBe('heel'); // regular, rides −x = heel
    expect(engagedEdge(-0.3, true)).toBe('toe'); // regular, rides +x = toe
    expect(engagedEdge(0.3, false)).toBe('toe'); // goofy, rides −x = toe
    expect(engagedEdge(-0.3, false)).toBe('heel'); // goofy, rides +x = heel
    // Nearly flat base: not committed to an edge (no flicker between edges across the fall line).
    expect(engagedEdge(EDGE_FLAT / 2, true)).toBe('flat');
    expect(engagedEdge(-EDGE_FLAT / 2, false)).toBe('flat');
  });

  it('regular and goofy weight the same uphill side but name opposite edges', () => {
    // Same balance line (hill to the left, up.x < 0): both ride the −x edge, which is the
    // uphill (left) side for both — but that is heelside regular, toeside goofy.
    const edge = boardEdgeAngle(-0.3, 1);
    expect(lowEdgeX(edge)).toBe(-1);
    expect(engagedEdge(edge, true)).toBe('heel');
    expect(engagedEdge(edge, false)).toBe('toe');
  });

  it('edge angle grows with how far the balance line tips (speed / tighter radius)', () => {
    // A harder, faster carve tips the balance line further off vertical → a bigger edge angle.
    const gentle = Math.abs(boardEdgeAngle(0.1, 1));
    const hard = Math.abs(boardEdgeAngle(0.6, 1));
    expect(hard).toBeGreaterThan(gentle);
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
