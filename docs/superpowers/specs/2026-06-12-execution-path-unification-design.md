# Execution Path Unification — Design (§5 of Puzzle State Redesign)

**Date:** 2026-06-12
**Branch:** new feature branch off `master`
**Parent spec:** `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md` §5

---

## Motivation

The codebase currently has three divergent "auto-apply" code paths, each
re-running `buildEngine()` and folding its results onto state differently:

1. **`applyAutoPlacements(state)`** — full solve, commits only
   `engine.appliedPlacements` to `userGrid`. Called after `recordTurn` (and
   after `rebuildUserGrid`) in ~9 places in `actions.ts`.
2. **`applyNextAutoPlacement` / `stepAutoPlacement`** — single-placement
   variant. Exported but **never called** outside its own definition — dead
   code.
3. **`getNextAutoApplyStep` / `applyAutoApplyStep`** — used only by
   `main.ts`'s animated `handleCellEntry` path, iterating `ruleSteps[0]` one
   at a time against an in-memory `currentState`, persisted via `setState`
   only at the very end (with a save/restore hack for
   `userRemovedCandidates` to discard transient animation-only
   eliminations).

Critically, today's `recordTurn` does **not** fold any rule-driven mutations
(placements *or* eliminations) into the state it returns. Only placements get
persisted, and only via the bolted-on `applyAutoPlacements` call every
non-animated caller must remember to make. Rule-driven candidate eliminations
are never persisted into `userRemovedCandidates`, so every subsequent
`buildEngine` call re-derives — and re-presents as "new" — the same
deductions. This is the root cause of the "execution loop has accumulated
bugs" problem named in the parent spec.

## Goal

Replace all three paths with a single shape: `recordTurn` runs
`buildEngine()` exactly once per user action, folds **all** ruleStep
mutations (placements, candidate eliminations, virtual cages, cage-solution
eliminations) onto the resulting state via the existing `RuleMutation.apply()`
machinery, and returns both the fully-folded final state and the `ruleSteps`
list for optional visual animation. Animation becomes a pure replay of an
already-committed transition — never a second source of truth.

---

## 1. Core primitive: `applyRuleSteps()`

New exported function in `web/src/session/engine.ts`:

```typescript
export function applyRuleSteps(state: PuzzleState): { state: PuzzleState; ruleSteps: readonly RuleStep[] } {
  const { ruleSteps } = buildEngine(state, { skipValidation: true });
  const folded = ruleSteps.flatMap(s => s.mutations).reduce((s, m) => m.apply(s), state);
  return { state: folded, ruleSteps };
}
```

This generalizes `applyAutoPlacements` (placements only) to fold every
mutation kind, using the same `RuleMutation.apply()` calls
`AnimationPlayer.stateAtCursor` already uses and that
`engine.autoApply.test.ts` already exercises for `applyAutoApplyStep`.

Folding eliminations into `userRemovedCandidates` is what stops the *next*
`buildEngine` call from re-deriving and re-presenting the same deductions as
new rule steps — the existing `getNextAutoApplyStep` test "never re-produces a
step whose eliminations are already in userRemovedCandidates" already
documents and tests this property for the per-step case;
`applyRuleSteps` extends it to the whole-turn case.

**Idempotence:** calling `applyRuleSteps` again on its own output must be a
no-op (`ruleSteps` empty, `state` unchanged) — this is the key correctness
property and gets a dedicated test.

---

## 2. `recordTurn`'s new contract

```typescript
export function recordTurn(
  state: PuzzleState,
  action: UserAction,
): { state: PuzzleState; ruleSteps: readonly RuleStep[]; baseState: PuzzleState }
```

Behavior:

1. `baseState = UserAction.apply(action, state)` (unchanged).
2. `{ state: folded, ruleSteps } = applyRuleSteps(baseState)` — this is the
   **only** `buildEngine` call for this action, satisfying the parent spec's
   "`buildEngine()` runs its full solve exactly once per user action."
3. Build `turn = { action, autoMutations, snapshot }` as today. `autoMutations`
   and the snapshot come from the `buildEngine` call inside step 2 — thread
   `board`/`engine`/`validationContext` out of `applyRuleSteps` (or have
   `recordTurn` call `buildEngine` directly and have `applyRuleSteps` be a thin
   wrapper — implementation detail for the plan) so no second solve is needed.
4. `finalState = { ...folded, turns: [...baseState.turns, turn] }`.
5. Schedule trigger validation against `finalState` exactly as today.
6. Return `{ state: finalState, ruleSteps, baseState }`.

All five existing `recordTurn` call sites in `actions.ts` and the test
call sites in `engine.test.ts` / `actions.test.ts` must be updated for the new
return shape.

---

## 3. `actions.ts` call site updates (Sprint A)

- **`recordTurn`-based actions** — `enterCell`, `cycleCandidate`,
  `eliminateCageSolution`, `eliminateVirtualCageSolution`,
  `eliminateVirtualCageDiffSolution`, `addVirtualCage`, `applyHint`,
  `confirmPuzzle`, `refresh`: drop the trailing `applyAutoPlacements(...)` /
  `applyAutoPlacements(rebuildUserGrid(...))` call. Use
  `recordTurn(...).state` directly as the returned/persisted state.

- **History-rewrite actions** — `undo`, `rewind`: these trim `turns` and call
  `rebuildUserGrid` rather than `recordTurn`. Replace
  `applyAutoPlacements(rebuildUserGrid(trimmed))` with
  `applyRuleSteps(rebuildUserGrid(trimmed)).state`.

- **`enterCellStep`** (animated entry point): returns the full
  `{ state, ruleSteps, baseState }` from `recordTurn` so `main.ts` can build
  an `AnimationPlayer`. The returned `state` is the final, already-folded,
  committed state.

- **Delete**: `applyAutoPlacements`, `applyNextAutoPlacement`,
  `stepAutoPlacement` (dead code), `getNextAutoApplyStep`,
  `applyAutoApplyStep`. Remove their imports from `actions.ts` / `main.ts`.

---

## 4. `main.ts` animation wiring (Sprint B)

Replace the manual loop in `handleCellEntry`'s animated branch
(`autoPlacementDelay > 0`) with `AnimationPlayer`:

```typescript
const { state: finalState, ruleSteps, baseState } = enterCellStep(row1b, col1b, digit);
setState(finalState);                 // commit immediately — no dual-write
currentState = finalState;
updateUndoButton(finalState);

let player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: true };
animRefresh(AnimationPlayer.boardAtCursor(player));

while (player.cursor < ruleSteps.length) {
  const step = AnimationPlayer.currentStep(player)!;
  hintHighlightCells = new Set(step.highlightCells.map(([r, c]) => `${r},${c}`));
  hintElimCells = new Set(
    step.mutations
      .filter((m): m is EliminateCandidateMutation => m.type === 'eliminateCandidate')
      .map(m => `${m.row},${m.col}`),
  );
  showHintPill(el('hint-pill'), el('hint-pill-label'), step.displayName);
  await new Promise<void>(resolve => { setTimeout(resolve, fastForwardRequested ? 0 : delay); });

  player = AnimationPlayer.tick(player);
  hintHighlightCells = new Set();
  hintElimCells = new Set();
  hideHintPill(el('hint-pill'));
  animRefresh(AnimationPlayer.boardAtCursor(player));
}

refreshDisplay();   // final redraw from the already-committed finalState
```

Notes:
- `fastForwardRequested` is handled by the existing per-iteration `delay: 0`
  branch — no special-case early-exit loop is needed since `tick()` always
  advances by exactly one step and the per-step `setTimeout` becomes a no-op
  delay.
- No `preAnimationRemoved` save/restore is needed: `finalState` is correct and
  committed *before* the animation starts. The animation (`player`) is
  UI-local state that never feeds back into `currentState`'s committed fields
  beyond what was already folded by `applyRuleSteps`.
- `AnimationPlayer`'s existing `rewind`/`stepBack`/`stepForward`/`togglePlay`
  controls are not wired to new UI controls in this sprint — only `tick`-driven
  auto-play (mirroring today's UX). Manual scrubbing controls are future work
  if desired.

---

## 5. Testing

- `engine.test.ts`: update `recordTurn` tests for the new
  `{ state, ruleSteps, baseState }` return shape (currently asserts on the
  returned `PuzzleState` directly — update to `.state`).
- `engine.autoApply.test.ts`: add `applyRuleSteps` tests — folds placements
  and eliminations onto state, idempotent on its own output, and (reusing the
  existing fixtures) "eventually places the correct digit in (0,0)" in one
  call rather than a step loop. Remove `getNextAutoApplyStep`/
  `applyAutoApplyStep` tests (functions deleted).
- `actions.test.ts`: update all `recordTurn`/`enterCellStep` call sites for
  the new shapes; remove any `applyAutoPlacements`-specific assertions (now
  covered by `applyRuleSteps`'s tests).
- `flow.spec.ts` (Playwright dev config): re-run to verify the animated entry
  path (`autoPlacementDelay > 0`) still shows hint pills, highlights, and
  candidate eliminations correctly end-to-end.

---

## Out of Scope

- §6 `namespace PuzzleState` public API, §7 Serialization, §8 (unchanged) —
  remain future work per the parent spec.
- New UI controls for `AnimationPlayer`'s scrub/rewind/step-back/step-forward
  methods — only auto-play (`tick`) is wired in this sprint.
- Any change to rule logic, `RuleMutation` types, or `BoardState`/`SolverEngine`
  internals.

---

## Sprint Plan (for writing-plans)

- **Sprint A** — `applyRuleSteps`, `recordTurn`'s new contract, all
  `actions.ts` non-animated call sites + their tests, deletion of
  `applyAutoPlacements`/`applyNextAutoPlacement`/`stepAutoPlacement`. Produces
  a fully working, independently-testable engine/actions layer — `main.ts`'s
  animated path is updated only enough to keep `tsc` passing (consume the new
  `enterCellStep` return shape) without yet using `AnimationPlayer`.
- **Sprint B** — Rewrite `handleCellEntry`'s animated branch in `main.ts` to
  use `AnimationPlayer` as in §4; delete `getNextAutoApplyStep`/
  `applyAutoApplyStep` and their tests; Playwright dev verification.
