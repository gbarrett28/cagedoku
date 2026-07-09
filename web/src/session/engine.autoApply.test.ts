/**
 * Tests for the rule-step folding helpers:
 *   - applyRuleSteps
 *   - buildEngine applying userRemovedCandidates
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTrivialSpec, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates } from './specUtils.js';
import {
  buildEngine,
  applyRuleSteps,
} from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import type { KillerPuzzleState, PuzzleState } from './types.js';

// Skip while either cage-solution-feasibility rule is disabled (e.g. after
// sync-rule-fixtures adds it to DISABLED_RULES) — this test depends on
// CageCandidateFilter eliminations being produced.
const itCageSolns = (DISABLED_RULES.includes('CageCandidateFilter') || DISABLED_RULES.includes('SolutionMapFilter'))
  ? it.skip : it;

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

  it('carries rules/golden when goldenSolution is present and board is not corrupted', () => {
    const state = makeAlmostCompleteState();
    const { validationContext } = buildEngine(state);
    expect(validationContext).not.toBeNull();
    expect(validationContext!.golden).toEqual(state.goldenSolution);
    expect(validationContext!.rules.length).toBeGreaterThan(0);
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

  itCageSolns('CageCandidateFilter eliminations are not persisted in userRemovedCandidates (#162)', () => {
    // Solver-derived EliminateCandidateMutation must be filtered out by applyRuleSteps
    // and NOT written to userRemovedCandidates. Previously the fold included all
    // mutations, so cage-filter eliminations accumulated in userRemovedCandidates and
    // appeared as phantom strikethrough candidates. The fix: only PlaceDigitMutation
    // and cage-level mutations are persisted; EliminateCandidateMutation is re-derived
    // on each buildEngine call.
    const state = makeBaseState();
    const { state: once, ruleSteps: firstSteps } = applyRuleSteps(state);
    expect(firstSteps.length).toBeGreaterThan(0);
    expect(once.userRemovedCandidates).toEqual([]);
  });
});

