/**
 * Tests for the rule-by-rule auto-apply session helpers:
 *   - applyAutoApplyStep
 *   - getNextAutoApplyStep
 *   - buildEngine applying userRemovedCandidates
 *
 * All tests are RED until the feature is implemented.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTrivialSpec, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates } from './specUtils.js';
import {
  buildEngine,
  getNextAutoApplyStep,
  applyAutoApplyStep,
  applyRuleSteps,
} from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import { RuleMutation } from './ruleMutation.js';
import type { KillerPuzzleState, PuzzleState } from './types.js';
import type { Cell } from '../engine/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBaseState(): KillerPuzzleState {
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
  };
}

/** 80 cells placed; NakedSingle will deduce (0,0). */
function makeAlmostCompleteState(): KillerPuzzleState {
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
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
  };
}

// ---------------------------------------------------------------------------
// buildEngine — ruleSteps and validationContext
// ---------------------------------------------------------------------------

describe('buildEngine — ruleSteps', () => {
  it('folding all ruleSteps mutations onto state places the deduced digit', () => {
    const state = makeAlmostCompleteState();
    const { ruleSteps } = buildEngine(state);
    expect(ruleSteps.length).toBeGreaterThan(0);

    let folded: PuzzleState = state;
    for (const step of ruleSteps) {
      expect(step.mutations.length).toBeGreaterThan(0);
      for (const mutation of step.mutations) folded = mutation.apply(folded);
    }
    expect(folded.userGrid[0]![0]).toBe(KNOWN_SOLUTION[0]![0]!);
  });

  it('each ruleStep has a non-empty displayName and highlightCells', () => {
    const state = makeAlmostCompleteState();
    const { ruleSteps } = buildEngine(state);
    expect(ruleSteps.length).toBeGreaterThan(0);
    for (const step of ruleSteps) {
      expect(step.displayName.length).toBeGreaterThan(0);
      expect(step.highlightCells.length).toBeGreaterThan(0);
    }
  });
});

describe('buildEngine — validationContext', () => {
  it('is null when goldenSolution is null', () => {
    const { validationContext } = buildEngine(makeBaseState());
    expect(validationContext).toBeNull();
  });

  it('carries rules/golden/spec when goldenSolution is present and board is not corrupted', () => {
    const state = makeAlmostCompleteState();
    const { validationContext } = buildEngine(state);
    expect(validationContext).not.toBeNull();
    expect(validationContext!.golden).toEqual(state.goldenSolution);
    expect(validationContext!.rules.length).toBeGreaterThan(0);
    expect(validationContext!.spec).not.toBeNull();
  });

  it('is null when the board is user-corrupted', () => {
    const state = makeAlmostCompleteState();
    const wrong = KNOWN_SOLUTION[0]![1]! === 1 ? 2 : 1;
    const userGrid = state.userGrid.map(row => [...row]);
    userGrid[0]![1] = wrong;
    const { validationContext } = buildEngine({ ...state, userGrid });
    expect(validationContext).toBeNull();
  });
});

describe('buildEngine — skipValidation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not schedule trigger validation when skipValidation is true', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const state = makeAlmostCompleteState();
    const { validationContext } = buildEngine(state, { skipValidation: true });
    expect(validationContext).not.toBeNull();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('schedules trigger validation by default when validationContext is non-null', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const state = makeAlmostCompleteState();
    const { validationContext } = buildEngine(state);
    expect(validationContext).not.toBeNull();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// buildEngine — userRemovedCandidates
// ---------------------------------------------------------------------------

describe('buildEngine with userRemovedCandidates', () => {
  it('applies userRemovedCandidates as candidate eliminations before solve', () => {
    const state: KillerPuzzleState = {
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
// applyRuleSteps
// ---------------------------------------------------------------------------

describe('applyRuleSteps', () => {
  it('folds all ruleStep mutations onto state and is idempotent', () => {
    const state = makeAlmostCompleteState();
    const { state: once, ruleSteps: firstSteps } = applyRuleSteps(state);
    expect(firstSteps.length).toBeGreaterThan(0);
    expect(once.userGrid[0]![0]).toBe(KNOWN_SOLUTION[0]![0]!);

    const { state: twice, ruleSteps: secondSteps } = applyRuleSteps(once);
    expect(secondSteps).toEqual([]);
    expect(twice).toEqual(once);
  });

  it('on a base state, folding CageCandidateFilter eliminations is idempotent', () => {
    const state = makeBaseState();
    const { state: once, ruleSteps: firstSteps } = applyRuleSteps(state);
    expect(firstSteps.length).toBeGreaterThan(0);

    const { state: twice, ruleSteps: secondSteps } = applyRuleSteps(once);
    expect(secondSteps).toEqual([]);
    expect(twice).toEqual(once);
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
      mutations: [RuleMutation.placeDigit(0, 0, 5)],
    };
    const next = applyAutoApplyStep(state, step);
    expect(next.userGrid![0]![0]).toBe(5);
  });

  it('accumulates eliminations in userRemovedCandidates', () => {
    const state = makeBaseState();
    const step = {
      ruleName: 'TestRule',
      displayName: 'Test Rule',
      highlightCells: [[1, 2]] as Cell[],
      mutations: [RuleMutation.eliminateCandidate(1, 2, 7)],
    };
    const next = applyAutoApplyStep(state, step);
    expect(next.userRemovedCandidates).toContainEqual([1, 2, 7]);
  });

  it('appends to existing userRemovedCandidates', () => {
    const state: KillerPuzzleState = {
      ...makeBaseState(),
      userRemovedCandidates: [[3, 4, 9]] as [number, number, number][],
    };
    const step = {
      ruleName: 'TestRule',
      displayName: 'Test Rule',
      highlightCells: [],
      mutations: [RuleMutation.eliminateCandidate(1, 1, 5)],
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
      mutations: [RuleMutation.placeDigit(0, 0, 7)],
    });
    expect(state.userGrid![0]![0]).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// getNextAutoApplyStep
// ---------------------------------------------------------------------------

describe('getNextAutoApplyStep', () => {
  it('returns null when goldenSolution is null (unconfirmed state)', () => {
    expect(getNextAutoApplyStep(makeBaseState())).toBeNull();
  });

  it('returns a non-null step with real changes on a board that can deduce (0,0)', () => {
    const state = makeAlmostCompleteState();
    const step = getNextAutoApplyStep(state);
    expect(step).not.toBeNull();
    // The step must have at least one real change (placement or elimination)
    expect(step!.mutations.length).toBeGreaterThan(0);
  });

  it('eventually places the correct digit in (0,0) through step-by-step application', () => {
    // The trivial spec may require several rule steps before (0,0) is placed:
    // CageCandidateFilter narrows (0,0) first, then NakedSingle places it.
    let state: PuzzleState = makeAlmostCompleteState();
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
    let state: PuzzleState = makeAlmostCompleteState();
    for (let iter = 0; iter < 50; iter++) {
      const step = getNextAutoApplyStep(state);
      if (step === null) break;
      state = applyAutoApplyStep(state, step);
    }
    // After exhausting all steps, next call must return null
    expect(getNextAutoApplyStep(state)).toBeNull();
  });

  it('never re-produces a step whose eliminations are already in userRemovedCandidates', () => {
    // Each applyAutoApplyStep accumulates eliminations. The next solver run must
    // see them via buildEngine → not re-produce them as a new step.
    let state: PuzzleState = makeAlmostCompleteState();
    const seen = new Set<string>();
    for (let iter = 0; iter < 50; iter++) {
      const step = getNextAutoApplyStep(state);
      if (step === null) break;
      // Encode the step to detect infinite loops
      const key = `${step.ruleName}:${step.mutations.map(m => JSON.stringify(m)).join('|')}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      state = applyAutoApplyStep(state, step);
    }
  });
});
