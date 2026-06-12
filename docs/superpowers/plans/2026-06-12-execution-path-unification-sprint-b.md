# Execution Path Unification — Sprint B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Rewrite `handleCellEntry`'s animated branch in `web/src/main.ts` to use
`AnimationPlayer` as a pure replay of the already-committed transition, and delete
the now-unused `getNextAutoApplyStep`/`applyAutoApplyStep` helpers and their tests.

**Architecture:** `enterCellStep` (from Sprint A) already runs `recordTurn` once,
folds all rule-step mutations onto the committed state, and persists it via
`setState`. The animated branch no longer needs a second solve loop — it just
replays `ruleSteps` against `baseState` using `AnimationPlayer.tick`/`boardAtCursor`/
`currentStep` for the visual highlight/elimination/hint-pill sequence, then does a
final `refreshDisplay()` from the already-committed `finalState`.

**Tech Stack:** TypeScript, Vitest, Playwright (`playwright.dev.config.ts` /
`flow.spec.ts`), existing `AnimationPlayer` namespace in
`web/src/session/animationPlayer.ts`.

**Precondition:** Sprint A
(`docs/superpowers/plans/2026-06-12-execution-path-unification-sprint-a.md`) is
complete — `enterCellStep` returns `{ state, ruleSteps, baseState }`, and
`main.ts`'s animated branch is in its Task-10 "minimal compile fix" form (still using
`getNextAutoApplyStep`/`applyAutoApplyStep` against `currentState`).

---

## Task 1: Update `main.ts` imports

**Files:**
- Modify: `web/src/main.ts:60`

- [x] **Step 1: Replace the `engine.js` auto-apply import with the `AnimationPlayer` import**

Current (after Sprint A, line 60 is unchanged from today):

```typescript
import { getNextAutoApplyStep, applyAutoApplyStep } from './session/engine.js';
```

Replace with:

```typescript
import { AnimationPlayer } from './session/animationPlayer.js';
```

- [x] **Step 2: Verify `EliminateCandidateMutation` import on line 61 is still present (unchanged)**

```typescript
import type { EliminateCandidateMutation } from './session/ruleMutation.js';
```

No change needed — it's still used by the rewritten branch in Task 2.

---

## Task 2: Rewrite `handleCellEntry`'s animated branch to use `AnimationPlayer`

**Files:**
- Modify: `web/src/main.ts` (animated branch inside `handleCellEntry`, the `else`
  block produced by Sprint A's Task 10 — originally lines ~1486-1555 before Sprint
  A, shifted slightly after Sprint A's edits)

- [x] **Step 1: Replace the entire animated branch**

Find the `else` block of `handleCellEntry` (the `delay !== 0` branch). After
Sprint A it looks like this (Task-10 form):

```typescript
    } else {
      // Animated path: show the user's placement first, then step through each rule.
      setAutoApplyLock(true);
      try {
        const animRefresh = (animState: PuzzleState): void => {
          if (showCandidates) {
            const data = computeAnimationCandidates(animState);
            currentCandidates = data;
            setCandidatesCache(data);
            redrawGrid();
          } else {
            redrawGrid();
          }
        };

        const { state: committedState, baseState } = enterCellStep(selectedCell.row, selectedCell.col, digit);
        currentState = baseState;
        animRefresh(currentState);
        updateUndoButton(committedState);
        await new Promise<void>(resolve => { setTimeout(resolve, fastForwardRequested ? 0 : delay); });
        while (true) {
          const step = getNextAutoApplyStep(currentState);
          if (step === null) break;

          if (fastForwardRequested) {
            currentState = applyAutoApplyStep(currentState, step);
            continue;
          }

          hintHighlightCells = new Set(step.highlightCells.map(([r, c]) => `${r},${c}`));
          hintElimCells = new Set(
            step.mutations
              .filter((m): m is EliminateCandidateMutation => m.type === 'eliminateCandidate')
              .map(m => `${m.row},${m.col}`),
          );
          showHintPill(el('hint-pill'), el('hint-pill-label'), step.displayName);
          animRefresh(currentState);
          await new Promise<void>(resolve => { setTimeout(resolve, delay); });

          currentState = applyAutoApplyStep(currentState, step);
          hintHighlightCells = new Set();
          hintElimCells = new Set();
          hideHintPill(el('hint-pill'));
          animRefresh(currentState);
        }
        hideHintPill(el('hint-pill'));
        hintHighlightCells = new Set();
        hintElimCells = new Set();
        currentState = committedState;
        refreshDisplay();
        updateUndoButton(currentState);
      } finally {
        setAutoApplyLock(false);
      }
    }
```

Replace it with:

```typescript
    } else {
      // Animated path: enterCellStep already computed and persisted the final,
      // fully-folded state. The loop below is a pure visual replay of ruleSteps
      // for hint pills/highlights/eliminations — it never feeds back into
      // currentState beyond what enterCellStep already committed.
      setAutoApplyLock(true);
      try {
        const animRefresh = (animState: PuzzleState): void => {
          if (showCandidates) {
            const data = computeAnimationCandidates(animState);
            currentCandidates = data;
            setCandidatesCache(data);
            redrawGrid();
          } else {
            redrawGrid();
          }
        };

        const { state: finalState, ruleSteps, baseState } = enterCellStep(selectedCell.row, selectedCell.col, digit);
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
      } finally {
        setAutoApplyLock(false);
      }
    }
```

Note: `enterCellStep` already calls `setState` internally (Sprint A), so there is
no separate `setState(finalState)` call here — `currentState = finalState` is
sufficient to keep the in-memory mirror in sync.

- [x] **Step 2: Run the TypeScript checks**

```bash
cd web && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

Expected: both pass with no errors (no remaining references to
`getNextAutoApplyStep`/`applyAutoApplyStep` in `main.ts`).

---

## Task 3: Delete `getNextAutoApplyStep` and `applyAutoApplyStep` from `engine.ts`

**Files:**
- Modify: `web/src/session/engine.ts` (end of file, the
  "Rule-by-rule auto-apply animation helpers" section)

- [x] **Step 1: Confirm no remaining references**

```bash
cd web && grep -rn "getNextAutoApplyStep\|applyAutoApplyStep" src/
```

Expected: matches only in `web/src/session/engine.ts` (the definitions) and
`web/src/session/engine.autoApply.test.ts` (deleted in Task 4) — none in `main.ts`
after Task 2.

- [x] **Step 2: Delete the section**

Remove the trailing section (and its header comment) from `web/src/session/engine.ts`:

```typescript
// ---------------------------------------------------------------------------
// Rule-by-rule auto-apply animation helpers
// ---------------------------------------------------------------------------

/**
 * Returns the next rule step to be animated, or null when no more rules fire.
 * Builds the engine from scratch (applying userRemovedCandidates) and returns
 * the first ruleStep produced by `buildEngine`.
 */
export function getNextAutoApplyStep(state: PuzzleState): RuleStep | null {
  if (state.goldenSolution === null) return null;
  const { ruleSteps } = buildEngine(state);
  return ruleSteps[0] ?? null;
}

/** Applies every mutation in a RuleStep to the state, in order. */
export function applyAutoApplyStep(state: PuzzleState, step: RuleStep): PuzzleState {
  return step.mutations.reduce((s, mutation) => mutation.apply(s), state);
}
```

Leave the preceding section (`captureSnapshot` / "Snapshot helpers") and the file's
final newline intact — the file should now end with `captureSnapshot`'s closing
brace.

- [x] **Step 3: Check for now-unused imports/types in `engine.ts`**

`RuleStep` is still used elsewhere in `engine.ts` (e.g. `buildEngine`'s return type,
`recordTurn`, `applyRuleSteps` from Sprint A) — no import changes expected. Confirm
with:

```bash
cd web && grep -n "RuleStep" src/session/engine.ts
```

Expected: at least one remaining usage (e.g. in `buildEngine`'s return type or
`applyRuleSteps`).

---

## Task 4: Delete the corresponding test blocks from `engine.autoApply.test.ts`

**Files:**
- Modify: `web/src/session/engine.autoApply.test.ts`

- [x] **Step 1: Update the file header doc-comment**

Current header (lines 1-8):

```typescript
/**
 * Tests for the rule-by-rule auto-apply session helpers:
 *   - applyAutoApplyStep
 *   - getNextAutoApplyStep
 *   - buildEngine applying userRemovedCandidates
 *
 * All tests are RED until the feature is implemented.
 */
```

Replace with:

```typescript
/**
 * Tests for the rule-step folding helpers:
 *   - applyRuleSteps
 *   - buildEngine applying userRemovedCandidates
 */
```

- [x] **Step 2: Update the import statement**

Current (line 13-17, after Sprint A this will already include `applyRuleSteps`):

```typescript
import {
  buildEngine,
  getNextAutoApplyStep,
  applyAutoApplyStep,
  applyRuleSteps,
} from './engine.js';
```

(Exact ordering/contents depend on how Sprint A's Task 1 added the
`applyRuleSteps` import — keep that addition, just remove the two deleted names.)

Replace with:

```typescript
import {
  buildEngine,
  applyRuleSteps,
} from './engine.js';
```

- [x] **Step 3: Delete the `describe('applyAutoApplyStep', ...)` block**

Remove the entire block (originally lines 165-220, after the
"// applyAutoApplyStep" section-comment header):

```typescript
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
```

- [x] **Step 4: Delete the `describe('getNextAutoApplyStep', ...)` block**

Remove the entire block (originally lines 222-280, including the
"// getNextAutoApplyStep" section-comment header, through the end of the file):

```typescript
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
```

Note: the "never re-produces a step whose eliminations are already in
userRemovedCandidates" property is already covered for the whole-turn case by
`applyRuleSteps`'s idempotence test (Sprint A Task 1) — no replacement test is
needed here.

- [x] **Step 5: Check for now-unused imports/fixtures**

After deleting both blocks, check whether `RuleMutation`, `Cell`,
`KillerPuzzleState`, or `KNOWN_SOLUTION` are still used elsewhere in the file:

```bash
cd web && grep -n "RuleMutation\|: Cell\|KillerPuzzleState\|KNOWN_SOLUTION" src/session/engine.autoApply.test.ts
```

`KNOWN_SOLUTION` and `makeAlmostCompleteState` are still used by
`describe('buildEngine — ruleSteps', ...)` (lines 68-91) and by Sprint A's new
`applyRuleSteps` tests — keep those imports. Remove only imports that have zero
remaining references. `RuleMutation` and `Cell` (from `'../engine/types.js'`) were
used only by the deleted blocks — if `grep` shows zero remaining matches, remove
their import lines.

---

## Task 5: Run the full test suite and bronze gate

**Files:** none (verification only)

- [x] **Step 1: Run vitest**

```bash
cd web && npm test
```

Expected: all tests pass, with the `applyAutoApplyStep`/`getNextAutoApplyStep`
describe blocks gone from `engine.autoApply.test.ts`'s output.

- [x] **Step 2: Run the bronze gate**

```bash
bash scripts/run-bronze-gate.sh
```

Expected: `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test` all
pass, producing `.bronze-gate-ok`.

---

## Task 6: Manual Playwright verification of the animated entry path

**Files:** none (manual verification only — `flow.spec.ts` has no automated test
for `autoPlacementDelay > 0`; this task exercises that path via Playwright MCP
against the dev server)

- [x] **Step 1: Start the dev server**

```bash
cd web && npm run dev -- --port 5175
```

- [x] **Step 2: Load a puzzle and enable animation**

Using `mcp__plugin_playwright_playwright__browser_*` tools:
1. Navigate to `http://localhost:5175/`.
2. Evaluate `window.__testLoad('boxCage')` (or another fixture with at least one
   auto-deducible cell after confirm) to reach the review panel.
3. Click `#confirm-btn` to reach playing mode.
4. Open the config modal (`#config-btn`), set the auto-placement delay to a
   non-zero value (e.g. 300ms) via the delay slider/input, and close the modal.

- [x] **Step 3: Trigger an animated entry**

1. Click a cell that, once filled, will let at least one rule deduce a further
   placement or elimination (e.g. a cell that completes a row/column/box for
   `NakedSingle`).
2. Press the digit key that makes that deduction possible.
3. Observe (via `browser_snapshot` / `browser_take_screenshot` and
   `browser_console_messages`):
   - The hint pill (`#hint-pill`) appears with the rule's `displayName` during
     each animated step.
   - `hintHighlightCells`-driven cell highlights appear on the canvas during each
     step (orange highlight).
   - `hintElimCells`-driven elimination markers appear for any
     `eliminateCandidate` mutations in a step (yellow).
   - After the animation completes, the hint pill disappears and the final board
     matches the fully-folded `finalState` (placements and eliminations both
     visible in the candidates display).

- [x] **Step 4: Verify fast-forward**

1. Trigger another animated entry.
2. Click the fast-forward button (`#fast-forward-btn`) mid-animation.
3. Confirm the remaining steps complete with `delay: 0` (per-iteration
   `fastForwardRequested ? 0 : delay`) and the final board still matches
   `finalState`.

- [x] **Step 5: Stop the dev server**

```bash
# Kill the background dev server process started in Step 1
```

---

## Task 7: Commit

**Files:**
- `web/src/main.ts`
- `web/src/session/engine.ts`
- `web/src/session/engine.autoApply.test.ts`

- [x] **Step 1: Stage and commit**

```bash
git add web/src/main.ts web/src/session/engine.ts web/src/session/engine.autoApply.test.ts
git commit -m "$(cat <<'EOF'
refactor: wire AnimationPlayer into handleCellEntry, delete dead auto-apply step helpers

handleCellEntry's animated branch now replays the ruleSteps already folded and
committed by enterCellStep via AnimationPlayer.tick/boardAtCursor/currentStep,
instead of re-solving step-by-step with getNextAutoApplyStep/applyAutoApplyStep
and patching userRemovedCandidates back afterwards. Those helpers and their
tests are removed as dead code.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Out of Scope (per design spec)

- New UI controls for `AnimationPlayer`'s `rewind`/`stepBack`/`stepForward`/
  `togglePlay` — only `tick`-driven auto-play is wired in this sprint.
- Any change to rule logic, `RuleMutation` types, or `BoardState`/`SolverEngine`
  internals.
