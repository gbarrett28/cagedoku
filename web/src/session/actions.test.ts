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
import { setState, getState } from './store.js';
import {
  confirmPuzzle,
  solveCurrentSpec,
  enterCell,
  undo,
  computeCandidates,
  cycleCandidate,
} from './actions.js';
import { findLastConsistentTurnIdx } from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import {
  makeBoxCageSpec,
  makeClassicGivenDigits,
  KNOWN_SOLUTION,
} from '../engine/fixtures.js';
import { specToData, specToCageStates } from './specUtils.js';
import type { PuzzleState, Turn, UserAction } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClassicState(givenDigits: number[][]): PuzzleState {
  // Build the same dummy spec that loadClassicDirect uses
  const borderX = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false));
  const borderY = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));
  const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  cageTotals[0]![0] = 1;
  const regions = Array.from({ length: 9 }, () => new Array<number>(9).fill(1));
  const spec = { regions, cageTotals, borderX, borderY };
  const state: PuzzleState = {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid: null,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES],
    goldenSolution: null,
    puzzleType: 'classic',
    givenDigits,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
  setState(state);
  return state;
}

function makeKillerConfirmed(): PuzzleState {
  const spec = makeBoxCageSpec();
  const pre: PuzzleState = {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid: null,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES],
    goldenSolution: null,
    puzzleType: 'killer',
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
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
    // After CellSolutionElimination propagation only digit 5 should remain.
    const data = computeCandidates();
    const cell = data.cells[0]![0]!;
    expect(cell.candidates).toEqual([5]);
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
    // Box-cage spec: (row=0,col=0) starts empty. Place digit 5 there.
    enterCell(1, 1, 5);
    const cands = computeCandidates();
    // (row=0,col=3) is a row peer but in a different box — must not contain 5.
    expect(cands.cells[0]![3]!.candidates).not.toContain(5);
    // (row=0,col=8) is also a row peer at the far end of the grid.
    expect(cands.cells[0]![8]!.candidates).not.toContain(5);
  });

  it('placed digit absent from column peers', () => {
    enterCell(1, 1, 5);
    const cands = computeCandidates();
    // (row=4,col=0) is a col peer in a different box.
    expect(cands.cells[4]![0]!.candidates).not.toContain(5);
  });

  it('placed digit absent from box peers', () => {
    enterCell(1, 1, 5);
    const cands = computeCandidates();
    // (row=1,col=1) is a box peer (box 0: rows 0–2, cols 0–2).
    expect(cands.cells[1]![1]!.candidates).not.toContain(5);
    // (row=2,col=2) is another box peer.
    expect(cands.cells[2]![2]!.candidates).not.toContain(5);
  });

  it('two placed digits both absent from shared peer', () => {
    // Place 5 at (0,0) and 3 at (0,1) — both in row 0.
    enterCell(1, 1, 5);
    enterCell(1, 2, 3);
    const cands = computeCandidates();
    // (row=0,col=5) is a row peer of both placements.
    expect(cands.cells[0]![5]!.candidates).not.toContain(5);
    expect(cands.cells[0]![5]!.candidates).not.toContain(3);
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
// #24 – CellSolutionElimination mandatory for Classic mode
//
// If the user removes CellSolutionElimination from alwaysApplyRules (via Config),
// Classic candidates must still be correct because buildEngine forces the rule on.
// ---------------------------------------------------------------------------

describe('computeCandidates — CellSolutionElimination mandatory in Classic (#24)', () => {
  it('given digits eliminate peers even when CellSolutionElimination is removed from alwaysApplyRules', () => {
    const givenDigits = makeClassicGivenDigits(); // KNOWN_SOLUTION with (0,0) blanked
    makeClassicState(givenDigits);

    // Simulate user disabling CellSolutionElimination in Config.
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

    // Simulate user disabling CellSolutionElimination, then placing a digit.
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

    const state: PuzzleState = {
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
      puzzleType: 'killer',
      givenDigits: null,
      originalImageUrl: null,
      warpedImageUrl: null,
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

    const state: PuzzleState = {
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
      puzzleType: 'killer',
      givenDigits: null,
      originalImageUrl: null,
      warpedImageUrl: null,
    };

    expect(findLastConsistentTurnIdx(state)).toBe(1);
  });
});
