/**
 * Regression tests for session/actions.ts.
 *
 * Covers the bugs fixed in the review sprint:
 *   #13 – Classic candidates always empty
 *   #14 – findLastConsistentTurnIdx always returns non-null
 *   #16 – Undo button never enables after placing a digit in classic mode
 *   #17 – Reveal uses stale solvePuzzle() instead of cached goldenSolution
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setState, getState } from './store.js';
import {
  confirmPuzzle,
  solveCurrentSpec,
  enterCell,
  undo,
  computeCandidates,
} from './actions.js';
import { findLastConsistentTurnIdx } from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import {
  makeBoxCageSpec,
  makeClassicGivenDigits,
  KNOWN_SOLUTION,
} from '../engine/fixtures.js';
import { specToData, specToCageStates } from './specUtils.js';
import type { PuzzleState } from './types.js';

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
