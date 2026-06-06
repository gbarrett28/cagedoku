/**
 * Tests for the rule-by-rule auto-apply session helpers:
 *   - applyAutoApplyStep
 *   - getNextAutoApplyStep
 *   - buildEngine applying autoRemovedCandidates
 *
 * All tests are RED until the feature is implemented.
 */

import { describe, expect, it } from 'vitest';
import { makeTrivialSpec, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates } from './specUtils.js';
import {
  buildEngine,
  getNextAutoApplyStep,
  applyAutoApplyStep,
} from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import type { PuzzleState } from './types.js';
import type { Cell } from '../engine/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBaseState(): PuzzleState {
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
    userRemovedCandidates: [],
  };
}

/** 80 cells placed; NakedSingle will deduce (0,0). */
function makeAlmostCompleteState(): PuzzleState {
  const spec = makeTrivialSpec();
  const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
  userGrid[0]![0] = 0;
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
    userRemovedCandidates: [],
  };
}

// ---------------------------------------------------------------------------
// buildEngine — autoRemovedCandidates
// ---------------------------------------------------------------------------

describe('buildEngine with userRemovedCandidates', () => {
  it('applies userRemovedCandidates as candidate eliminations before solve', () => {
    const state: PuzzleState = {
      ...makeBaseState(),
      userRemovedCandidates: [[0, 0, 5]] as [number, number, number][],
    };
    const { board } = buildEngine(state);
    expect(board.candidates[0]![0]!.has(5)).toBe(false);
  });

  it('does not affect the board when userRemovedCandidates is empty', () => {
    const { board: boardEmpty } = buildEngine(makeBaseState());
    const { board: boardDefault } = buildEngine({
      ...makeBaseState(),
      userRemovedCandidates: [],
    });
    expect(boardEmpty.candidates[0]![0]!.size).toBe(boardDefault.candidates[0]![0]!.size);
  });
});

// ---------------------------------------------------------------------------
// applyAutoApplyStep
// ---------------------------------------------------------------------------

describe('applyAutoApplyStep', () => {
  it('places a digit in userGrid for a placement in the step', () => {
    const state = makeBaseState();
    const step = {
      ruleName: 'TestRule',
      displayName: 'Test Rule',
      highlightCells: [[0, 0]] as Cell[],
      eliminations: [],
      placements: [{ cell: [0, 0] as Cell, digit: 5 }],
    };
    const next = applyAutoApplyStep(state, step);
    expect(next.userGrid![0]![0]).toBe(5);
  });

  it('accumulates eliminations in autoRemovedCandidates', () => {
    const state = makeBaseState();
    const step = {
      ruleName: 'TestRule',
      displayName: 'Test Rule',
      highlightCells: [[1, 2]] as Cell[],
      eliminations: [{ cell: [1, 2] as Cell, digit: 7 }],
      placements: [],
    };
    const next = applyAutoApplyStep(state, step);
    expect(next.userRemovedCandidates).toContainEqual([1, 2, 7]);
  });

  it('appends to existing autoRemovedCandidates', () => {
    const state: PuzzleState = {
      ...makeBaseState(),
      userRemovedCandidates: [[3, 4, 9]] as [number, number, number][],
    };
    const step = {
      ruleName: 'TestRule',
      displayName: 'Test Rule',
      highlightCells: [],
      eliminations: [{ cell: [1, 1] as Cell, digit: 5 }],
      placements: [],
    };
    const next = applyAutoApplyStep(state, step);
    expect(next.userRemovedCandidates).toContainEqual([3, 4, 9]);
    expect(next.userRemovedCandidates).toContainEqual([1, 1, 5]);
  });

  it('does not mutate the original state', () => {
    const state = makeBaseState();
    const original = state.userGrid![0]![0];
    applyAutoApplyStep(state, {
      ruleName: 'R',
      displayName: 'R',
      highlightCells: [],
      eliminations: [],
      placements: [{ cell: [0, 0] as Cell, digit: 7 }],
    });
    expect(state.userGrid![0]![0]).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// getNextAutoApplyStep
// ---------------------------------------------------------------------------

describe('getNextAutoApplyStep', () => {
  it('returns null when userGrid is null (unconfirmed state)', () => {
    const state = { ...makeBaseState(), userGrid: null };
    expect(getNextAutoApplyStep(state)).toBeNull();
  });

  it('returns a non-null step with real changes on a board that can deduce (0,0)', () => {
    const state = makeAlmostCompleteState();
    const step = getNextAutoApplyStep(state);
    expect(step).not.toBeNull();
    // The step must have at least one real change (placement or elimination)
    expect(step!.placements.length + step!.eliminations.length).toBeGreaterThan(0);
  });

  it('eventually places the correct digit in (0,0) through step-by-step application', () => {
    // The trivial spec may require several rule steps before (0,0) is placed:
    // CageCandidateFilter narrows (0,0) first, then NakedSingle places it.
    let state = makeAlmostCompleteState();
    let placed = false;
    for (let iter = 0; iter < 20; iter++) {
      const step = getNextAutoApplyStep(state);
      if (step === null) break;
      state = applyAutoApplyStep(state, step);
      if (state.userGrid![0]![0] !== 0) { placed = true; break; }
    }
    expect(placed).toBe(true);
    expect(state.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]!);
  });

  it('terminates (returns null) after all deducible steps have been applied', () => {
    let state = makeAlmostCompleteState();
    for (let iter = 0; iter < 50; iter++) {
      const step = getNextAutoApplyStep(state);
      if (step === null) break;
      state = applyAutoApplyStep(state, step);
    }
    // After exhausting all steps, next call must return null
    expect(getNextAutoApplyStep(state)).toBeNull();
  });

  it('never re-produces a step whose eliminations are already in autoRemovedCandidates', () => {
    // Each applyAutoApplyStep accumulates eliminations. The next solver run must
    // see them via buildEngine → not re-produce them as a new step.
    let state = makeAlmostCompleteState();
    const seen = new Set<string>();
    for (let iter = 0; iter < 50; iter++) {
      const step = getNextAutoApplyStep(state);
      if (step === null) break;
      // Encode the step to detect infinite loops
      const key = `${step.ruleName}:${step.eliminations.map(e => `${e.cell[0]},${e.cell[1]},${e.digit}`).join('|')}:${step.placements.map(p => `${p.cell[0]},${p.cell[1]},${p.digit}`).join('|')}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      state = applyAutoApplyStep(state, step);
    }
  });
});
