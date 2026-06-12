# AnimationPlayer Module (Sprint 3)

**Date:** 2026-06-12
**Branch:** claude/branch-state-review-lev0gg (continuing from Sprint 2b)
**Parent spec:** `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md` §4 (Animation Player)

---

## Motivation

The puzzle-state redesign's §3 (`buildEngine()` contract) shipped in Sprint 2b:
`buildEngine()` now returns `ruleSteps: readonly RuleStep[]`, an ordered list of
per-rule mutation groups computed in a single solve pass. §4 of the parent spec
defines `AnimationPlayer`, a pure-data structure + pure functions for navigating
this list — the foundation for replacing the current ad-hoc animation loop in
`main.ts` (a future sprint, §5 Execution Path).

This sprint implements `AnimationPlayer` as a standalone, fully-tested module
with **no `main.ts` wiring**. It is additive only — nothing in the existing
animation loop changes.

---

## Module: `web/src/session/animationPlayer.ts`

```typescript
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
  // --- Derivation ---

  /** Folds ruleSteps[0..cursor) mutations onto baseState. */
  export function stateAtCursor(player: AnimationPlayer): PuzzleState;

  /** computeAnimationCandidates(stateAtCursor(player)) — board for rendering. */
  export function boardAtCursor(player: AnimationPlayer): CandidatesResponse;

  /** ruleSteps[cursor] ?? null — the step about to be (or being) animated. */
  export function currentStep(player: AnimationPlayer): RuleStep | null;

  // --- VCR cursor transitions (pure) ---

  /** « : cursor>0 → {cursor:0, playing:false}. cursor===0 → null (caller closes player). */
  export function rewind(player: AnimationPlayer): AnimationPlayer | null;

  /** ‹ : {cursor: max(0, cursor-1), playing:false} */
  export function stepBack(player: AnimationPlayer): AnimationPlayer;

  /** › : {cursor: min(ruleSteps.length, cursor+1), playing:false} */
  export function stepForward(player: AnimationPlayer): AnimationPlayer;

  /** ▶/⏸ : {playing: !playing} */
  export function togglePlay(player: AnimationPlayer): AnimationPlayer;

  /**
   * Auto-play tick: advances cursor by one step. If already at the end,
   * stops playback (playing: false) without committing — the end-of-list
   * is a pause point, not a close/commit action.
   */
  export function tick(player: AnimationPlayer): AnimationPlayer;
}
```

### Design notes

- **Namespace-merging pattern**, per CLAUDE.md: `AnimationPlayer` is plain data
  (serialisable in principle, though never persisted per the parent spec);
  all behaviour lives in the same-named namespace.
- **`stateAtCursor`** folds via `RuleMutation.apply`, the same mechanism
  `applyAutoApplyStep` already uses — `ruleSteps[i].mutations.reduce((s, m) =>
  m.apply(s), state)` for each step `0..cursor`.
- **`boardAtCursor`** delegates to the existing `computeAnimationCandidates`
  (`session/actions.ts`), which already calls `buildEngine(state, {skipSolve:
  true})`. No new board-construction logic.
- **Cursor clamping**: `stepForward`/`stepBack`/`tick` clamp to
  `[0, ruleSteps.length]` so cursor is always a valid index into
  `ruleSteps` (when `< length`) or represents "all steps applied"
  (when `=== length`).
- **`rewind` returns `AnimationPlayer | null`**: `null` signals "close the
  player, no commit" per the parent spec's VCR table. This sprint does not
  implement the close/commit side effects (those live in `main.ts`, a later
  sprint) — the caller is responsible for interpreting `null`.
- **`»` (fold-remaining-and-commit) is excluded** from this sprint. Per the
  parent spec, `»` builds an `ApplyHintAction { mutations: RuleMutation[] }`
  and dispatches it — but `ApplyHintAction.mutations` is currently
  `eliminations: readonly [number, number, number][]`, a §5 data-model change
  for a later sprint. Implementing `»` here would require that change as a
  prerequisite, expanding this sprint's scope.

---

## Testing

New file `web/src/session/animationPlayer.test.ts`:

- `stateAtCursor`:
  - `cursor === 0` returns `baseState` unchanged (reference or deep-equal).
  - `cursor === ruleSteps.length` folds all steps — equivalent to applying
    every step's mutations via `applyAutoApplyStep` in sequence.
  - Partial cursor folds only the first N steps.
- `boardAtCursor`: matches `computeAnimationCandidates(stateAtCursor(player))`
  for a representative cursor position.
- `currentStep`: returns `ruleSteps[cursor]` mid-list, `null` at/after the end.
- `rewind`: `cursor > 0` → `{cursor:0, playing:false}`; `cursor === 0` → `null`.
- `stepBack`/`stepForward`: clamp at `0` and `ruleSteps.length` respectively;
  both force `playing:false`.
- `togglePlay`: flips `playing` in both directions.
- `tick`: advances cursor by 1 while `cursor < length`; at `cursor ===
  length`, sets `playing:false` and leaves cursor unchanged.

Fixtures: reuse `makeAlmostCompleteState()` / `makeTrivialSpec()` /
`KNOWN_SOLUTION` from `web/src/engine/fixtures.js`, and `buildEngine()` to
obtain a real `ruleSteps` list (same pattern as
`engine.autoApply.test.ts`).

---

## Out of scope (deferred)

- `main.ts` wiring / replacing the existing animation loop (§5, future sprint)
- `ApplyHintAction.mutations: RuleMutation[]` migration and the `»` button (§5)
- `PuzzleState` public API (§6), serialization (§7)
