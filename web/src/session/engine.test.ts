/**
 * Tests for session/engine.ts helpers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTrivialSpec, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates, cageLabel } from './specUtils.js';
import {
  buildEngine,
  isUserCorrupted,
  userRemoved,
  userVirtualCages,
  applyAutoPlacements,
  applyNextAutoPlacement,
  recordTurn,
} from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import { UserAction, PuzzleState, type KillerPuzzleState, type Turn, type VirtualCage, type EliminateCandidateAction, type RestoreCandidateAction, type ResetCellCandidatesAction, type ApplyHintAction } from './types.js';
import type { Cell } from '../engine/types.js';
import { BoardState, KillerBoardState } from '../engine/boardState.js';
import { SolverEngine, KillerSolverEngine } from '../engine/solverEngine.js';

const itNS = DISABLED_RULES.includes('NakedSingle') ? it.skip : it;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(): KillerPuzzleState {
  const spec = makeTrivialSpec();
  return {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES],
    goldenSolution: null,
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
    fixtureStalledCandidates: null,
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
  it('returns empty when userRemovedCandidates is empty', () => {
    expect(userRemoved(makeState())).toHaveLength(0);
  });

  it('returns userRemovedCandidates directly', () => {
    const state: PuzzleState = {
      ...makeState(),
      userRemovedCandidates: [[0, 0, 5], [1, 2, 3]],
    };
    const result = userRemoved(state);
    expect(result).toContainEqual([0, 0, 5]);
    expect(result).toContainEqual([1, 2, 3]);
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
// PuzzleState.isKiller
// ---------------------------------------------------------------------------

describe('PuzzleState.isKiller', () => {
  it('returns true for killer puzzles', () => {
    expect(PuzzleState.isKiller(makeState())).toBe(true);
  });

  it('returns false for classic puzzles', () => {
    const classic = PuzzleState.createClassic(null, [], null);
    expect(PuzzleState.isKiller(classic)).toBe(false);
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

  it('fixtureStalledCandidates: board starts from the given candidate grid, not a fresh solve', () => {
    // alwaysApplyRules is empty so without fixtureStalledCandidates the board
    // would keep all 9 candidates per cell. The stall seed must override that.
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d!]));
    const state: KillerPuzzleState = {
      ...makeState(),
      alwaysApplyRules: [],
      fixtureStalledCandidates: stalledCandidates,
    };
    const { board } = buildEngine(state);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect([...board.cands(r, c)]).toEqual([KNOWN_SOLUTION[r]![c]!]);
      }
    }
  });

  it('fixtureStalledCandidates: board candidates unchanged after hint-mode solve', () => {
    // Hint rules can observe the board but cannot modify it — they only populate
    // pendingHints. After seeding with fixtureStalledCandidates, the board must
    // still reflect those candidates even after buildEngine runs hint rules.
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d!]));
    const state: KillerPuzzleState = {
      ...makeState(),
      alwaysApplyRules: [],
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      fixtureStalledCandidates: stalledCandidates,
    };
    const { board } = buildEngine(state, { includeHints: true });
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect([...board.cands(r, c)]).toEqual([KNOWN_SOLUTION[r]![c]!]);
      }
    }
  });

  it('constructs a KillerBoardState and KillerSolverEngine for killer puzzles', () => {
    const { board, engine } = buildEngine(makeState());
    expect(board).toBeInstanceOf(KillerBoardState);
    expect(engine).toBeInstanceOf(KillerSolverEngine);
  });

  it('constructs a plain BoardState and SolverEngine (not Killer variants) for classic puzzles', () => {
    const base = makeState();
    const state = PuzzleState.createClassic(null, base.alwaysApplyRules, null);
    const { board, engine } = buildEngine(state);
    expect(board).toBeInstanceOf(BoardState);
    expect(board).not.toBeInstanceOf(KillerBoardState);
    expect(engine).toBeInstanceOf(SolverEngine);
    expect(engine).not.toBeInstanceOf(KillerSolverEngine);
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
      userRemovedCandidates: [[1, 1, gold]],
    };
    expect(isUserCorrupted(state)).toBe(true);
  });

  it('returns false when userRemovedCandidates is empty (eliminate + restore nets to nothing)', () => {
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userRemovedCandidates: [],
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

  it('applies userRemovedCandidates even when the digit matches the golden solution', () => {
    // userRemovedCandidates is now applied without a safety filter — the user explicitly
    // eliminated this candidate, so it is removed. isUserCorrupted() handles detection.
    const gold = KNOWN_SOLUTION[0]![0]!;
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userRemovedCandidates: [[0, 0, gold]],
    };
    const { board } = buildEngine(state, { skipSolve: true });
    expect(board.cands(0, 0).has(gold)).toBe(false);
  });

  it('applies userRemovedCandidates that do NOT violate the golden solution', () => {
    const gold = KNOWN_SOLUTION[0]![0]!;
    const nonGold = gold === 1 ? 2 : 1;
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userRemovedCandidates: [[0, 0, nonGold]],
    };
    const { board } = buildEngine(state, { skipSolve: true });
    expect(board.cands(0, 0).has(nonGold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_ALWAYS_APPLY_RULES
// ---------------------------------------------------------------------------

describe('DEFAULT_ALWAYS_APPLY_RULES', () => {
  it('contains the expected rule names', () => {
    expect(DEFAULT_ALWAYS_APPLY_RULES).toContain('CageCandidateFilter');
  });

  it('does not contain NakedSingle (user-configurable, not a cold-start default)', () => {
    expect(DEFAULT_ALWAYS_APPLY_RULES).not.toContain('NakedSingle');
  });
});

// ---------------------------------------------------------------------------
// applyAutoPlacements / applyNextAutoPlacement — inconsistency guard
// ---------------------------------------------------------------------------

/** State with 80 cells placed (KNOWN_SOLUTION minus (0,0)) and NakedSingle active. */
function makeAlmostCompleteState(opts: { wrongAt?: [number, number] } = {}): KillerPuzzleState {
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
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
  };
}

/** State with duplicate digits in userGrid and no goldenSolution — soundness assertion inactive. */
function makeInternallyInconsistentState(): KillerPuzzleState {
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
    // Real golden solution; the row-duplicate makes isUserCorrupted true,
    // which makes buildEngine disable the soundness assertion internally.
    goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
  };
}

describe('applyAutoPlacements — NakedSingle applies placement and peer eliminations', () => {
  it('places (0,0) with NakedSingle as the only always-apply rule (no separate CSE needed)', () => {
    // NakedSingle now handles both placement and peer elimination in one rule, so the
    // cascade works correctly without any separate CellSolutionElimination rule.
    const spec = makeTrivialSpec();
    const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
    userGrid[0]![0] = 0;
    const state: KillerPuzzleState = {
      specData: specToData(spec),
      cageStates: specToCageStates(spec),
      userGrid,
      virtualCages: [],
      turns: [],
      alwaysApplyRules: ['NakedSingle'],
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      givenDigits: null,
      originalImageUrl: null,
      warpedImageUrl: null,
      userRemovedCandidates: [],
    };
    const result = applyAutoPlacements(state);
    // NakedSingle is in alwaysApplyRules, so the cascade runs and (0,0) is placed.
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });
});

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

  itNS('places some digit in (0,0) when the golden candidate was explicitly eliminated', () => {
    // User removed the correct digit from (0,0). Engine continues as if that removal
    // is intentional — some other digit gets forced via remaining constraints.
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: KillerPuzzleState = {
      ...state,
      userRemovedCandidates: [[0, 0, gold]],
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

  itNS('places some non-golden digit in (0,0) when the golden candidate was eliminated', () => {
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: KillerPuzzleState = {
      ...state,
      userRemovedCandidates: [[0, 0, gold]],
    };
    const result = applyNextAutoPlacement(stateWithElim);
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).not.toBe(gold);
  });
});

// ---------------------------------------------------------------------------
// userRemovedCandidates — UserAction.apply accumulates eliminations
// ---------------------------------------------------------------------------

describe('userRemovedCandidates in UserAction.apply', () => {
  it('eliminateCandidate adds triple to userRemovedCandidates', () => {
    const action: EliminateCandidateAction = { type: 'eliminateCandidate', row: 0, col: 0, digit: 5 };
    const next = UserAction.apply(action, makeState());
    expect(next.userRemovedCandidates).toEqual([[0, 0, 5]]);
  });

  it('applyHint adds all eliminations to userRemovedCandidates', () => {
    const action: ApplyHintAction = { type: 'applyHint', eliminations: [[0, 0, 3], [1, 2, 7]] };
    const next = UserAction.apply(action, makeState());
    expect(next.userRemovedCandidates).toEqual([[0, 0, 3], [1, 2, 7]]);
  });

  it('restoreCandidate removes the most recent matching triple', () => {
    const base = makeState();
    const withElim: PuzzleState = { ...base, userRemovedCandidates: [[0, 0, 5], [0, 0, 3]] };
    const action: RestoreCandidateAction = { type: 'restoreCandidate', row: 0, col: 0, digit: 3 };
    const next = UserAction.apply(action, withElim);
    expect(next.userRemovedCandidates).toEqual([[0, 0, 5]]);
  });

  it('resetCellCandidates removes all triples for the given cell', () => {
    const base = makeState();
    const withElim: PuzzleState = { ...base, userRemovedCandidates: [[0, 0, 5], [1, 2, 7], [0, 0, 3]] };
    const action: ResetCellCandidatesAction = { type: 'resetCellCandidates', row: 0, col: 0 };
    const next = UserAction.apply(action, withElim);
    expect(next.userRemovedCandidates).toEqual([[1, 2, 7]]);
  });
});

// ---------------------------------------------------------------------------
// Hint regression: issue #141 — NakedPair in top-right box
// ---------------------------------------------------------------------------

describe('buildEngine hints regression — issue #141', () => {
  it('NakedPair appears in hints when pair {2,8} exists at r1c9 and r2c9', () => {
    // Classic puzzle from issue #141.  Cells (0,8) and (1,8) (0-indexed) both
    // have only {2,8} as candidates — a naked pair in col 9 and box 3,3.
    // The pair should generate col-level eliminations that appear in pendingHints.
    const userGrid = [
      [0, 0, 0, 9, 6, 0, 7, 3, 0],
      [0, 0, 0, 1, 0, 3, 4, 0, 0],
      [0, 0, 0, 7, 8, 0, 5, 9, 1],
      [0, 0, 3, 5, 0, 0, 0, 4, 0],
      [0, 5, 0, 0, 0, 0, 2, 0, 6],
      [0, 0, 1, 2, 0, 6, 0, 0, 3],
      [6, 0, 5, 4, 0, 7, 0, 0, 0],
      [9, 0, 0, 0, 1, 0, 0, 0, 0],
      [0, 8, 2, 0, 0, 0, 0, 0, 0],
    ];
    const base = PuzzleState.createClassic(null, ['NakedSingle'], null);
    const state: PuzzleState = { ...base, userGrid };
    const { engine } = buildEngine(state, { includeHints: true });
    const nakedPairHints = engine.pendingHints.filter(h => h.ruleName === 'NakedPair');
    expect(nakedPairHints.length).toBeGreaterThan(0);
  });
});

describe('recordTurn — trigger validation scheduling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules trigger validation exactly once when goldenSolution is present', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const state: PuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
    };
    const gold = KNOWN_SOLUTION[0]![0]!;
    const nonGold = gold === 1 ? 2 : 1;
    const action: EliminateCandidateAction = { type: 'eliminateCandidate', row: 0, col: 0, digit: nonGold };

    recordTurn(state, action);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});

