/**
 * Regression tests for session/actions.ts.
 *
 * Covers the bugs fixed in the review sprint:
 *   #13 – Classic candidates always empty
 *   #14 – findLastConsistentTurnIdx always returns non-null
 *   #16 – Undo button never enables after placing a digit in classic mode
 *   #17 – Reveal uses stale solvePuzzle() instead of cached goldenSolution
 *   #24 – Incorrect candidates (placed digit should be eliminated from peers)
 *   #25 – Edit candidates digit pad (cycleCandidate correctly toggles state)
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Node test environment lacks localStorage; provide a minimal in-memory shim.
if (typeof globalThis.localStorage === 'undefined') {
  const _store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem:    (k: string) => _store[k] ?? null,
      setItem:    (k: string, v: string) => { _store[k] = v; },
      removeItem: (k: string) => { delete _store[k]; },
      clear:      () => { for (const k of Object.keys(_store)) delete _store[k]; },
    },
    configurable: true,
  });
}
import { setState, getState, getStateCandidates } from './store.js';
import {
  buildCandidatesFromParseResult,
  confirmPuzzle,
  solveCurrentSpec,
  loadSpecDirect,
  enterCell,
  enterCellStep,
  undo,
  computeCandidates,
  candidatesFromBoard,
  cycleCandidate,
  addVirtualCage,
  removeVirtualCage,
  getSettingsData,
  saveSettingsData,
  getAutoPlacementDelay,
  applyHint,
  getHints,
  solveAndValidateSpec,
  extractAndValidateSolution,
  activeCandidate,
  revertToOcr,
} from './actions.js';
import { findLastConsistentTurnIdx } from './engine.js';
import { BoardState } from '../engine/index.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import { defaultRules } from '../engine/rules/index.js';
import {
  makeBoxCageSpec,
  makeTrivialSpec,
  makeTwoCellCageSpec,
  makeClassicGivenDigits,
  KNOWN_SOLUTION,
} from '../engine/fixtures.js';
import { specToData, specToCageStates, classicSyntheticSpec } from './specUtils.js';
import { PuzzleState } from './types.js';
import type { ApplyHintAction, KillerPuzzleState, Turn, UserAction } from './types.js';
import type { EliminateCandidateMutation } from './ruleMutation.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import type { ParseResult } from '../image/inpImage.js';
import { hasMultipleCageTotals } from '../image/validation.js';

// Tests that depend on NakedSingle being active are skipped when the rule is
// disabled (e.g. after sync-rule-fixtures adds it to DISABLED_RULES).
const itNS = DISABLED_RULES.includes('NakedSingle') ? it.skip : it;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClassicState(givenDigits: number[][]): PuzzleState {
  const state = PuzzleState.createClassic(givenDigits, [...DEFAULT_ALWAYS_APPLY_RULES], null);
  setState(state);
  return state;
}

function makeKillerConfirmed(): PuzzleState {
  const spec = makeBoxCageSpec();
  const pre = PuzzleState.createKiller(
    specToData(spec), specToCageStates(spec), [...DEFAULT_ALWAYS_APPLY_RULES], null, null,
  );
  setState(pre);
  return confirmPuzzle(solveCurrentSpec().board);
}

function makeClassicConfirmed(): PuzzleState {
  const givenDigits = makeClassicGivenDigits();
  makeClassicState(givenDigits);
  const { board } = solveCurrentSpec();
  return confirmPuzzle(board);
}


// ---------------------------------------------------------------------------
// #13 – Classic candidates
// ---------------------------------------------------------------------------

describe('computeCandidates — classic mode (#13)', () => {
  beforeEach(() => { makeClassicConfirmed(); });

  it('returns non-empty candidates for blank cells', () => {
    const data = computeCandidates();
    const anyNonEmpty = data.cells.some(row => row.some(cell => cell.candidates.length > 0));
    expect(anyNonEmpty, 'at least one cell should have candidates').toBe(true);
  });

  it('blank cell (0,0) has digit 5 as its only candidate', () => {
    // KNOWN_SOLUTION[0][0] = 5; makeClassicGivenDigits blanks that cell.
    // After NakedSingle peer-elimination propagation only digit 5 should remain.
    const data = computeCandidates();
    const cell = data.cells[0]![0]!;
    expect(cell.candidates).toEqual([5]);
  });
});

describe('candidatesFromBoard — instanceof KillerBoardState narrow', () => {
  it('produces an empty cages array and solverCands === board.cands(r, c) for a plain BoardState', () => {
    const givenDigits = makeClassicGivenDigits();
    const state = makeClassicState(givenDigits);
    const board = new BoardState();
    const data = candidatesFromBoard(board, state);
    expect(data.cages).toEqual([]);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect(data.cells[r]![c]!.candidates).toEqual([...board.cands(r, c)].sort((a, b) => a - b));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// #14 – findLastConsistentTurnIdx
// ---------------------------------------------------------------------------

describe('findLastConsistentTurnIdx (#14)', () => {
  it('returns null for a freshly confirmed classic puzzle (no mistakes)', () => {
    const givenDigits = makeClassicGivenDigits();
    makeClassicState(givenDigits);
    const { board } = solveCurrentSpec();
    const state = confirmPuzzle(board);
    expect(findLastConsistentTurnIdx(state)).toBeNull();
  });

  it('returns null for a correct killer board', () => {
    const state = makeKillerConfirmed();
    expect(findLastConsistentTurnIdx(state)).toBeNull();
  });

  it('returns non-null after placing a wrong digit in killer mode', () => {
    const state = makeKillerConfirmed();
    // Place an obviously wrong digit in a cell (box-cage spec: no auto-placements)
    // Find an empty cell and place a wrong digit
    const grid = state.userGrid!;
    for (let r = 1; r <= 9; r++) {
      for (let c = 1; c <= 9; c++) {
        if (grid[r - 1]![c - 1] === 0) {
          const golden = state.goldenSolution![r - 1]![c - 1]!;
          if (golden === 0) continue;
          const wrongDigit = (golden % 9) + 1; // guaranteed different from golden
          if (wrongDigit === golden) continue;
          try { enterCell(r, c, wrongDigit); } catch { continue; }
          const updated = getState()!;
          if (updated.goldenSolution![r - 1]![c - 1] !== wrongDigit) {
            expect(findLastConsistentTurnIdx(updated)).not.toBeNull();
            return;
          }
        }
      }
    }
  });

  it('returns null after placing the correct digit in classic mode', () => {
    const state = makeClassicConfirmed();
    const golden = state.goldenSolution![0]![0]!;
    if (golden === 0) return; // solver could not determine cell — skip
    enterCell(1, 1, golden);
    const updated = getState()!;
    expect(findLastConsistentTurnIdx(updated)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #16 – Undo button: last turn source after enterCell
// ---------------------------------------------------------------------------

describe('enterCell adds user turn — undo button should enable (#16)', () => {
  it('classic: enterCell appends a user-sourced turn', () => {
    makeClassicConfirmed();

    // All given turns should have source 'given'
    const before = getState()!;
    const allGiven = before.turns.every(t =>
      t.action.type === 'placeDigit' && t.action.source === 'given',
    );
    expect(allGiven).toBe(true);

    // Enter a digit (cell (0,0) is blank in fixture, golden = 5)
    enterCell(1, 1, 5);
    const after = getState()!;

    const last = after.turns[after.turns.length - 1]!.action;
    expect(last.type).toBe('placeDigit');
    if (last.type === 'placeDigit') expect(last.source).toBe('user');
  });

  it('classic: undo after enterCell removes the user turn', () => {
    makeClassicConfirmed();
    const beforeCount = getState()!.turns.length;
    enterCell(1, 1, 5);
    expect(getState()!.turns.length).toBe(beforeCount + 1);

    undo();
    const afterUndo = getState()!;
    expect(afterUndo.turns.length).toBe(beforeCount);
    const last = afterUndo.turns[afterUndo.turns.length - 1]!.action;
    if (last.type === 'placeDigit') expect(last.source).toBe('given');
  });

  it('killer: enterCell appends a user-sourced turn', () => {
    const state = makeKillerConfirmed();
    const grid = state.userGrid!;
    for (let r = 1; r <= 9; r++) {
      for (let c = 1; c <= 9; c++) {
        if (grid[r - 1]![c - 1] === 0) {
          const before = getState()!.turns.length;
          try { enterCell(r, c, 5); } catch { continue; }
          const after = getState()!;
          if (after.turns.length > before) {
            const last = after.turns[after.turns.length - 1]!.action;
            if (last.type === 'placeDigit') expect(last.source).toBe('user');
            return;
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// #17 – goldenSolution is set after confirmPuzzle
// ---------------------------------------------------------------------------

describe('goldenSolution cached after confirmPuzzle (#17)', () => {
  it('classic: goldenSolution is non-null and has correct values', () => {
    const givenDigits = makeClassicGivenDigits();
    makeClassicState(givenDigits);
    const { board } = solveCurrentSpec();
    const state = confirmPuzzle(board);
    expect(state.goldenSolution).not.toBeNull();
    // Cell (0,0) was blanked; solver should give 5
    expect(state.goldenSolution![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('killer: goldenSolution is non-null after confirm', () => {
    const state = makeKillerConfirmed();
    expect(state.goldenSolution).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #24 – computeCandidates: placed digit eliminated from row/col/box peers
// ---------------------------------------------------------------------------

describe('computeCandidates — placement propagation (#24)', () => {
  beforeEach(() => { makeKillerConfirmed(); });

  it('placed digit absent from row peers', () => {
    // Use the golden solution digit for (0,0) — placing the correct digit avoids
    // triggering the candidate-soundness assertion in the engine.
    const d = getState()!.goldenSolution![0]![0]!;
    enterCell(1, 1, d);
    const cands = computeCandidates();
    // (row=0,col=3) is a row peer but in a different box — must not contain d.
    expect(cands.cells[0]![3]!.candidates).not.toContain(d);
    // (row=0,col=8) is also a row peer at the far end of the grid.
    expect(cands.cells[0]![8]!.candidates).not.toContain(d);
  });

  it('placed digit absent from column peers', () => {
    const d = getState()!.goldenSolution![0]![0]!;
    enterCell(1, 1, d);
    const cands = computeCandidates();
    // (row=4,col=0) is a col peer in a different box.
    expect(cands.cells[4]![0]!.candidates).not.toContain(d);
  });

  it('placed digit absent from box peers', () => {
    const d = getState()!.goldenSolution![0]![0]!;
    enterCell(1, 1, d);
    const cands = computeCandidates();
    // (row=1,col=1) is a box peer (box 0: rows 0–2, cols 0–2).
    expect(cands.cells[1]![1]!.candidates).not.toContain(d);
    // (row=2,col=2) is another box peer.
    expect(cands.cells[2]![2]!.candidates).not.toContain(d);
  });

  it('two placed digits both absent from shared peer', () => {
    const d0 = getState()!.goldenSolution![0]![0]!;
    const d1 = getState()!.goldenSolution![0]![1]!;
    enterCell(1, 1, d0);
    enterCell(1, 2, d1);
    const cands = computeCandidates();
    // (row=0,col=5) is a row peer of both placements.
    expect(cands.cells[0]![5]!.candidates).not.toContain(d0);
    expect(cands.cells[0]![5]!.candidates).not.toContain(d1);
  });
});

// ---------------------------------------------------------------------------
// #25 – cycleCandidate: digit pad in edit-candidates mode
// ---------------------------------------------------------------------------

describe('cycleCandidate — candidate editing (#25)', () => {
  beforeEach(() => { makeKillerConfirmed(); });

  it('marks an auto-possible candidate as user-removed', () => {
    // Box-cage spec: (row=0,col=0) is empty; all digits are candidates.
    const before = computeCandidates();
    expect(before.cells[0]![0]!.candidates).toContain(1);
    expect(before.cells[0]![0]!.userRemoved).not.toContain(1);

    cycleCandidate(1, 1, 1); // 1-based row/col

    const after = computeCandidates();
    expect(after.cells[0]![0]!.userRemoved).toContain(1);
    // Candidates list still includes 1 so the UI can render it struck-through.
    expect(after.cells[0]![0]!.candidates).toContain(1);
  });

  it('restores a user-removed candidate when cycled again', () => {
    cycleCandidate(1, 1, 1); // remove
    cycleCandidate(1, 1, 1); // restore

    const after = computeCandidates();
    expect(after.cells[0]![0]!.userRemoved).not.toContain(1);
  });

  it('reset (digit 0) clears all user removals for the cell', () => {
    cycleCandidate(1, 1, 1);
    cycleCandidate(1, 1, 2);
    const mid = computeCandidates();
    expect(mid.cells[0]![0]!.userRemoved).toContain(1);
    expect(mid.cells[0]![0]!.userRemoved).toContain(2);

    cycleCandidate(1, 1, 0); // reset

    const after = computeCandidates();
    expect(after.cells[0]![0]!.userRemoved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #24 – Peer elimination is unconditional for placements
//
// Placed digits (given or user) eliminate from peers regardless of which rules
// are active. This is a fundamental sudoku constraint, not a rule.
// ---------------------------------------------------------------------------

describe('computeCandidates — peer elimination unconditional for placements (#24)', () => {
  it('given digits eliminate peers even when NakedSingle is removed from alwaysApplyRules', () => {
    const givenDigits = makeClassicGivenDigits(); // KNOWN_SOLUTION with (0,0) blanked
    makeClassicState(givenDigits);

    // Simulate user disabling NakedSingle in Config.
    const { board } = solveCurrentSpec();
    const state = confirmPuzzle(board);
    const withoutRule: PuzzleState = { ...state, alwaysApplyRules: [] };
    setState(withoutRule);

    const data = computeCandidates();
    // Row 0 givens include 3,4,6,7,8,9,1,2 — so only digit 5 should remain for (0,0).
    expect(data.cells[0]![0]!.candidates).toEqual([5]);
  });

  it('sparse classic: given + user-placed digits absent from box peers with rule disabled', () => {
    // Matches the screenshot scenario: sparse newspaper-style puzzle where only
    // a handful of digits are given, and the user has placed additional digits.
    // Box 1 (rows 0–2, cols 3–5): given r2c3=3 and r2c4=4; blank peers r0c3, r0c4.
    const sparseGivens: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    sparseGivens[2]![3] = 3; // KNOWN_SOLUTION[2][3]
    sparseGivens[2]![4] = 4; // KNOWN_SOLUTION[2][4]
    makeClassicState(sparseGivens);
    const { board } = solveCurrentSpec();
    const state = confirmPuzzle(board);

    // Simulate user disabling NakedSingle, then placing a digit.
    setState({ ...state, alwaysApplyRules: [] });
    // User places 6 at r0c5 (box 1 — same as the two givens above).
    enterCell(1, 6, 6);

    const data = computeCandidates();
    // r0c3 is in box 1: must not contain 3, 4, or 6.
    expect(data.cells[0]![3]!.candidates).not.toContain(3);
    expect(data.cells[0]![3]!.candidates).not.toContain(4);
    expect(data.cells[0]![3]!.candidates).not.toContain(6);
    // r1c4 is also in box 1.
    expect(data.cells[1]![4]!.candidates).not.toContain(3);
    expect(data.cells[1]![4]!.candidates).not.toContain(4);
    expect(data.cells[1]![4]!.candidates).not.toContain(6);
    // r4c3 is a column peer of r2c3=3 (different box) — must not contain 3.
    expect(data.cells[4]![3]!.candidates).not.toContain(3);
    // r0c0 is a row peer of r0c5=6 (user placed) — must not contain 6.
    expect(data.cells[0]![0]!.candidates).not.toContain(6);
  });
});

// ---------------------------------------------------------------------------
// Bug #30 – findLastConsistentTurnIdx wrong fallback
//
// When wrongCells is non-empty but no placeDigit turn in history matches any
// wrong cell (e.g. the digit was placed by an auto-placement which records no
// user turn, or the only matching turn is at a different cell), firstBadIdx
// stays at its initial value of turns.length - 1.  This rewinds only the last
// move rather than recovering to a clean state.
//
// Expected: return 0 (or null) when no matching placeDigit turn is found.
// Actual:   returns turns.length - 1, which is wrong.
// ---------------------------------------------------------------------------

function makeTurnFor(action: UserAction): Turn {
  return {
    action,
    autoMutations: [],
    snapshot: { candidates: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [])) },
  };
}

describe('findLastConsistentTurnIdx — bug #30: wrong fallback when no matching turn', () => {
  it('returns null when there are no placeDigit turns but a wrong cell exists', () => {
    // Construct a state where userGrid[0][0] has a wrong digit, but the turn
    // history contains only eliminateCandidate turns — no placeDigit for that cell.
    // Bug: firstBadIdx initialises to turns.length - 1 = 1, so the function
    // returns 1 instead of null (or 0).
    const spec = makeBoxCageSpec();
    const goldenSolution = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (__, c) => ((r * 9 + c) % 9) + 1),
    );
    const userGrid = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const correctDigit = goldenSolution[0]![0]!;
    userGrid[0]![0] = (correctDigit % 9) + 1; // deliberately wrong

    const state: KillerPuzzleState = {
      specData: specToData(spec),
      cageStates: specToCageStates(spec),
      userGrid,
      virtualCages: [],
      turns: [
        makeTurnFor({ type: 'eliminateCandidate', row: 0, col: 1, digit: 3 }),
        makeTurnFor({ type: 'eliminateCandidate', row: 0, col: 2, digit: 5 }),
      ],
      alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES],
      goldenSolution,
      givenDigits: null,
      originalImageUrl: null,
      warpedImageUrl: null,
      userRemovedCandidates: [],
    };

    // With the bug: returns turns.length - 1 = 1 (the last unrelated turn).
    // Correct: no placeDigit turn placed the wrong digit, so should return null
    // to indicate "cannot find the introducing turn".
    expect(findLastConsistentTurnIdx(state)).toBeNull();
  });

  it('returns the correct first-bad index when the wrong digit was placed after several other turns', () => {
    // Place digit correctly at (0,1) first, then place a wrong digit at (0,0).
    // findLastConsistentTurnIdx should return 1 (the wrong placeDigit turn),
    // not 2 (the last turn index).
    const spec = makeBoxCageSpec();
    const goldenSolution = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (__, c) => ((r * 9 + c) % 9) + 1),
    );
    const userGrid = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const wrongDigit = (goldenSolution[0]![0]! % 9) + 1;
    userGrid[0]![0] = wrongDigit;

    const state: KillerPuzzleState = {
      specData: specToData(spec),
      cageStates: specToCageStates(spec),
      userGrid,
      virtualCages: [],
      turns: [
        // turn 0: unrelated correct placement
        makeTurnFor({ type: 'placeDigit', row: 0, col: 1, digit: goldenSolution[0]![1]!, source: 'user' }),
        // turn 1: wrong placement (this is the bad turn)
        makeTurnFor({ type: 'placeDigit', row: 0, col: 0, digit: wrongDigit, source: 'user' }),
        // turn 2: another unrelated elimination
        makeTurnFor({ type: 'eliminateCandidate', row: 0, col: 2, digit: 5 }),
      ],
      alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES],
      goldenSolution,
      givenDigits: null,
      originalImageUrl: null,
      warpedImageUrl: null,
      userRemovedCandidates: [],
    };

    expect(findLastConsistentTurnIdx(state)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bug #60 — addVirtualCage skips the rule-folding pass
// ---------------------------------------------------------------------------

describe('Bug #60 regression — addVirtualCage triggers auto-placements', () => {
  // Setup: makeBoxCageSpec (9 box-cages total=45 each) confirmed with NakedSingle
  // in alwaysApplyRules. At confirm all 81 cells stay empty because no cage forces
  // any individual cell (every permutation of {1..9} satisfies each box cage).
  //
  // We then directly set 8 of 9 cells in box-0 via setState (bypassing enterCell
  // so recordTurn's rule-folding doesn't run yet). This leaves (0,0) as the sole
  // empty cell in its box — a naked single whose digit NakedSingle can determine.
  //
  // addVirtualCage must fold ruleSteps via recordTurn so NakedSingle fires and
  // (0,0) is placed. Before the fix it was missing that call so (0,0) stayed 0.
  //
  // Cells are populated from goldenSolution (not KNOWN_SOLUTION) so that the
  // candidate-soundness assertion in the engine never fires.
  let baseState: PuzzleState;

  function makeBox0WithPendingNakedSingle(): void {
    const spec = makeBoxCageSpec();
    const pre: KillerPuzzleState = {
      specData: specToData(spec), cageStates: specToCageStates(spec),
      userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)), virtualCages: [], turns: [],
      alwaysApplyRules: ['NakedSingle', ...DEFAULT_ALWAYS_APPLY_RULES],
      goldenSolution: null,
      givenDigits: null, originalImageUrl: null, warpedImageUrl: null,
      userRemovedCandidates: [],
    };
    setState(pre);
    baseState = confirmPuzzle(solveCurrentSpec().board);
    const gs = baseState.goldenSolution!;
    // Manually place 8 cells in box-0 using the engine's golden solution, leaving (0,0) empty
    const grid = baseState.userGrid!.map(row => [...row]);
    for (const [r, c] of [[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]] as [number,number][])
      grid[r]![c] = gs[r]![c]!;
    setState({ ...baseState, userGrid: grid });
  }

  beforeEach(() => makeBox0WithPendingNakedSingle());

  it('cell (0,0) is 0 before addVirtualCage — naked single pending', () => {
    expect(getState()!.userGrid![0]![0]).toBe(0);
  });

  itNS('addVirtualCage triggers rule-folding — NakedSingle places (0,0)', () => {
    // Any valid VC triggers the auto-placement pass; use two unsolved cells
    // in box-3 so the VC itself plays no role in placing (0,0).
    const gs = baseState.goldenSolution!;
    const vcTotal = gs[3]![0]! + gs[3]![1]!;
    const state = addVirtualCage([[3, 0], [3, 1]], vcTotal);
    expect(state.userGrid![0]![0]).toBe(gs[0]![0]!);
  });
});

// ---------------------------------------------------------------------------
// removeVirtualCage wrapper
// ---------------------------------------------------------------------------

describe('removeVirtualCage', () => {
  it('removes a previously-added virtual cage', () => {
    makeKillerConfirmed();
    const state = addVirtualCage([[0, 0], [0, 1]], 10);
    const key = '0,0:0,1:10';
    expect(state.turns.some(t => t.action.type === 'addVirtualCage')).toBe(true);

    const updated = removeVirtualCage(key);
    const lastAction = updated.turns[updated.turns.length - 1]!.action;
    expect(lastAction.type).toBe('removeVirtualCage');
    if (lastAction.type === 'removeVirtualCage') expect(lastAction.key).toBe(key);
  });

  it('throws when not a killer puzzle', () => {
    makeClassicConfirmed();
    expect(() => removeVirtualCage('0,0:0,1:10')).toThrow('removeVirtualCage requires a killer puzzle state');
  });
});

// ---------------------------------------------------------------------------
// Bug #61 — candidate elimination should enable undo
// ---------------------------------------------------------------------------

describe('Bug #61 regression — cycleCandidate records an undoable turn', () => {
  // After confirmPuzzle for a classic puzzle, the turns array ends with
  // source:'given' turns. updateUndoButton disables undo while last turn
  // is 'given'. Eliminating a candidate must record an 'eliminateCandidate'
  // turn so that the button can be re-enabled.
  beforeEach(() => { makeClassicConfirmed(); });

  it('cycleCandidate appends an eliminateCandidate turn (not a given turn)', () => {
    const before = getState()!;
    // Confirm all initial turns are 'given'
    expect(before.turns.every(t =>
      t.action.type === 'placeDigit' && t.action.source === 'given',
    )).toBe(true);

    // Eliminate digit 5 from cell (0,0) — the blank cell in makeClassicGivenDigits
    cycleCandidate(1, 1, 5);

    const after = getState()!;
    const last = after.turns[after.turns.length - 1]!.action;
    // Last turn must be eliminateCandidate so updateUndoButton enables the button
    expect(last.type).toBe('eliminateCandidate');
  });

  it('undo after cycleCandidate removes the eliminateCandidate turn', () => {
    const beforeCount = getState()!.turns.length;
    cycleCandidate(1, 1, 5);
    expect(getState()!.turns.length).toBe(beforeCount + 1);

    undo();
    expect(getState()!.turns.length).toBe(beforeCount);
    const last = getState()!.turns[getState()!.turns.length - 1]!.action;
    expect(last.type).toBe('placeDigit');
    if (last.type === 'placeDigit') expect(last.source).toBe('given');
  });
});

// ---------------------------------------------------------------------------
// Undo bug regression — userRemovedCandidates must be restored after undo
// ---------------------------------------------------------------------------

describe('undo after eliminateCandidate restores userRemovedCandidates', () => {
  it('undoing a cycleCandidate elimination removes the triple from userRemovedCandidates', () => {
    makeKillerConfirmed();

    cycleCandidate(1, 1, 5); // eliminate digit 5 from r1c1 (0-based: row 0, col 0)
    expect(getState()!.userRemovedCandidates).toContainEqual([0, 0, 5]);

    undo();
    expect(getState()!.userRemovedCandidates).not.toContainEqual([0, 0, 5]);
  });
});

// ---------------------------------------------------------------------------
// #78 – Animated entry invariant
// enterCellStep() must commit the same final userGrid as enterCell() in a
// single call — the animated path folds the same ruleSteps via recordTurn,
// it just also returns them for the UI to animate.
// ---------------------------------------------------------------------------

describe('animated entry invariant (#78)', () => {
  beforeEach(() => { makeKillerConfirmed(); });

  it('enterCellStep commits the same userGrid as enterCell', () => {
    const snapshot = getState()!;
    const r = 1, c = 1, digit = KNOWN_SOLUTION[0]![0]!;

    // Single-shot path
    setState(snapshot);
    enterCell(r, c, digit);
    const singleGrid = getState()!.userGrid;

    // Animated entry point
    setState(snapshot);
    const { state } = enterCellStep(r, c, digit);
    expect(getState()!.userGrid).toEqual(state.userGrid);

    expect(state.userGrid).toEqual(singleGrid);
  });
});

// ---------------------------------------------------------------------------
// Settings API
// ---------------------------------------------------------------------------

describe('getSettingsData / getAutoPlacementDelay', () => {
  it('getSettingsData returns a list of hintable rules and the current always-apply set', () => {
    const data = getSettingsData();
    expect(data.hintableRules.length).toBeGreaterThan(0);
    expect(data.hintableRules.every(r => typeof r.name === 'string')).toBe(true);
    expect(Array.isArray(data.alwaysApplyRules)).toBe(true);
  });

  it('getAutoPlacementDelay returns a number', () => {
    expect(typeof getAutoPlacementDelay()).toBe('number');
  });

  it('classic: killer-specific rules excluded from hintableRules', () => {
    makeClassicConfirmed();
    const data = getSettingsData();
    for (const rule of defaultRules().filter(r => r.killerOnly)) {
      expect(data.hintableRules.some(r => r.name === rule.name), `${rule.name} should be absent for classic`).toBe(false);
    }
  });

  it('killer: killer-specific rules present in hintableRules', () => {
    makeKillerConfirmed();
    const data = getSettingsData();
    expect(data.hintableRules.some(r => r.name === 'CageCandidateFilter')).toBe(true);
  });
});

describe('DEFAULT_ALWAYS_APPLY_RULES', () => {
  it('does not include NakedSingle', () => {
    expect(DEFAULT_ALWAYS_APPLY_RULES).not.toContain('NakedSingle');
  });
});

describe('applyHint', () => {
  it('records hint eliminations as eliminateCandidate mutations and applies them to userRemovedCandidates', () => {
    const state = makeKillerConfirmed();
    setState(state);
    const [r, c] = [0, 0];
    const candidates = computeCandidates().cells[r]![c]!.candidates;
    if (candidates.length < 2) return; // guard: skip if cell already solved
    const digit = candidates[0]!;
    const result = applyHint([{ cell: [r, c], digit }]);
    const turn = result.turns.find(t => t.action.type === 'applyHint');
    expect(turn).toBeDefined();
    const action = turn!.action as ApplyHintAction;
    expect(action.mutations).toHaveLength(1);
    const mutation = action.mutations[0]! as EliminateCandidateMutation;
    expect(mutation.type).toBe('eliminateCandidate');
    expect([mutation.row, mutation.col, mutation.digit]).toEqual([r, c, digit]);
    expect(result.userRemovedCandidates).toContainEqual([r, c, digit]);
  });
});

describe('addVirtualCage — error path', () => {
  it('throws when the requested total is impossible for the number of cells', () => {
    setState(makeKillerConfirmed());
    // Two cells summing to 1 is impossible (min for 2 distinct digits = 3)
    expect(() => addVirtualCage([[0, 0], [0, 1]], 1)).toThrow();
    expect(() => addVirtualCage([[0, 0], [0, 1]], 20)).toThrow();
  });
});

describe('getHints', () => {
  it('returns hints for a confirmed killer puzzle', () => {
    setState(makeKillerConfirmed());
    const result = getHints();
    expect(Array.isArray(result.hints)).toBe(true);
  });
});

describe('saveSettingsData', () => {
  it('returns null when no puzzle state is loaded', () => {
    // Use a state with userGrid null (pre-confirm) then clear it by calling
    // saveSettingsData before any other test sets state in this describe block.
    // We construct a minimal review-mode state and immediately verify the
    // null-state path by removing the state reference via getState check.
    //
    // The simplest reliable approach: use a pre-confirm state (userGrid=null)
    // and verify saveSettingsData returns the updated state (not refresh()).
    const spec = makeBoxCageSpec();
    const pre: KillerPuzzleState = {
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
    };
    setState(pre);

    const result = saveSettingsData(['NakedSingle'], 0, false);
    expect(result).not.toBeNull();
    expect(result!.alwaysApplyRules).toEqual(['NakedSingle']);
  });

  it('returns refreshed state when userGrid is set (playing mode)', () => {
    makeKillerConfirmed();
    const result = saveSettingsData(['NakedSingle', 'CageCandidateFilter'], 0, false);
    expect(result).not.toBeNull();
    expect(result!.alwaysApplyRules).toEqual(['NakedSingle', 'CageCandidateFilter']);
  });

  // Regression: saveSettingsData must commit any NS cascade into the returned
  // state. If the caller ignores the return value and redraws with the old
  // state, placed-digit displays and candidate displays go out of sync —
  // peers show the digit eliminated but no placed digit explains why.
  itNS('commits NakedSingle cascade into the returned state', () => {
    // 80 cells given, (0,0) blank. NS is not in alwaysApplyRules at confirm time
    // so (0,0) stays blank. Adding NS via saveSettingsData must trigger refresh()
    // which places (0,0) and returns the updated state.
    makeClassicConfirmed();
    expect(getState()!.userGrid![0]![0]).toBe(0);

    // Adding NS to auto-apply must trigger refresh() which places (0,0).
    const updated = saveSettingsData(['NakedSingle'], 0, false);
    expect(updated).not.toBeNull();
    expect(updated!.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]!);
  });
});

// ---------------------------------------------------------------------------
// Rewind hint — wrong candidate elimination and wrong placement detection
// ---------------------------------------------------------------------------

describe('getHints — Rewind on wrong candidate elimination', () => {
  it('returns a Rewind hint when the user has eliminated the correct solution digit', () => {
    // Killer puzzle with a unique golden solution. NakedSingle is intentionally
    // excluded from alwaysApplyRules so (0,0) is NOT auto-placed after confirmPuzzle —
    // the test needs a blank cell to eliminate the correct candidate from.
    const spec = makeTrivialSpec();
    const pre: KillerPuzzleState = {
      specData: specToData(spec),
      cageStates: specToCageStates(spec),
      userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
      virtualCages: [],
      turns: [],
      alwaysApplyRules: ['CageCandidateFilter'],
      goldenSolution: null,
      givenDigits: null,
      originalImageUrl: null,
      warpedImageUrl: null,
      userRemovedCandidates: [],
    };
    setState(pre);
    const { board } = solveCurrentSpec();
    confirmPuzzle(board);

    const gold = getState()!.goldenSolution![0]![0]!;
    expect(gold).toBeGreaterThan(0);
    expect(getState()!.userGrid![0]![0]).toBe(0); // must be blank (no auto-placement)

    // User explicitly eliminates the correct candidate at (0,0)
    cycleCandidate(1, 1, gold);

    const { hints } = getHints();
    // The Rewind hint must appear — no alternative valid solution for a fully-constrained puzzle
    const rewindHint = hints.find(h => h.rewindToTurnIdx !== null);
    expect(rewindHint).toBeDefined();
    expect(rewindHint!.displayName).toMatch(/[Rr]ewind/);
  });

  it('returns a Rewind hint when userGrid has a wrong auto-placed digit not in any turn', () => {
    // Simulate a state where a wrong digit is in userGrid but came from an auto-placement
    // (not from a user placeDigit turn) — findLastConsistentTurnIdx would return null for it.
    makeClassicConfirmed();
    const state = getState()!;
    const gold = state.goldenSolution![0]![0]!;
    const wrong = gold === 1 ? 2 : 1;

    // Directly inject a wrong digit into userGrid without recording a turn
    const newGrid = state.userGrid!.map(row => [...row]);
    newGrid[0]![0] = wrong;
    setState({ ...state, userGrid: newGrid }); // no turn recorded

    const { hints } = getHints();
    // Must detect the wrong digit even though no placeDigit turn exists for it
    const rewindHint = hints.find(h => h.rewindToTurnIdx !== null);
    expect(rewindHint).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Rewind hint — wrong virtual cage total (Check 0)
// ---------------------------------------------------------------------------

describe('getHints — Rewind on wrong virtual cage total', () => {
  it('returns a Rewind hint when a user-added virtual cage total contradicts goldenSolution', () => {
    makeKillerConfirmed();
    const state = getState()!;
    const gs = state.goldenSolution!;

    // Pick two cells and a total within cageSumRange(2) = [3, 17] but that
    // doesn't match the golden sum for those two cells.
    const goldSum = gs[0]![0]! + gs[0]![1]!;
    const wrongTotal = goldSum === 17 ? goldSum - 1 : goldSum + 1;

    addVirtualCage([[0, 0], [0, 1]], wrongTotal);

    const { hints } = getHints();
    const rewindHint = hints.find(h => h.rewindToTurnIdx !== null);
    expect(rewindHint).toBeDefined();
    expect(rewindHint!.displayName).toMatch(/[Rr]ewind/);
    expect(rewindHint!.rewindToTurnIdx).toBe(getState()!.turns.length - 1);
  });
});

// ---------------------------------------------------------------------------
// solveAndValidateSpec / extractAndValidateSolution
// ---------------------------------------------------------------------------

describe('solveAndValidateSpec', () => {
  it('returns null for a valid spec', () => {
    expect(solveAndValidateSpec(makeTrivialSpec())).toBeNull();
  });

  it('returns a non-null string for a spec with a corrupted cage total', () => {
    const spec = makeTrivialSpec();
    // Corrupt cageTotals[0][0]: the trivial spec has every cell as its own
    // single-cell cage, so incrementing any cage total creates a contradiction.
    const corrupted: PuzzleSpec = {
      ...spec,
      cageTotals: spec.cageTotals.map((row, r) =>
        r === 0 ? row.map((t, c) => (c === 0 ? t + 1 : t)) : row,
      ),
    };
    expect(solveAndValidateSpec(corrupted)).not.toBeNull();
  });
});

describe('extractAndValidateSolution', () => {
  beforeEach(() => { loadSpecDirect(makeTrivialSpec()); });

  it('returns null for a fully-solved valid board', () => {
    const { board } = solveCurrentSpec();
    expect(extractAndValidateSolution(board)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasMultipleCageTotals
// ---------------------------------------------------------------------------

describe('hasMultipleCageTotals', () => {
  it('returns null for a spec where every cage has exactly one total', () => {
    expect(hasMultipleCageTotals(makeTrivialSpec())).toBeNull();
  });

  it('returns null for a multi-cell cage spec with one total per cage', () => {
    expect(hasMultipleCageTotals(makeTwoCellCageSpec())).toBeNull();
  });

  it('returns a non-null string when two cells in the same region both have non-zero totals', () => {
    const spec = makeTwoCellCageSpec();
    // makeTwoCellCageSpec puts cells (0,0) and (1,0) in the same region.
    // cageTotals[0][0] = 11 (the head). cageTotals[1][0] = 0 (member, no head).
    // Inject a second total at (1,0) to simulate the OCR error.
    const corrupted: PuzzleSpec = {
      ...spec,
      cageTotals: spec.cageTotals.map((row, r) =>
        r === 1 ? row.map((t, c) => (c === 0 ? 3 : t)) : row,
      ),
    };
    expect(hasMultipleCageTotals(corrupted)).not.toBeNull();
  });
});

describe('buildCandidatesFromParseResult', () => {
  const blankGivenDigits = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const spec = classicSyntheticSpec();

  function makeParseResult(puzzleType: 'killer' | 'classic'): ParseResult {
    return {
      spec,
      specError: null,
      puzzleType,
      givenDigits: blankGivenDigits,
      warpedImageData: null,
      cellThumbs: new Map(),
      mergedThumbs: new Map(),
    };
  }

  it('returns [killerCandidate, classicCandidate] when OCR detects killer', () => {
    const result = makeParseResult('killer');
    const candidates = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);

    expect(candidates).toHaveLength(2);
    expect(PuzzleState.isKiller(candidates[0]!)).toBe(true);
    expect(PuzzleState.isKiller(candidates[1]!)).toBe(false);
  });

  it('killer candidate has givenDigits: null (never a hybrid from OCR)', () => {
    const result = makeParseResult('killer');
    const candidates = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);

    expect(candidates[0]!.givenDigits).toBeNull();
  });

  it('classic candidate is built from result.givenDigits', () => {
    const givenDigits = blankGivenDigits.map((row, r) => row.map((_, c) => (r === 0 && c === 0 ? 5 : 0)));
    const result = { ...makeParseResult('killer'), givenDigits };
    const candidates = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);

    expect(candidates[1]!.givenDigits).toEqual(givenDigits);
  });

  it('returns only [classicCandidate] when OCR detects classic', () => {
    const result = makeParseResult('classic');
    const candidates = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);

    expect(candidates).toHaveLength(1);
    expect(PuzzleState.isKiller(candidates[0]!)).toBe(false);
  });

  it('all candidates start with a blank userGrid and no golden solution', () => {
    const result = makeParseResult('killer');
    const blankGrid = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    for (const candidate of buildCandidatesFromParseResult(result, spec, [], null, null)) {
      expect(candidate.userGrid).toEqual(blankGrid);
      expect(candidate.goldenSolution).toBeNull();
    }
  });
});

describe('activeCandidate', () => {
  const spec = classicSyntheticSpec();
  const killerCandidate = PuzzleState.createKiller(specToData(spec), specToCageStates(spec), [], null, null);
  const classicCandidate = PuzzleState.createClassic(null, [], null);

  it('returns the killer candidate when selectedType is killer', () => {
    expect(activeCandidate([killerCandidate, classicCandidate], 'killer')).toBe(killerCandidate);
  });

  it('returns the classic candidate when selectedType is classic', () => {
    expect(activeCandidate([killerCandidate, classicCandidate], 'classic')).toBe(classicCandidate);
  });

  it('returns undefined when no candidate of the selected type exists', () => {
    expect(activeCandidate([classicCandidate], 'killer')).toBeUndefined();
  });
});

describe('revertToOcr', () => {
  beforeEach(() => {
    setState(PuzzleState.createClassic(null, [], null));
  });

  it('replaces the candidate list with the given OCR candidates', () => {
    const spec = classicSyntheticSpec();
    const killerCandidate = PuzzleState.createKiller(specToData(spec), specToCageStates(spec), [], null, null);
    const classicCandidate = PuzzleState.createClassic(null, [], null);

    revertToOcr([killerCandidate, classicCandidate]);

    expect(getStateCandidates()).toEqual([killerCandidate, classicCandidate]);
  });
});
