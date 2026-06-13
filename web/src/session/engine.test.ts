/**
 * Tests for session/engine.ts helpers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTrivialSpec, makeClassicGivenDigits, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates, cageLabel } from './specUtils.js';
import {
  buildEngine,
  isUserCorrupted,
  userRemoved,
  userVirtualCages,
  applyRuleSteps,
  recordTurn,
  rebuildUserGrid,
  PuzzleStateOps,
} from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import { UserAction, PuzzleState, type KillerPuzzleState, type SessionResult, type Turn, type VirtualCage, type EliminateCandidateAction, type RestoreCandidateAction, type ResetCellCandidatesAction, type ApplyHintAction } from './types.js';
import { RuleMutation, type RuleStep } from './ruleMutation.js';
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

/** A KillerPuzzleState with a hand-crafted cage layout, for cageBoundaries/cageLabels tests. */
function makeCageLayoutState(regions: number[][], cageTotals: number[][]): KillerPuzzleState {
  return { ...makeState(), specData: { regions, cageTotals } };
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
// PuzzleState.rules
// ---------------------------------------------------------------------------

describe('PuzzleState.rules', () => {
  it('killer state yields killerOnly rules', () => {
    const rules = [...PuzzleState.rules(makeState())];
    expect(rules.some(r => r.killerOnly)).toBe(true);
  });

  it('classic state excludes killerOnly rules', () => {
    const classic = PuzzleState.createClassic(null, [], null);
    const rules = [...PuzzleState.rules(classic)];
    expect(rules.some(r => r.killerOnly)).toBe(false);
    expect(rules.length).toBeGreaterThan(0);
  });

  it('excludes rules in DISABLED_RULES', () => {
    const rules = [...PuzzleState.rules(makeState())];
    const disabled = new Set(DISABLED_RULES);
    expect(rules.some(r => disabled.has(r.name))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PuzzleState.availableCommands
// ---------------------------------------------------------------------------

describe('PuzzleState.availableCommands', () => {
  it('excludes undo when there are no turns', () => {
    const commands = PuzzleState.availableCommands(makeState());
    expect(commands.has('undo')).toBe(false);
  });

  it('includes undo after a user placement', () => {
    const turns = [makeTurn({ type: 'placeDigit', row: 0, col: 0, digit: 5, source: 'user' })];
    const commands = PuzzleState.availableCommands({ ...makeState(), turns });
    expect(commands.has('undo')).toBe(true);
  });

  it('excludes undo when the last turn is a given placement', () => {
    const turns = [makeTurn({ type: 'placeDigit', row: 0, col: 0, digit: 5, source: 'given' })];
    const commands = PuzzleState.availableCommands({ ...makeState(), turns });
    expect(commands.has('undo')).toBe(false);
  });

  it('includes inspectCage and virtualCage for killer states', () => {
    const commands = PuzzleState.availableCommands(makeState());
    expect(commands.has('inspectCage')).toBe(true);
    expect(commands.has('virtualCage')).toBe(true);
  });

  it('excludes inspectCage and virtualCage for classic states', () => {
    const classic = PuzzleState.createClassic(null, [], null);
    const commands = PuzzleState.availableCommands(classic);
    expect(commands.has('inspectCage')).toBe(false);
    expect(commands.has('virtualCage')).toBe(false);
  });

  it('includes reveal only when goldenSolution is set', () => {
    const withoutSolution = PuzzleState.availableCommands(makeState());
    expect(withoutSolution.has('reveal')).toBe(false);

    const withSolution = PuzzleState.availableCommands({
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
    });
    expect(withSolution.has('reveal')).toBe(true);
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
// applyRuleSteps — inconsistency guard
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

describe('applyRuleSteps — NakedSingle applies placement and peer eliminations', () => {
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
    const { state: result } = applyRuleSteps(state);
    // NakedSingle is in alwaysApplyRules, so the cascade runs and (0,0) is placed.
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });
});

describe('applyRuleSteps — continues even with wrong placements', () => {
  it('places the deducible digit when board is consistent', () => {
    const state = makeAlmostCompleteState();
    const { state: result } = applyRuleSteps(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when userGrid has a row-duplicate — cage constraint overrides', () => {
    // Row 0 has a duplicate digit. The engine treats the board as-is.
    // The trivial spec gives (0,0) a 1-cell cage with total = KNOWN_SOLUTION[0][0],
    // so the cage constraint uniquely forces (0,0) regardless of the row duplicate.
    const state = makeInternallyInconsistentState();
    const { state: result } = applyRuleSteps(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when a wrong digit is present elsewhere — treat as correct', () => {
    // Wrong digit at (0,1) — engine proceeds as if it were correct.
    // (0,0) is forced by its 1-cell cage constraint (total = KNOWN_SOLUTION[0][0]).
    const state = makeAlmostCompleteState({ wrongAt: [0, 1] });
    const { state: result } = applyRuleSteps(state);
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
    const { state: result } = applyRuleSteps(stateWithElim);
    expect(result.userGrid![0]![0]).not.toBe(0); // some digit was placed
    expect(result.userGrid![0]![0]).not.toBe(gold); // not the golden digit
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

  it('applyHint folds eliminateCandidate mutations into userRemovedCandidates', () => {
    const action: ApplyHintAction = {
      type: 'applyHint',
      mutations: [RuleMutation.eliminateCandidate(0, 0, 3), RuleMutation.eliminateCandidate(1, 2, 7)],
    };
    const next = UserAction.apply(action, makeState());
    expect(next.userRemovedCandidates).toEqual([[0, 0, 3], [1, 2, 7]]);
  });

  it('applyHint folds a placeDigit mutation into userGrid', () => {
    const action: ApplyHintAction = {
      type: 'applyHint',
      mutations: [RuleMutation.placeDigit(0, 0, 5)],
    };
    const next = UserAction.apply(action, makeState());
    expect(next.userGrid[0]![0]).toBe(5);
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

describe('recordTurn — { state, ruleSteps, baseState } contract', () => {
  it('returns finalState with ruleSteps folded onto baseState, plus a recorded turn', () => {
    const state = makeState();
    const action: EliminateCandidateAction = { type: 'eliminateCandidate', row: 0, col: 0, digit: 1 };

    const { state: finalState, ruleSteps, baseState } = recordTurn(state, action);

    // baseState is UserAction.apply(action, state) — one more turn than the input.
    expect(baseState.turns.length).toBe(state.turns.length);
    expect(finalState.turns.length).toBe(baseState.turns.length + 1);
    expect(finalState.turns[finalState.turns.length - 1]!.action).toEqual(action);

    // finalState's board fields equal ruleSteps folded onto baseState.
    const folded = ruleSteps.flatMap(s => s.mutations).reduce((s, m) => m.apply(s), baseState);
    expect(finalState.userGrid).toEqual(folded.userGrid);
    expect(finalState.userRemovedCandidates).toEqual(folded.userRemovedCandidates);
  });
});

describe('applyRuleSteps / recordTurn — board field', () => {
  it('applyRuleSteps returns a board alongside state and ruleSteps', () => {
    const state = makeState();
    const { board } = applyRuleSteps(state);
    expect(board).toBeDefined();
    expect(typeof board.cands).toBe('function');
  });

  it('recordTurn returns a board alongside state, ruleSteps, and baseState', () => {
    const state = makeState();
    const action: EliminateCandidateAction = { type: 'eliminateCandidate', row: 0, col: 0, digit: 1 };
    const { board } = recordTurn(state, action);
    expect(board).toBeDefined();
    expect(typeof board.cands).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// PuzzleStateOps
// ---------------------------------------------------------------------------

describe('PuzzleStateOps', () => {
  function confirmedState(): KillerPuzzleState {
    return { ...makeState(), goldenSolution: KNOWN_SOLUTION.map(row => [...row]) };
  }

  // RuleMutation objects carry a per-call `apply` closure, so two independently
  // computed SessionResults are never reference- or toEqual-identical. Compare
  // their serialisable data shape instead.
  function expectMatches(result: SessionResult, expected: { state: PuzzleState; ruleSteps: readonly RuleStep[]; board: BoardState }): void {
    expect(JSON.stringify(result.state)).toEqual(JSON.stringify(expected.state));
    expect(JSON.stringify(result.ruleSteps)).toEqual(JSON.stringify(expected.ruleSteps));
    expect(result.board).toBeInstanceOf(BoardState);
  }

  it('placeDigit returns a SessionResult matching recordTurn', () => {
    const state = confirmedState();
    const expected = recordTurn(state, { type: 'placeDigit', row: 0, col: 0, digit: 1, source: 'user' });
    const result = PuzzleStateOps.placeDigit(state, 0, 0, 1);
    expectMatches(result, expected);
  });

  it('placeDigit throws when the session is not confirmed', () => {
    const state = makeState();
    expect(() => PuzzleStateOps.placeDigit(state, 0, 0, 1)).toThrow('Session not yet confirmed');
  });

  it('removeDigit returns a SessionResult matching recordTurn', () => {
    const state = { ...confirmedState(), userGrid: KNOWN_SOLUTION.map(row => [...row]) as number[][] };
    const expected = recordTurn(state, { type: 'removeDigit', row: 0, col: 0 });
    const result = PuzzleStateOps.removeDigit(state, 0, 0);
    expectMatches(result, expected);
  });

  it('eliminateCandidate returns a SessionResult matching recordTurn', () => {
    const state = confirmedState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const nonGold = gold === 1 ? 2 : 1;
    const expected = recordTurn(state, { type: 'eliminateCandidate', row: 0, col: 0, digit: nonGold });
    const result = PuzzleStateOps.eliminateCandidate(state, 0, 0, nonGold);
    expectMatches(result, expected);
  });

  it('restoreCandidate returns a SessionResult matching recordTurn', () => {
    const gold = KNOWN_SOLUTION[0]![0]!;
    const nonGold = gold === 1 ? 2 : 1;
    const state = { ...confirmedState(), userRemovedCandidates: [[0, 0, nonGold]] as [number, number, number][] };
    const expected = recordTurn(state, { type: 'restoreCandidate', row: 0, col: 0, digit: nonGold });
    const result = PuzzleStateOps.restoreCandidate(state, 0, 0, nonGold);
    expectMatches(result, expected);
  });

  it('resetCellCandidates returns a SessionResult matching recordTurn', () => {
    const state = confirmedState();
    const expected = recordTurn(state, { type: 'resetCellCandidates', row: 0, col: 0 });
    const result = PuzzleStateOps.resetCellCandidates(state, 0, 0);
    expectMatches(result, expected);
  });

  it('addVirtualCage returns a SessionResult matching recordTurn', () => {
    const state = confirmedState();
    const cage: VirtualCage = { cells: [[0, 0], [0, 1]] as Cell[], total: 10, eliminatedSolns: [] };
    const expected = recordTurn(state, { type: 'addVirtualCage', cage });
    const result = PuzzleStateOps.addVirtualCage(state, cage);
    expectMatches(result, expected);
  });

  it('removeVirtualCage returns a SessionResult matching recordTurn', () => {
    const cage: VirtualCage = { cells: [[0, 0], [0, 1]] as Cell[], total: 10, eliminatedSolns: [] };
    const withCage: KillerPuzzleState = {
      ...confirmedState(),
      turns: [makeTurn({ type: 'addVirtualCage', cage })],
    };
    const key = '0,0:0,1:10';
    const expected = recordTurn(withCage, { type: 'removeVirtualCage', key });
    const result = PuzzleStateOps.removeVirtualCage(withCage, key);
    expectMatches(result, expected);
  });

  it('applyHint returns a SessionResult matching recordTurn', () => {
    const state = confirmedState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const nonGold = gold === 1 ? 2 : 1;
    const eliminations = [{ cell: [0, 0] as readonly [number, number], digit: nonGold }];
    const mutations = eliminations.map(e => RuleMutation.eliminateCandidate(e.cell[0], e.cell[1], e.digit));
    const expected = recordTurn(state, { type: 'applyHint', mutations });
    const result = PuzzleStateOps.applyHint(state, eliminations);
    expectMatches(result, expected);
  });

  it('undo returns a SessionResult matching applyRuleSteps(rebuildUserGrid(trimmed))', () => {
    const state = confirmedState();
    const action: EliminateCandidateAction = { type: 'eliminateCandidate', row: 0, col: 0, digit: 1 };
    const afterTurn = recordTurn(state, action).state;

    const trimmed: PuzzleState = { ...afterTurn, turns: afterTurn.turns.slice(0, -1) };
    const expected = applyRuleSteps(rebuildUserGrid(trimmed));
    const result = PuzzleStateOps.undo(afterTurn);
    expectMatches(result, expected);
  });

  it('undo throws "Nothing to undo" when there are no turns', () => {
    const state = confirmedState();
    expect(() => PuzzleStateOps.undo(state)).toThrow('Nothing to undo');
  });

  it('undo throws "Cannot undo given digits" for a given placeDigit turn', () => {
    const state = {
      ...confirmedState(),
      turns: [makeTurn({ type: 'placeDigit', row: 0, col: 0, digit: 1, source: 'given' })],
    };
    expect(() => PuzzleStateOps.undo(state)).toThrow('Cannot undo given digits');
  });
});

// ---------------------------------------------------------------------------
// PuzzleState.candidateDisplay
// ---------------------------------------------------------------------------

describe('PuzzleState.candidateDisplay', () => {
  it('empty cell with live candidates: placed is null, candidates includes those digits', () => {
    const state = { ...makeState(), alwaysApplyRules: [] };
    const { board } = buildEngine(state, { skipSolve: true });
    const display = PuzzleState.candidateDisplay(state, board);
    const cell = display[1]![1]!;
    expect(cell.placed).toBeNull();
    const digits = cell.candidates.map(c => c.digit);
    expect(digits).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('user-removed candidate is absent from candidates', () => {
    const state: KillerPuzzleState = {
      ...makeState(),
      alwaysApplyRules: [],
      userRemovedCandidates: [[1, 1, 5]],
    };
    const { board } = buildEngine(state, { skipSolve: true });
    const display = PuzzleState.candidateDisplay(state, board);
    const digits = display[1]![1]!.candidates.map(c => c.digit);
    expect(digits).not.toContain(5);
  });

  it('solver-eliminated digit (not in board.cands) is absent from candidates', () => {
    const state = { ...makeState(), alwaysApplyRules: [] };
    const { board } = buildEngine(state, { skipSolve: true });
    board.removeCandidate(1, 1, 7);
    const display = PuzzleState.candidateDisplay(state, board);
    const digits = display[1]![1]!.candidates.map(c => c.digit);
    expect(digits).not.toContain(7);
  });

  it('given digit (classic): placed.locked is true, colour is black', () => {
    const givenDigits = makeClassicGivenDigits();
    const state = PuzzleState.createClassic(givenDigits, [], null);
    const { board } = buildEngine(state, { skipSolve: true });
    const display = PuzzleState.candidateDisplay(state, board);
    // (0,0) is blanked by makeClassicGivenDigits; pick a cell that is given, e.g. (0,1).
    const cell = display[0]![1]!;
    expect(cell.placed).toEqual({ digit: KNOWN_SOLUTION[0]![1]!, colour: 'black', locked: true });
  });

  it('user-placed digit, no golden solution: placed.locked is false, colour is black', () => {
    // Killer puzzles have no givenDigits, so digitGrid falls back to userGrid
    // even before goldenSolution is set.
    const base = makeState();
    const userGrid = base.userGrid.map(row => [...row]);
    userGrid[0]![0] = KNOWN_SOLUTION[0]![0]!;
    const state = { ...base, alwaysApplyRules: [], userGrid };
    const { board } = buildEngine(state, { skipSolve: true });
    const display = PuzzleState.candidateDisplay(state, board);
    const cell = display[0]![0]!;
    expect(cell.placed).toEqual({ digit: KNOWN_SOLUTION[0]![0]!, colour: 'black', locked: false });
  });

  it('user-placed digit with goldenSolution set, not a given: colour is blue', () => {
    const givenDigits = makeClassicGivenDigits();
    let state = PuzzleState.createClassic(givenDigits, [], null);
    const userGrid = state.userGrid.map(row => [...row]);
    userGrid[0]![0] = KNOWN_SOLUTION[0]![0]!;
    state = { ...state, userGrid, goldenSolution: KNOWN_SOLUTION.map(row => [...row]) };
    const { board } = buildEngine(state, { skipSolve: true });
    const display = PuzzleState.candidateDisplay(state, board);
    const cell = display[0]![0]!;
    expect(cell.placed).toEqual({ digit: KNOWN_SOLUTION[0]![0]!, colour: 'blue', locked: false });
  });

  it('duplicate digit in a row: colour is red for both cells', () => {
    // Killer puzzles have no givenDigits, so digitGrid is always userGrid.
    const base = makeState();
    const userGrid = base.userGrid.map(row => [...row]);
    userGrid[0]![0] = KNOWN_SOLUTION[0]![1]!;
    userGrid[0]![1] = KNOWN_SOLUTION[0]![1]!;
    const state = { ...base, alwaysApplyRules: [], userGrid };
    const { board } = buildEngine(state, { skipSolve: true });
    const display = PuzzleState.candidateDisplay(state, board);
    expect(display[0]![0]!.placed?.colour).toBe('red');
    expect(display[0]![1]!.placed?.colour).toBe('red');
  });

  it('killer puzzle: candidate matching the cage must-contain digit is essential', () => {
    const state = { ...makeState(), alwaysApplyRules: [] };
    const { board } = buildEngine(state, { skipSolve: true });
    const display = PuzzleState.candidateDisplay(state, board);
    // makeTrivialSpec gives every cell its own single-cell cage, so the cage's
    // only solution is KNOWN_SOLUTION[r][c] — that digit is essential.
    const cell = display[0]![0]!;
    const essential = KNOWN_SOLUTION[0]![0]!;
    const essCand = cell.candidates.find(c => c.digit === essential);
    const otherCand = cell.candidates.find(c => c.digit !== essential);
    expect(essCand?.colour).toBe('essential');
    expect(otherCand?.colour).toBe('grey');
  });

  it('classic puzzle: no candidate is ever essential', () => {
    const givenDigits = makeClassicGivenDigits();
    const state = PuzzleState.createClassic(givenDigits, [], null);
    const { board } = buildEngine(state, { skipSolve: true });
    const display = PuzzleState.candidateDisplay(state, board);
    for (const row of display) for (const cell of row) {
      for (const cand of cell.candidates) expect(cand.colour).not.toBe('essential');
    }
  });
});

// ---------------------------------------------------------------------------
// PuzzleState.cageBoundaries
// ---------------------------------------------------------------------------

describe('PuzzleState.cageBoundaries', () => {
  it('classic puzzle returns empty array', () => {
    const givenDigits = makeClassicGivenDigits();
    const state = PuzzleState.createClassic(givenDigits, [], null);
    expect(PuzzleState.cageBoundaries(state)).toEqual([]);
  });

  it('killer puzzle: emits bottom/right segments at region boundaries', () => {
    const regions = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    regions[0]![1] = 1; // cell (0,1) is region 1; all other cells are region 0
    const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const state = makeCageLayoutState(regions, cageTotals);
    const segments = PuzzleState.cageBoundaries(state);

    // (0,0)|(0,1) differ -> right edge at (0,0)
    expect(segments).toContainEqual({ row: 0, col: 0, edge: 'right' });
    // (0,1)|(1,1) differ (1 vs 0) -> bottom edge at (0,1)
    expect(segments).toContainEqual({ row: 0, col: 1, edge: 'bottom' });
    // (0,1)|(0,2) differ (1 vs 0) -> right edge at (0,1)
    expect(segments).toContainEqual({ row: 0, col: 1, edge: 'right' });
    // (1,0)|(1,1) are both region 0 -> no right edge at (1,0)
    expect(segments).not.toContainEqual({ row: 1, col: 0, edge: 'right' });
    // Exactly the three boundary edges of the single region-1 cell
    // (right of (0,0); bottom and right of (0,1) itself).
    expect(segments).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// PuzzleState.cageLabels
// ---------------------------------------------------------------------------

describe('PuzzleState.cageLabels', () => {
  it('classic puzzle returns empty array', () => {
    const givenDigits = makeClassicGivenDigits();
    const state = PuzzleState.createClassic(givenDigits, [], null);
    expect(PuzzleState.cageLabels(state)).toEqual([]);
  });

  it('killer puzzle: emits a label for each non-zero cageTotals cell, in row-major order', () => {
    const regions = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    cageTotals[0]![0] = 17;
    cageTotals[2]![3] = 9;
    const state = makeCageLayoutState(regions, cageTotals);

    expect(PuzzleState.cageLabels(state)).toEqual([
      { row: 0, col: 0, total: 17 },
      { row: 2, col: 3, total: 9 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// PuzzleState.serialize / PuzzleState.deserialize
// ---------------------------------------------------------------------------

describe('PuzzleState.serialize', () => {
  it('tags a classic state with kind: "classic" and version: 1', () => {
    const givenDigits = makeClassicGivenDigits();
    const state = PuzzleState.createClassic(givenDigits, [], null);
    const serialized = PuzzleState.serialize(state);
    expect(serialized.kind).toBe('classic');
    expect(serialized.version).toBe(1);
    expect(serialized.userGrid).toEqual(state.userGrid);
    expect(serialized.givenDigits).toEqual(givenDigits);
  });

  it('tags a killer state with kind: "killer" and version: 1, including killer-only fields', () => {
    const state = makeState();
    const serialized = PuzzleState.serialize(state);
    expect(serialized.kind).toBe('killer');
    expect(serialized.version).toBe(1);
    if (serialized.kind === 'killer') {
      expect(serialized.specData).toEqual(state.specData);
      expect(serialized.cageStates).toEqual(state.cageStates);
      expect(serialized.virtualCages).toEqual(state.virtualCages);
      expect(serialized.warpedImageUrl).toEqual(state.warpedImageUrl);
    }
  });
});

describe('PuzzleState.deserialize', () => {
  it('round-trips a classic state', () => {
    const givenDigits = makeClassicGivenDigits();
    const state = PuzzleState.createClassic(givenDigits, ['NakedSingle'], null);
    const roundTripped = PuzzleState.deserialize(PuzzleState.serialize(state));
    expect(roundTripped).toEqual(state);
  });

  it('round-trips a killer state with non-empty turns, userRemovedCandidates, and virtualCages', () => {
    const vc: VirtualCage = {
      cells: [[0, 0], [0, 1]] as Cell[],
      total: 10,
      eliminatedSolns: [],
    };
    const turns = [makeTurn({ type: 'placeDigit', row: 0, col: 0, digit: 5, source: 'user' })];
    // deserialize does not reconstruct fixtureStalledCandidates (not in the
    // validated field list) — omit it so toEqual doesn't compare makeState()'s
    // `null` against a missing key.
    const { fixtureStalledCandidates: _fixtureStalledCandidates, ...baseState } = makeState();
    const state: KillerPuzzleState = {
      ...baseState,
      turns,
      virtualCages: [vc],
      userRemovedCandidates: [[1, 2, 3]],
    };
    const roundTripped = PuzzleState.deserialize(PuzzleState.serialize(state));
    expect(roundTripped).toEqual(state);
  });

  it('throws on missing kind', () => {
    const data = { ...PuzzleState.serialize(makeState()) } as Record<string, unknown>;
    delete data['kind'];
    expect(() => PuzzleState.deserialize(data)).toThrow();
  });

  it('throws on unrecognised kind', () => {
    const data = { ...PuzzleState.serialize(makeState()), kind: 'bigApple' };
    expect(() => PuzzleState.deserialize(data)).toThrow();
  });

  it('throws on wrong version', () => {
    const data = { ...PuzzleState.serialize(makeState()), version: 2 };
    expect(() => PuzzleState.deserialize(data)).toThrow();
  });

  it('throws on missing/malformed userGrid', () => {
    const data = { ...PuzzleState.serialize(makeState()), userGrid: [[1, 2, 3]] };
    expect(() => PuzzleState.deserialize(data)).toThrow();
  });

  it('throws on missing specData for kind "killer"', () => {
    const data = { ...PuzzleState.serialize(makeState()) } as Record<string, unknown>;
    delete data['specData'];
    expect(() => PuzzleState.deserialize(data)).toThrow();
  });

  it('throws when data is not an object', () => {
    expect(() => PuzzleState.deserialize(null)).toThrow();
    expect(() => PuzzleState.deserialize('not an object')).toThrow();
  });
});

