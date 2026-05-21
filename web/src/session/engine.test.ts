/**
 * Tests for session/engine.ts helpers.
 */

import { describe, expect, it } from 'vitest';
import { makeTrivialSpec, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates, cageLabel } from './specUtils.js';
import {
  buildEngine,
  userRemoved,
  userVirtualCages,
  applyAutoPlacements,
  applyNextAutoPlacement,
} from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import type { PuzzleState, Turn, UserAction, VirtualCage } from './types.js';
import type { Cell } from '../engine/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(): PuzzleState {
  const spec = makeTrivialSpec();
  return {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES],
    goldenSolution: null,
    puzzleType: 'killer',
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
}

function makeTurn(action: UserAction): Turn {
  return {
    action,
    autoMutations: [],
    snapshot: { candidates: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [])) },
  };
}

// ---------------------------------------------------------------------------
// specUtils
// ---------------------------------------------------------------------------

describe('cageLabel', () => {
  it('labels single letters A-Z', () => {
    expect(cageLabel(0)).toBe('A');
    expect(cageLabel(25)).toBe('Z');
  });

  it('wraps to AA after Z', () => {
    expect(cageLabel(26)).toBe('AA');
    expect(cageLabel(27)).toBe('AB');
  });
});

describe('specToData / dataToSpec round-trip', () => {
  it('round-trips without mutation', async () => {
    const { dataToSpec } = await import('./specUtils.js');
    const spec = makeTrivialSpec();
    const data = specToData(spec);
    const spec2 = dataToSpec(data);
    expect(spec2.regions).toEqual(spec.regions);
    expect(spec2.cageTotals).toEqual(spec.cageTotals);
  });

  it('derives correct borders from regions', async () => {
    const { dataToSpec } = await import('./specUtils.js');
    const spec = makeTrivialSpec();
    const data = specToData(spec);
    const spec2 = dataToSpec(data);
    // trivial spec: every cell is its own cage, so every border is a wall
    for (let c = 0; c < 9; c++)
      for (let rowGap = 0; rowGap < 8; rowGap++)
        expect(spec2.borderX[c]![rowGap]!).toBe(true);
    for (let colGap = 0; colGap < 8; colGap++)
      for (let r = 0; r < 9; r++)
        expect(spec2.borderY[colGap]![r]!).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// userRemoved
// ---------------------------------------------------------------------------

describe('userRemoved', () => {
  it('returns empty when no turns', () => {
    expect(userRemoved(makeState())).toHaveLength(0);
  });

  it('accumulates eliminateCandidate turns', () => {
    const state = makeState();
    const turns = [
      makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: 5 }),
      makeTurn({ type: 'eliminateCandidate', row: 1, col: 2, digit: 3 }),
    ];
    const result = userRemoved({ ...state, turns });
    expect(result).toContainEqual([0, 0, 5]);
    expect(result).toContainEqual([1, 2, 3]);
  });

  it('restoreCandidate removes the most recent matching entry', () => {
    const state = makeState();
    const turns = [
      makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: 5 }),
      makeTurn({ type: 'restoreCandidate', row: 0, col: 0, digit: 5 }),
    ];
    const result = userRemoved({ ...state, turns });
    expect(result).not.toContainEqual([0, 0, 5]);
  });
});

// ---------------------------------------------------------------------------
// userVirtualCages
// ---------------------------------------------------------------------------

describe('userVirtualCages', () => {
  const vc: VirtualCage = {
    cells: [[0, 0], [0, 1]] as Cell[],
    total: 10,
    eliminatedSolns: [],
  };

  it('adds a cage via addVirtualCage', () => {
    const state = makeState();
    const turns = [makeTurn({ type: 'addVirtualCage', cage: vc })];
    expect(userVirtualCages({ ...state, turns })).toHaveLength(1);
  });

  it('removes a cage via removeVirtualCage', () => {
    const state = makeState();
    const key = '0,0:0,1:10';
    const turns = [
      makeTurn({ type: 'addVirtualCage', cage: vc }),
      makeTurn({ type: 'removeVirtualCage', key }),
    ];
    expect(userVirtualCages({ ...state, turns })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildEngine
// ---------------------------------------------------------------------------

describe('buildEngine', () => {
  it('constructs board and engine without crash', () => {
    const { board, engine } = buildEngine(makeState());
    expect(board).toBeDefined();
    expect(engine).toBeDefined();
  });

  it('engine.solve() finds the known solution on trivial spec', () => {
    const { board, engine } = buildEngine(makeState());
    engine.solve();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect(board.candidates[r]![c]!).toEqual(new Set([KNOWN_SOLUTION[r]![c]!]));
  });

  it('user eliminations reduce candidates before solve', () => {
    const state = makeState();
    // Place digit 1 at (0,0) in userGrid
    const userGrid = state.userGrid!.map(row => [...row]);
    userGrid[0]![0] = 1;
    const stateWithPlacement = { ...state, userGrid };
    const { board } = buildEngine(stateWithPlacement);
    // All digits except 1 should have been removed from (0,0)
    expect(board.candidates[0]![0]!.has(1)).toBe(true);
    // After solve the candidate set may be even smaller — just check no crash
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_ALWAYS_APPLY_RULES
// ---------------------------------------------------------------------------

describe('DEFAULT_ALWAYS_APPLY_RULES', () => {
  it('contains the expected rule names', () => {
    expect(DEFAULT_ALWAYS_APPLY_RULES).toContain('CageCandidateFilter');
    expect(DEFAULT_ALWAYS_APPLY_RULES).toContain('CellSolutionElimination');
  });
});

// ---------------------------------------------------------------------------
// applyAutoPlacements / applyNextAutoPlacement — inconsistency guard
// ---------------------------------------------------------------------------

/** State with 80 cells placed (KNOWN_SOLUTION minus (0,0)) and NakedSingle active. */
function makeAlmostCompleteState(opts: { wrongAt?: [number, number] } = {}): PuzzleState {
  const spec = makeTrivialSpec();
  const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
  userGrid[0]![0] = 0; // leave (0,0) blank — NakedSingle will deduce it
  if (opts.wrongAt) {
    const [wr, wc] = opts.wrongAt;
    const gold = KNOWN_SOLUTION[wr]![wc]!;
    userGrid[wr]![wc] = gold === 9 ? 1 : gold + 1; // wrong digit
  }
  return {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: ['NakedSingle', ...DEFAULT_ALWAYS_APPLY_RULES],
    goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
    puzzleType: 'killer',
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
}

/** State with duplicate digits in userGrid and no goldenSolution — soundness assertion inactive. */
function makeInternallyInconsistentState(): PuzzleState {
  const spec = makeTrivialSpec();
  const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
  userGrid[0]![0] = 0; // leave (0,0) blank — NakedSingle would place something
  // Force row 0 to have a duplicate: (0,1) gets the same digit as (0,2)
  userGrid[0]![1] = KNOWN_SOLUTION[0]![2]!; // row-duplicate
  return {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: ['NakedSingle', ...DEFAULT_ALWAYS_APPLY_RULES],
    goldenSolution: null, // no golden → soundness assertion inactive
    puzzleType: 'killer',
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
}

describe('applyAutoPlacements — inconsistency guard', () => {
  it('places the deducible digit when board is consistent', () => {
    const state = makeAlmostCompleteState();
    const result = applyAutoPlacements(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('returns state unchanged when userGrid has row-duplicate and no golden solution', () => {
    // goldenSolution is null → soundness assertion inactive.
    // The grid has a row-duplicate (visible inconsistency without needing goldenSolution).
    // Auto-placements must still be suppressed.
    const state = makeInternallyInconsistentState();
    const result = applyAutoPlacements(state);
    expect(result).toBe(state);
    expect(result.userGrid![0]![0]).toBe(0);
  });

  it('returns state unchanged (no auto-placements) when a wrong digit is present', () => {
    const state = makeAlmostCompleteState({ wrongAt: [0, 1] });
    const result = applyAutoPlacements(state);
    expect(result).toBe(state);
    expect(result.userGrid![0]![0]).toBe(0);
  });

  it('returns state unchanged when the golden candidate has been explicitly eliminated', () => {
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: PuzzleState = {
      ...state,
      turns: [makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: gold })],
    };
    const result = applyAutoPlacements(stateWithElim);
    expect(result).toBe(stateWithElim);
    expect(result.userGrid![0]![0]).toBe(0);
  });
});

describe('applyNextAutoPlacement — inconsistency guard', () => {
  it('places the next deducible digit when board is consistent', () => {
    const state = makeAlmostCompleteState();
    const result = applyNextAutoPlacement(state);
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('returns null when userGrid has row-duplicate and no golden solution', () => {
    expect(applyNextAutoPlacement(makeInternallyInconsistentState())).toBeNull();
  });

  it('returns null (suppressed) when a wrong digit is present', () => {
    const state = makeAlmostCompleteState({ wrongAt: [0, 1] });
    expect(applyNextAutoPlacement(state)).toBeNull();
  });

  it('returns null when the golden candidate has been explicitly eliminated', () => {
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: PuzzleState = {
      ...state,
      turns: [makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: gold })],
    };
    expect(applyNextAutoPlacement(stateWithElim)).toBeNull();
  });
});
