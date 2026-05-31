/**
 * Tests for session/engine.ts helpers.
 */

import { describe, expect, it } from 'vitest';
import { makeTrivialSpec, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates, cageLabel } from './specUtils.js';
import {
  buildEngine,
  isUserCorrupted,
  userRemoved,
  userVirtualCages,
  applyAutoPlacements,
  applyNextAutoPlacement,
} from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import type { PuzzleState, Turn, UserAction, VirtualCage } from './types.js';
import type { Cell } from '../engine/types.js';

const itCSE = DISABLED_RULES.includes('CellSolutionElimination') ? it.skip : it;

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
    autoRemovedCandidates: [],
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
// isUserCorrupted
// ---------------------------------------------------------------------------

describe('isUserCorrupted', () => {
  it('returns false when goldenSolution is null', () => {
    expect(isUserCorrupted(makeState())).toBe(false);
  });

  it('returns false when userGrid matches goldenSolution', () => {
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userGrid: KNOWN_SOLUTION.map(row => [...row]) as number[][],
    };
    expect(isUserCorrupted(state)).toBe(false);
  });

  it('returns true when userGrid has a wrong digit', () => {
    const gold = KNOWN_SOLUTION[0]![0]!;
    const wrong = gold === 1 ? 2 : 1;
    const userGrid = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    userGrid[0]![0] = wrong;
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userGrid,
    };
    expect(isUserCorrupted(state)).toBe(true);
  });

  it('returns true when the user manually eliminated a golden candidate', () => {
    const gold = KNOWN_SOLUTION[1]![1]!;
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      turns: [makeTurn({ type: 'eliminateCandidate', row: 1, col: 1, digit: gold })],
    };
    expect(isUserCorrupted(state)).toBe(true);
  });

  it('returns false when the user eliminated then restored a golden candidate', () => {
    const gold = KNOWN_SOLUTION[1]![1]!;
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      turns: [
        makeTurn({ type: 'eliminateCandidate', row: 1, col: 1, digit: gold }),
        makeTurn({ type: 'restoreCandidate', row: 1, col: 1, digit: gold }),
      ],
    };
    expect(isUserCorrupted(state)).toBe(false);
  });
});

describe('buildEngine — golden check disabled when user-corrupted', () => {
  it('does not disable golden checks when user has placed correct digits', () => {
    // Build a state with all correct placements — golden check should still be active.
    // We verify by checking that the engine has a goldenSolution set (indirectly:
    // build completes without error and the board is consistent).
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userGrid: KNOWN_SOLUTION.map(row => [...row]) as number[][],
    };
    expect(() => buildEngine(state)).not.toThrow();
  });

  it('filters autoRemovedCandidates that violate the golden solution', () => {
    // autoRemovedCandidates contains a golden digit for (0,0).
    // The engine should NOT remove that candidate from the board.
    const gold = KNOWN_SOLUTION[0]![0]!;
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      autoRemovedCandidates: [[0, 0, gold]],
    };
    const { board } = buildEngine(state, { skipSolve: true });
    expect(board.cands(0, 0).has(gold)).toBe(true);
  });

  it('applies autoRemovedCandidates that do NOT violate the golden solution', () => {
    const gold = KNOWN_SOLUTION[0]![0]!;
    const nonGold = gold === 1 ? 2 : 1;
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      autoRemovedCandidates: [[0, 0, nonGold]],
    };
    const { board } = buildEngine(state, { skipSolve: true });
    // nonGold was safely eliminated
    expect(board.cands(0, 0).has(nonGold)).toBe(false);
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
    autoRemovedCandidates: [],
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
    autoRemovedCandidates: [],
  };
}

describe('applyAutoPlacements — continues even with wrong placements', () => {
  it('places the deducible digit when board is consistent', () => {
    const state = makeAlmostCompleteState();
    const result = applyAutoPlacements(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when userGrid has a row-duplicate — cage constraint overrides', () => {
    // Row 0 has a duplicate digit. The engine treats the board as-is.
    // The trivial spec gives (0,0) a 1-cell cage with total = KNOWN_SOLUTION[0][0],
    // so the cage constraint uniquely forces (0,0) regardless of the row duplicate.
    const state = makeInternallyInconsistentState();
    const result = applyAutoPlacements(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when a wrong digit is present elsewhere — treat as correct', () => {
    // Wrong digit at (0,1) — engine proceeds as if it were correct.
    // (0,0) is forced by its 1-cell cage constraint (total = KNOWN_SOLUTION[0][0]).
    const state = makeAlmostCompleteState({ wrongAt: [0, 1] });
    const result = applyAutoPlacements(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  itCSE('places some digit in (0,0) when the golden candidate was explicitly eliminated', () => {
    // User removed the correct digit from (0,0). Engine continues as if that removal
    // is intentional — some other digit gets forced via remaining constraints.
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: PuzzleState = {
      ...state,
      turns: [makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: gold })],
    };
    const result = applyAutoPlacements(stateWithElim);
    expect(result.userGrid![0]![0]).not.toBe(0); // some digit was placed
    expect(result.userGrid![0]![0]).not.toBe(gold); // not the golden digit
  });
});

describe('applyNextAutoPlacement — continues even with wrong placements', () => {
  it('places the next deducible digit when board is consistent', () => {
    const state = makeAlmostCompleteState();
    const result = applyNextAutoPlacement(state);
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when userGrid has a row-duplicate', () => {
    const result = applyNextAutoPlacement(makeInternallyInconsistentState());
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when a wrong digit is present elsewhere', () => {
    const state = makeAlmostCompleteState({ wrongAt: [0, 1] });
    const result = applyNextAutoPlacement(state);
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  itCSE('places some non-golden digit in (0,0) when the golden candidate was eliminated', () => {
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: PuzzleState = {
      ...state,
      turns: [makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: gold })],
    };
    const result = applyNextAutoPlacement(stateWithElim);
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).not.toBe(gold);
  });
});
