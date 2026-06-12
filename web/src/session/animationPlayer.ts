/**
 * Pure-data navigation over a buildEngine() ruleSteps list.
 *
 * See docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md §4 and
 * docs/superpowers/specs/2026-06-12-animation-player-design.md.
 *
 * Never persisted — UI-only state for the rule-by-rule animation.
 */

import type { PuzzleState, CandidatesResponse } from './types.js';
import type { RuleStep } from './ruleMutation.js';
import { computeAnimationCandidates } from './actions.js';

export interface AnimationPlayer {
  /** State right after the user's action, before any rule steps are applied. */
  readonly baseState: PuzzleState;
  readonly ruleSteps: readonly RuleStep[];
  /** 0..ruleSteps.length — number of steps fully applied so far. */
  readonly cursor: number;
  readonly playing: boolean;
}

export namespace AnimationPlayer {
  /** Folds ruleSteps[0..cursor) mutations onto baseState. */
  export function stateAtCursor(player: AnimationPlayer): PuzzleState {
    let state: PuzzleState = player.baseState;
    for (let i = 0; i < player.cursor; i++) {
      for (const mutation of player.ruleSteps[i]!.mutations) state = mutation.apply(state);
    }
    return state;
  }

  /** Board for rendering at the current cursor position. */
  export function boardAtCursor(player: AnimationPlayer): CandidatesResponse {
    return computeAnimationCandidates(stateAtCursor(player));
  }

  /** The step about to be (or being) animated, or null at the end of the list. */
  export function currentStep(player: AnimationPlayer): RuleStep | null {
    return player.ruleSteps[player.cursor] ?? null;
  }
}
