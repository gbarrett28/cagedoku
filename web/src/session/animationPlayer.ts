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

  /**
   * « : if cursor > 0, reset to the start (paused). If cursor === 0, returns
   * null — the caller closes the player with no commit.
   */
  export function rewind(player: AnimationPlayer): AnimationPlayer | null {
    if (player.cursor === 0) return null;
    return { ...player, cursor: 0, playing: false };
  }

  /** ‹ : step back one rule step, clamped at 0. Forces playing: false. */
  export function stepBack(player: AnimationPlayer): AnimationPlayer {
    return { ...player, cursor: Math.max(0, player.cursor - 1), playing: false };
  }

  /** › : step forward one rule step, clamped at ruleSteps.length. Forces playing: false. */
  export function stepForward(player: AnimationPlayer): AnimationPlayer {
    return { ...player, cursor: Math.min(player.ruleSteps.length, player.cursor + 1), playing: false };
  }

  /** ▶/⏸ : toggle playback. */
  export function togglePlay(player: AnimationPlayer): AnimationPlayer {
    return { ...player, playing: !player.playing };
  }

  /**
   * Auto-play tick: advances the cursor by one step. If already at the end,
   * stops playback (playing: false) without advancing — the end of the list
   * is a pause point, not a close/commit action.
   */
  export function tick(player: AnimationPlayer): AnimationPlayer {
    if (player.cursor >= player.ruleSteps.length) return { ...player, playing: false };
    return { ...player, cursor: player.cursor + 1 };
  }
}
