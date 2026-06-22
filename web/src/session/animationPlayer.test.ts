/**
 * Tests for the AnimationPlayer module — pure-data navigation over a
 * buildEngine() ruleSteps list. See
 * docs/superpowers/specs/2026-06-12-animation-player-design.md.
 */

import { describe, expect, it } from 'vitest';
import { makeTrivialSpec, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates } from './specUtils.js';
import { buildEngine } from './engine.js';
import { computeAnimationCandidates } from './actions.js';
import { AnimationPlayer } from './animationPlayer.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import type { KillerPuzzleState, PuzzleState } from './types.js';
import type { RuleStep } from './ruleMutation.js';

/** 80 cells placed; NakedSingle will deduce (0,0) — same fixture as engine.autoApply.test.ts. */
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

/** Returns a baseState with a non-empty ruleSteps list from a real buildEngine() solve. */
function setup(): { baseState: PuzzleState; ruleSteps: readonly RuleStep[] } {
  const baseState = makeAlmostCompleteState();
  const { ruleSteps } = buildEngine(baseState);
  expect(ruleSteps.length).toBeGreaterThan(0);
  return { baseState, ruleSteps };
}

describe('AnimationPlayer.stateAtCursor', () => {
  it('returns baseState unchanged when cursor is 0', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: false };
    expect(AnimationPlayer.stateAtCursor(player)).toEqual(baseState);
  });

  it('folds only the first step for cursor === 1', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 1, playing: false };
    let expected: PuzzleState = baseState;
    for (const mutation of ruleSteps[0]!.mutations) expected = mutation.apply(expected);
    expect(AnimationPlayer.stateAtCursor(player)).toEqual(expected);
  });

  it('folds all ruleSteps mutations when cursor === ruleSteps.length', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: ruleSteps.length, playing: false };
    let expected: PuzzleState = baseState;
    for (const step of ruleSteps) {
      for (const mutation of step.mutations) expected = mutation.apply(expected);
    }
    expect(AnimationPlayer.stateAtCursor(player)).toEqual(expected);
  });
});

describe('AnimationPlayer.boardAtCursor', () => {
  it('matches computeAnimationCandidates(stateAtCursor(player))', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 1, playing: false };
    const expected = computeAnimationCandidates(AnimationPlayer.stateAtCursor(player));
    expect(AnimationPlayer.boardAtCursor(player)).toEqual(expected);
  });
});

describe('AnimationPlayer.currentStep', () => {
  it('returns ruleSteps[cursor] mid-list', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: false };
    expect(AnimationPlayer.currentStep(player)).toBe(ruleSteps[0]);
  });

  it('returns null when cursor === ruleSteps.length', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: ruleSteps.length, playing: false };
    expect(AnimationPlayer.currentStep(player)).toBeNull();
  });
});

describe('AnimationPlayer.rewind', () => {
  it('resets cursor to 0 and playing to false when cursor > 0', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 1, playing: true };
    expect(AnimationPlayer.rewind(player)).toEqual({ ...player, cursor: 0, playing: false });
  });

  it('returns null when cursor === 0', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: true };
    expect(AnimationPlayer.rewind(player)).toBeNull();
  });
});

describe('AnimationPlayer.stepBack', () => {
  it('decrements cursor and sets playing to false', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 1, playing: true };
    expect(AnimationPlayer.stepBack(player)).toEqual({ ...player, cursor: 0, playing: false });
  });

  it('clamps at 0', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: true };
    expect(AnimationPlayer.stepBack(player)).toEqual({ ...player, cursor: 0, playing: false });
  });
});

describe('AnimationPlayer.stepForward', () => {
  it('increments cursor and sets playing to false', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: true };
    expect(AnimationPlayer.stepForward(player)).toEqual({ ...player, cursor: 1, playing: false });
  });

  it('clamps at ruleSteps.length', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: ruleSteps.length, playing: true };
    expect(AnimationPlayer.stepForward(player)).toEqual({ ...player, cursor: ruleSteps.length, playing: false });
  });
});

describe('AnimationPlayer.togglePlay', () => {
  it('flips playing from false to true', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: false };
    expect(AnimationPlayer.togglePlay(player)).toEqual({ ...player, playing: true });
  });

  it('flips playing from true to false', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: true };
    expect(AnimationPlayer.togglePlay(player)).toEqual({ ...player, playing: false });
  });
});

describe('AnimationPlayer.tick', () => {
  it('advances cursor by one while cursor < ruleSteps.length', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: true };
    expect(AnimationPlayer.tick(player)).toEqual({ ...player, cursor: 1 });
  });

  it('stops playback without advancing cursor at the end', () => {
    const { baseState, ruleSteps } = setup();
    const player: AnimationPlayer = { baseState, ruleSteps, cursor: ruleSteps.length, playing: true };
    expect(AnimationPlayer.tick(player)).toEqual({ ...player, playing: false });
  });
});
