# Execution Path Unification — Sprint A: applyRuleSteps + recordTurn + actions.ts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace `applyAutoPlacements`/`applyNextAutoPlacement`/`stepAutoPlacement` with a single `applyRuleSteps()` helper that folds **every** `RuleStep` mutation (placements, candidate eliminations, virtual cages, cage-solution eliminations) onto state, give `recordTurn` a new `{ state, ruleSteps, baseState }` contract that folds rule mutations exactly once per action, and update every `actions.ts` call site accordingly.

**Architecture:** `applyRuleSteps(state)` calls `buildEngine(state, { skipValidation: true })` and reduces `ruleSteps.flatMap(s => s.mutations)` onto `state` via `RuleMutation.apply()` — the same machinery `AnimationPlayer.stateAtCursor` already uses. `recordTurn` becomes `baseState = UserAction.apply(...)`, then `applyRuleSteps(baseState)` for the folded state, then records the turn and schedules validation against the folded `finalState`.

**Tech Stack:** TypeScript, Vitest. All work in `web/src/session/`.

**Spec:** `docs/superpowers/specs/2026-06-12-execution-path-unification-design.md`

---

### Task 1: `applyRuleSteps()` — TDD

**Files:**
- Modify: `web/src/session/engine.autoApply.test.ts`
- Modify: `web/src/session/engine.ts`

- [x] **Step 1: Write the failing test**

In `web/src/session/engine.autoApply.test.ts`, add this new `describe` block immediately after the `describe('buildEngine with userRemovedCandidates', ...)` block (i.e. before the `// applyAutoApplyStep` section comment):

```typescript
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

  it('does not change state when there are no ruleSteps', () => {
    const state = makeBaseState();
    const { state: result, ruleSteps } = applyRuleSteps(state);
    expect(ruleSteps).toEqual([]);
    expect(result).toEqual(state);
  });
});
```

Add `applyRuleSteps` to the existing import from `./engine.js` at the top of the file:

```typescript
import {
  buildEngine,
  getNextAutoApplyStep,
  applyAutoApplyStep,
  applyRuleSteps,
} from './engine.js';
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/engine.autoApply.test.ts`
Expected: FAIL — `applyRuleSteps` is not exported from `./engine.js` (TypeScript compile error / import error).

- [x] **Step 3: Implement `applyRuleSteps` in `engine.ts`**

In `web/src/session/engine.ts`, add this new exported function immediately after `applyAutoPlacements` (after line 494, before `applyNextAutoPlacement`):

```typescript
/**
 * Runs buildEngine() once and folds every ruleStep mutation (placements,
 * candidate eliminations, virtual cages, cage-solution eliminations) onto
 * state via RuleMutation.apply(), using the same machinery
 * AnimationPlayer.stateAtCursor uses for per-step animation.
 *
 * Calling this on its own output is a no-op: buildEngine on the folded state
 * produces an empty ruleSteps list (the deductions are now reflected in
 * userGrid/userRemovedCandidates, so preCands no longer contains them).
 */
export function applyRuleSteps(state: PuzzleState): { state: PuzzleState; ruleSteps: readonly RuleStep[] } {
  const { ruleSteps } = buildEngine(state, { skipValidation: true });
  const folded = ruleSteps.flatMap(s => s.mutations).reduce((s, m) => m.apply(s), state);
  return { state: folded, ruleSteps };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/session/engine.autoApply.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [x] **Step 5: Commit**

```bash
git add web/src/session/engine.ts web/src/session/engine.autoApply.test.ts
git commit -m "feat: add applyRuleSteps to fold all ruleStep mutations onto state"
```

---

### Task 2: `recordTurn`'s new `{ state, ruleSteps, baseState }` contract — TDD

**Files:**
- Modify: `web/src/session/engine.test.ts`
- Modify: `web/src/session/engine.ts`

- [x] **Step 1: Write the failing test**

In `web/src/session/engine.test.ts`, add this new `describe` block immediately after the existing `describe('recordTurn — trigger validation scheduling', ...)` block (at the end of the file):

```typescript
describe('recordTurn — { state, ruleSteps, baseState } contract', () => {
  it('returns finalState with ruleSteps folded onto baseState, plus a recorded turn', () => {
    const state = makeState();
    const action: EliminateCandidateAction = { type: 'eliminateCandidate', row: 0, col: 0, digit: 1 };

    const { state: finalState, ruleSteps, baseState } = recordTurn(state, action);

    // baseState is UserAction.apply(action, state) — one more turn than the input.
    expect(baseState.turns.length).toBe(state.turns.length);
    expect(finalState.turns.length).toBe(baseState.turns.length + 1);
    expect(finalState.turns[finalState.turns.length - 1]!.action).toEqual(action);

    // finalState's board fields equal ruleSteps folded onto baseState.
    const folded = ruleSteps.flatMap(s => s.mutations).reduce((s, m) => m.apply(s), baseState);
    expect(finalState.userGrid).toEqual(folded.userGrid);
    expect(finalState.userRemovedCandidates).toEqual(folded.userRemovedCandidates);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/engine.test.ts -t "recordTurn — { state, ruleSteps, baseState } contract"`
Expected: FAIL — destructuring `{ state, ruleSteps, baseState }` from `recordTurn`'s current `PuzzleState` return value produces `undefined` for `.turns`, so `baseState.turns.length` throws (`Cannot read properties of undefined`).

- [x] **Step 3: Implement the new `recordTurn` contract**

In `web/src/session/engine.ts`, replace the current `recordTurn` (lines 523–537):

```typescript
export function recordTurn(
  state: PuzzleState,
  action: UserAction,
): PuzzleState {
  const nextState = UserAction.apply(action, state);
  const { board, engine, validationContext } = buildEngine(nextState, { skipValidation: true }); // engine.solve() called inside buildEngine
  const autoMutations: AutoMutation[] = [...engine.appliedMutations];
  const snapshot = captureSnapshot(board);
  const turn: Turn = { action, autoMutations, snapshot };
  const finalState = { ...nextState, turns: [...nextState.turns, turn] };
  if (validationContext !== null) {
    scheduleTriggerValidation(board, validationContext.rules, validationContext.golden, finalState, validationContext.spec);
  }
  return finalState;
}
```

with:

```typescript
export function recordTurn(
  state: PuzzleState,
  action: UserAction,
): { state: PuzzleState; ruleSteps: readonly RuleStep[]; baseState: PuzzleState } {
  const baseState = UserAction.apply(action, state);
  const { ruleSteps, board, engine, validationContext } = buildEngine(baseState, { skipValidation: true }); // engine.solve() called inside buildEngine
  const folded = ruleSteps.flatMap(s => s.mutations).reduce((s, m) => m.apply(s), baseState);
  const autoMutations: AutoMutation[] = [...engine.appliedMutations];
  const snapshot = captureSnapshot(board);
  const turn: Turn = { action, autoMutations, snapshot };
  const finalState = { ...folded, turns: [...baseState.turns, turn] };
  if (validationContext !== null) {
    scheduleTriggerValidation(board, validationContext.rules, validationContext.golden, finalState, validationContext.spec);
  }
  return { state: finalState, ruleSteps, baseState };
}
```

(`applyRuleSteps` is not called here directly because `recordTurn` needs the same `buildEngine` call's `board`/`engine`/`validationContext` for the snapshot and turn — `applyRuleSteps` only returns `{ state, ruleSteps }`. This keeps the "exactly one `buildEngine` call per action" property.)

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/session/engine.test.ts -t "recordTurn"`
Expected: PASS for both `recordTurn — trigger validation scheduling` (unaffected — it doesn't use the return value) and the new `recordTurn — { state, ruleSteps, baseState } contract` test.

- [x] **Step 5: Commit**

```bash
git add web/src/session/engine.ts web/src/session/engine.test.ts
git commit -m "feat: give recordTurn a { state, ruleSteps, baseState } contract"
```

*(Note: this commit will not compile yet — `actions.ts` and `main.ts` still call `recordTurn` expecting a `PuzzleState`. Tasks 3–6 fix this. If your tooling blocks committing non-compiling intermediate states, combine Tasks 2–6 into a single commit instead — but keep them as separate edit steps for review clarity.)*

---

### Task 3: Update `recordTurn`-based call sites in `actions.ts`

**Files:**
- Modify: `web/src/session/actions.ts`

This task updates the five `recordTurn` call sites (`enterCell`, `enterCellStep`, `cycleCandidate`, `addVirtualCage`, `applyHint`) to use the new `{ state, ruleSteps, baseState }` contract, dropping the now-unnecessary `applyAutoPlacements`/`rebuildUserGrid` wrapper since `recordTurn` already folds rule mutations.

- [x] **Step 1: `enterCell`**

Replace (around line 785-799):

```typescript
export function enterCell(row1b: number, col1b: number, digit: number): PuzzleState {
  const state = requireConfirmed();
  const r = row1b - 1;
  const c = col1b - 1;
  const action: UserAction = digit !== 0
    ? { type: 'placeDigit', row: r, col: c, digit, source: 'user' }
    : { type: 'removeDigit', row: r, col: c };
  let updated = recordTurn(state, action);
  // Rebuild from turns so auto-placements are always derived from explicit user
  // actions alone — mirrors undo/rewind. This keeps the round-trip invariant:
  //   applyAutoPlacements(rebuildUserGrid(state)) === state.userGrid
  updated = applyAutoPlacements(rebuildUserGrid(updated));
  setState(updated);
  return updated;
}
```

with:

```typescript
export function enterCell(row1b: number, col1b: number, digit: number): PuzzleState {
  const state = requireConfirmed();
  const r = row1b - 1;
  const c = col1b - 1;
  const action: UserAction = digit !== 0
    ? { type: 'placeDigit', row: r, col: c, digit, source: 'user' }
    : { type: 'removeDigit', row: r, col: c };
  const { state: updated } = recordTurn(state, action);
  setState(updated);
  return updated;
}
```

- [x] **Step 2: `enterCellStep`**

Replace (around line 801-816):

```typescript
/**
 * Records the user's digit placement without applying auto-placements.
 * Used by the animated path in the UI (autoPlacementDelay > 0) so the
 * animation loop can step through auto-placements one-by-one.
 */
export function enterCellStep(row1b: number, col1b: number, digit: number): PuzzleState {
  const state = requireConfirmed();
  const r = row1b - 1;
  const c = col1b - 1;
  const action: UserAction = digit !== 0
    ? { type: 'placeDigit', row: r, col: c, digit, source: 'user' }
    : { type: 'removeDigit', row: r, col: c };
  const updated = recordTurn(state, action);
  setState(updated);
  return updated;
}
```

with:

```typescript
/**
 * Records the user's digit placement and returns the fully-folded committed
 * state alongside ruleSteps/baseState so the UI can drive an animation
 * showing the transition from baseState to state.
 */
export function enterCellStep(row1b: number, col1b: number, digit: number): { state: PuzzleState; ruleSteps: readonly RuleStep[]; baseState: PuzzleState } {
  const state = requireConfirmed();
  const r = row1b - 1;
  const c = col1b - 1;
  const action: UserAction = digit !== 0
    ? { type: 'placeDigit', row: r, col: c, digit, source: 'user' }
    : { type: 'removeDigit', row: r, col: c };
  const result = recordTurn(state, action);
  setState(result.state);
  return result;
}
```

Add `RuleStep` to the type-only import from `./ruleMutation.js` near the top of the file (currently `import type { EliminateCandidateMutation } from './ruleMutation.js';`):

```typescript
import type { EliminateCandidateMutation, RuleStep } from './ruleMutation.js';
```

- [x] **Step 3: `cycleCandidate`**

Replace (around line 872-901), the tail of the function:

```typescript
  let updated = recordTurn(state, action);
  // Rebuild from turns so auto-placements stay consistent with explicit user
  // actions — same invariant as enterCell and undo.
  updated = applyAutoPlacements(rebuildUserGrid(updated));
  setState(updated);
  return updated;
}
```

with:

```typescript
  const { state: updated } = recordTurn(state, action);
  setState(updated);
  return updated;
}
```

- [x] **Step 4: `addVirtualCage`**

Replace (around line 1047-1051):

```typescript
  const action: UserAction = { type: 'addVirtualCage', cage };
  let updated = recordTurn(state, action);
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}
```

with:

```typescript
  const action: UserAction = { type: 'addVirtualCage', cage };
  const { state: updated } = recordTurn(state, action);
  setState(updated);
  return updated;
}
```

- [x] **Step 5: `applyHint`**

Replace (around line 1302-1310):

```typescript
export function applyHint(eliminations: readonly { cell: [number, number]; digit: number }[]): PuzzleState {
  const state = requireConfirmed();
  const mutations = eliminations.map(e => RuleMutation.eliminateCandidate(e.cell[0], e.cell[1], e.digit));
  const action: UserAction = { type: 'applyHint', mutations };
  let updated = recordTurn(state, action);
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}
```

with:

```typescript
export function applyHint(eliminations: readonly { cell: [number, number]; digit: number }[]): PuzzleState {
  const state = requireConfirmed();
  const mutations = eliminations.map(e => RuleMutation.eliminateCandidate(e.cell[0], e.cell[1], e.digit));
  const action: UserAction = { type: 'applyHint', mutations };
  const { state: updated } = recordTurn(state, action);
  setState(updated);
  return updated;
}
```

- [x] **Step 6: Commit**

```bash
git add web/src/session/actions.ts
git commit -m "refactor: update recordTurn call sites for new { state, ruleSteps, baseState } contract"
```

---

### Task 4: Update history-rewrite call sites (`undo`, `rewind`)

**Files:**
- Modify: `web/src/session/actions.ts`

These don't call `recordTurn` — they trim `turns` and call `rebuildUserGrid`, then must fold rule mutations to reach the fixpoint. Replace `applyAutoPlacements` with `applyRuleSteps(...).state`.

- [x] **Step 1: `undo`**

Replace (around line 839-850):

```typescript
export function undo(): PuzzleState {
  const state = requireConfirmed();
  if (state.turns.length === 0) throw new UserFacingError('Nothing to undo');
  const last = state.turns[state.turns.length - 1]!.action;
  if (last.type === 'placeDigit' && last.source === 'given') throw new UserFacingError('Cannot undo given digits');

  const trimmed: PuzzleState = { ...state, turns: state.turns.slice(0, -1) };
  let updated = rebuildUserGrid(trimmed);
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}
```

with:

```typescript
export function undo(): PuzzleState {
  const state = requireConfirmed();
  if (state.turns.length === 0) throw new UserFacingError('Nothing to undo');
  const last = state.turns[state.turns.length - 1]!.action;
  if (last.type === 'placeDigit' && last.source === 'given') throw new UserFacingError('Cannot undo given digits');

  const trimmed: PuzzleState = { ...state, turns: state.turns.slice(0, -1) };
  const updated = applyRuleSteps(rebuildUserGrid(trimmed)).state;
  setState(updated);
  return updated;
}
```

- [x] **Step 2: `rewind`**

Replace (around line 855-862):

```typescript
export function rewind(turnIdx: number): PuzzleState {
  const state = requireConfirmed();
  const trimmed: PuzzleState = { ...state, turns: state.turns.slice(0, turnIdx) };
  let updated = rebuildUserGrid(trimmed);
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}
```

with:

```typescript
export function rewind(turnIdx: number): PuzzleState {
  const state = requireConfirmed();
  const trimmed: PuzzleState = { ...state, turns: state.turns.slice(0, turnIdx) };
  const updated = applyRuleSteps(rebuildUserGrid(trimmed)).state;
  setState(updated);
  return updated;
}
```

- [x] **Step 3: Commit**

```bash
git add web/src/session/actions.ts
git commit -m "refactor: use applyRuleSteps in undo/rewind"
```

---

### Task 5: Update remaining direct `applyAutoPlacements` call sites

**Files:**
- Modify: `web/src/session/actions.ts`

`confirmPuzzle`, `refresh`, `eliminateCageSolution`, `eliminateVirtualCageSolution`, `eliminateVirtualCageDiffSolution` call `applyAutoPlacements` directly (no `recordTurn`/`rebuildUserGrid`). Replace with `applyRuleSteps(...).state`. The three `eliminate*` functions also have a pre-existing bug where `setState(updated)` is called with the *pre-fold* state while the *post-fold* state is returned but never persisted — fix this by folding before `setState`.

- [x] **Step 1: `confirmPuzzle`**

Replace (around line 570-573):

```typescript
  let updated: PuzzleState = PuzzleState.isKiller(state) ? confirmedKiller : confirmedClassic;
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}
```

with:

```typescript
  let updated: PuzzleState = PuzzleState.isKiller(state) ? confirmedKiller : confirmedClassic;
  updated = applyRuleSteps(updated).state;
  setState(updated);
  return updated;
}
```

- [x] **Step 2: `refresh`**

Replace (around line 1320-1325):

```typescript
export function refresh(): PuzzleState {
  const state = requireConfirmed();
  const updated = applyAutoPlacements(state);
  setState(updated);
  return updated;
}
```

with:

```typescript
export function refresh(): PuzzleState {
  const state = requireConfirmed();
  const updated = applyRuleSteps(state).state;
  setState(updated);
  return updated;
}
```

- [x] **Step 3: `eliminateCageSolution`**

Replace (around line 937-947):

```typescript
export function eliminateCageSolution(label: string, solution: number[]): PuzzleState {
  const state = requireConfirmed();
  if (!PuzzleState.isKiller(state)) throw new Error('eliminateCageSolution requires a killer puzzle state');
  const upper = label.toUpperCase();
  const newCages = state.cageStates.map(c =>
    c.label !== upper ? c : { ...c, userEliminatedSolns: toggleSolution(c.userEliminatedSolns, solution) },
  );
  const updated = { ...state, cageStates: newCages };
  setState(updated);
  return applyAutoPlacements(updated);
}
```

with:

```typescript
export function eliminateCageSolution(label: string, solution: number[]): PuzzleState {
  const state = requireConfirmed();
  if (!PuzzleState.isKiller(state)) throw new Error('eliminateCageSolution requires a killer puzzle state');
  const upper = label.toUpperCase();
  const newCages = state.cageStates.map(c =>
    c.label !== upper ? c : { ...c, userEliminatedSolns: toggleSolution(c.userEliminatedSolns, solution) },
  );
  const updated = applyRuleSteps({ ...state, cageStates: newCages }).state;
  setState(updated);
  return updated;
}
```

- [x] **Step 4: `eliminateVirtualCageSolution`**

Replace (around line 955-964):

```typescript
export function eliminateVirtualCageSolution(vcKey: string, solution: number[]): PuzzleState {
  const state = requireConfirmed();
  if (!PuzzleState.isKiller(state)) throw new Error('eliminateVirtualCageSolution requires a killer puzzle state');
  const newVCs = state.virtualCages.map(vc =>
    virtualCageKeyFromCage(vc) !== vcKey ? vc : { ...vc, eliminatedSolns: toggleSolution(vc.eliminatedSolns, solution) },
  );
  const updated = { ...state, virtualCages: newVCs };
  setState(updated);
  return applyAutoPlacements(updated);
}
```

with:

```typescript
export function eliminateVirtualCageSolution(vcKey: string, solution: number[]): PuzzleState {
  const state = requireConfirmed();
  if (!PuzzleState.isKiller(state)) throw new Error('eliminateVirtualCageSolution requires a killer puzzle state');
  const newVCs = state.virtualCages.map(vc =>
    virtualCageKeyFromCage(vc) !== vcKey ? vc : { ...vc, eliminatedSolns: toggleSolution(vc.eliminatedSolns, solution) },
  );
  const updated = applyRuleSteps({ ...state, virtualCages: newVCs }).state;
  setState(updated);
  return updated;
}
```

- [x] **Step 5: `eliminateVirtualCageDiffSolution`**

Replace (around line 967-984), the tail:

```typescript
  const updated = { ...state, virtualCages: newVCs };
  setState(updated);
  return applyAutoPlacements(updated);
}
```

with:

```typescript
  const updated = applyRuleSteps({ ...state, virtualCages: newVCs }).state;
  setState(updated);
  return updated;
}
```

(this is the tail of `eliminateVirtualCageDiffSolution` — the `newVCs` computation above it is unchanged)

- [x] **Step 6: Commit**

```bash
git add web/src/session/actions.ts
git commit -m "refactor: use applyRuleSteps in confirmPuzzle/refresh/eliminate* actions

Also fixes a pre-existing bug where eliminate{CageSolution,VirtualCageSolution,
VirtualCageDiffSolution} called setState with the pre-fold state while
returning the post-fold state, so the store never observed auto-placements
triggered by the elimination."
```

---

### Task 6: Delete `applyAutoPlacements`, `applyNextAutoPlacement`, `stepAutoPlacement` and update imports

**Files:**
- Modify: `web/src/session/engine.ts`
- Modify: `web/src/session/actions.ts`

- [x] **Step 1: Delete `applyAutoPlacements` and `applyNextAutoPlacement` from `engine.ts`**

In `web/src/session/engine.ts`, delete the two functions (originally lines 477-513, now directly before your new `applyRuleSteps`):

```typescript
// ---------------------------------------------------------------------------
// Auto-placement pass
// ---------------------------------------------------------------------------

/**
 * Runs the always-apply rules against the current state and returns an
 * updated PuzzleState with any newly placed digits committed to userGrid.
 */
export function applyAutoPlacements(state: PuzzleState): PuzzleState {
  if (state.goldenSolution === null) return state; // no-op before confirm
  const { engine } = buildEngine(state); // engine.solve() called inside buildEngine

  let changed = false;
  const newGrid = state.userGrid.map(row => [...row]);
  for (const p of engine.appliedPlacements) {
    const [r, c] = p.cell;
    if (newGrid[r]![c]! === 0) { newGrid[r]![c] = p.digit; changed = true; }
  }

  // Update userGrid only — no sentinel turn. Mirrors Python _apply_auto_placements.
  return changed ? { ...state, userGrid: newGrid } : state;
}

/**
 * Applies exactly one pending auto-placement to userGrid and returns the
 * updated state, or null if there are no more cells to auto-place.
 * Used by the UI animation loop when autoPlacementDelay > 0.
 */
export function applyNextAutoPlacement(state: PuzzleState): PuzzleState | null {
  if (state.goldenSolution === null) return null;
  const { engine } = buildEngine(state);
  for (const p of engine.appliedPlacements) {
    const [r, c] = p.cell;
    if (state.userGrid[r]![c]! === 0) {
      const newGrid = state.userGrid.map(row => [...row]);
      newGrid[r]![c] = p.digit;
      return { ...state, userGrid: newGrid };
    }
  }
  return null;
}
```

Also delete the now-orphaned `// Auto-placement pass` section header comment if it precedes `applyRuleSteps` after this deletion — replace it with `// Rule-step folding` as the section header for `applyRuleSteps`:

```typescript
// ---------------------------------------------------------------------------
// Rule-step folding
// ---------------------------------------------------------------------------
```

- [x] **Step 2: Delete `stepAutoPlacement` from `actions.ts`**

In `web/src/session/actions.ts`, delete (around line 818-829):

```typescript
/**
 * Applies exactly one pending auto-placement and persists it to the store.
 * Returns the updated state, or null if there are no more auto-placements.
 */
export function stepAutoPlacement(): PuzzleState | null {
  const state = getState();
  if (state === null) return null;
  const next = applyNextAutoPlacement(state);
  if (next === null) return null;
  setState(next);
  return next;
}
```

- [x] **Step 3: Update the import in `actions.ts`**

Replace (around line 27-36):

```typescript
import {
  buildEngine,
  applyAutoPlacements,
  applyNextAutoPlacement,
  recordTurn,
  rebuildUserGrid,
  userRemoved,
  userVirtualCages,
  findLastConsistentTurnIdx,
} from './engine.js';
```

with:

```typescript
import {
  buildEngine,
  applyRuleSteps,
  recordTurn,
  rebuildUserGrid,
  userRemoved,
  userVirtualCages,
  findLastConsistentTurnIdx,
} from './engine.js';
```

- [x] **Step 4: Run `tsc` to check for remaining references**

Run: `cd web && npx tsc --noEmit`
Expected: errors only in `main.ts` (still calling the old `enterCellStep` signature and importing `getNextAutoApplyStep`/`applyAutoApplyStep`, which still exist) and in test files not yet updated (`engine.test.ts`, `fuzz.test.ts`, `actions.test.ts`). These are fixed in Tasks 7-10.

- [x] **Step 5: Commit**

```bash
git add web/src/session/engine.ts web/src/session/actions.ts
git commit -m "refactor: delete applyAutoPlacements/applyNextAutoPlacement/stepAutoPlacement"
```

---

### Task 7: Update `engine.test.ts` — replace `applyAutoPlacements`/`applyNextAutoPlacement` test blocks

**Files:**
- Modify: `web/src/session/engine.test.ts`

- [x] **Step 1: Update the import**

Replace (around line 13-15):

```typescript
import {
  applyAutoPlacements,
  applyNextAutoPlacement,
  recordTurn,
```

with:

```typescript
import {
  applyRuleSteps,
  recordTurn,
```

(keep the rest of the import list — these are the first three named imports in a larger multi-line import; only these two names change)

- [x] **Step 2: Replace the test blocks**

Replace the entire region from the section header comment through the end of the `applyNextAutoPlacement` describe block (originally lines 349-499 — header comment, the two fixture functions `makeAlmostCompleteState`/`makeInternallyInconsistentState`, and the three `describe` blocks):

```typescript
// ---------------------------------------------------------------------------
// applyAutoPlacements / applyNextAutoPlacement — inconsistency guard
// ---------------------------------------------------------------------------

/** State with 80 cells placed (KNOWN_SOLUTION minus (0,0)) and NakedSingle active. */
function makeAlmostCompleteState(opts: { wrongAt?: [number, number] } = {}): KillerPuzzleState {
  const spec = makeTrivialSpec();
  const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
  userGrid[0]![0] = 0; // leave (0,0) blank — NakedSingle will deduce it
  if (opts.wrongAt) {
    const [wr, wc] = opts.wrongAt;
    const gold = KNOWN_SOLUTION[wr]![wc]!;
    userGrid[wr]![wc] = gold === 9 ? 1 : gold + 1; // wrong digit
  }
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

/** State with duplicate digits in userGrid and no goldenSolution — soundness assertion inactive. */
function makeInternallyInconsistentState(): KillerPuzzleState {
  const spec = makeTrivialSpec();
  const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
  userGrid[0]![0] = 0; // leave (0,0) blank — NakedSingle would place something
  // Force row 0 to have a duplicate: (0,1) gets the same digit as (0,2)
  userGrid[0]![1] = KNOWN_SOLUTION[0]![2]!; // row-duplicate
  return {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: ['NakedSingle', ...DEFAULT_ALWAYS_APPLY_RULES],
    // Real golden solution; the row-duplicate makes isUserCorrupted true,
    // which makes buildEngine disable the soundness assertion internally.
    goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
  };
}

describe('applyAutoPlacements — NakedSingle applies placement and peer eliminations', () => {
  it('places (0,0) with NakedSingle as the only always-apply rule (no separate CSE needed)', () => {
    // NakedSingle now handles both placement and peer elimination in one rule, so the
    // cascade works correctly without any separate CellSolutionElimination rule.
    const spec = makeTrivialSpec();
    const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
    userGrid[0]![0] = 0;
    const state: KillerPuzzleState = {
      specData: specToData(spec),
      cageStates: specToCageStates(spec),
      userGrid,
      virtualCages: [],
      turns: [],
      alwaysApplyRules: ['NakedSingle'],
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      givenDigits: null,
      originalImageUrl: null,
      warpedImageUrl: null,
      userRemovedCandidates: [],
    };
    const result = applyAutoPlacements(state);
    // NakedSingle is in alwaysApplyRules, so the cascade runs and (0,0) is placed.
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });
});

describe('applyAutoPlacements — continues even with wrong placements', () => {
  it('places the deducible digit when board is consistent', () => {
    const state = makeAlmostCompleteState();
    const result = applyAutoPlacements(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when userGrid has a row-duplicate — cage constraint overrides', () => {
    // Row 0 has a duplicate digit. The engine treats the board as-is.
    // The trivial spec gives (0,0) a 1-cell cage with total = KNOWN_SOLUTION[0][0],
    // so the cage constraint uniquely forces (0,0) regardless of the row duplicate.
    const state = makeInternallyInconsistentState();
    const result = applyAutoPlacements(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when a wrong digit is present elsewhere — treat as correct', () => {
    // Wrong digit at (0,1) — engine proceeds as if it were correct.
    // (0,0) is forced by its 1-cell cage constraint (total = KNOWN_SOLUTION[0][0]).
    const state = makeAlmostCompleteState({ wrongAt: [0, 1] });
    const result = applyAutoPlacements(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  itNS('places some digit in (0,0) when the golden candidate was explicitly eliminated', () => {
    // User removed the correct digit from (0,0). Engine continues as if that removal
    // is intentional — some other digit gets forced via remaining constraints.
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: KillerPuzzleState = {
      ...state,
      userRemovedCandidates: [[0, 0, gold]],
    };
    const result = applyAutoPlacements(stateWithElim);
    expect(result.userGrid![0]![0]).not.toBe(0); // some digit was placed
    expect(result.userGrid![0]![0]).not.toBe(gold); // not the golden digit
  });
});

describe('applyNextAutoPlacement — continues even with wrong placements', () => {
  it('places the next deducible digit when board is consistent', () => {
    const state = makeAlmostCompleteState();
    const result = applyNextAutoPlacement(state);
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when userGrid has a row-duplicate', () => {
    const result = applyNextAutoPlacement(makeInternallyInconsistentState());
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when a wrong digit is present elsewhere', () => {
    const state = makeAlmostCompleteState({ wrongAt: [0, 1] });
    const result = applyNextAutoPlacement(state);
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  itNS('places some non-golden digit in (0,0) when the golden candidate was eliminated', () => {
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: KillerPuzzleState = {
      ...state,
      userRemovedCandidates: [[0, 0, gold]],
    };
    const result = applyNextAutoPlacement(stateWithElim);
    expect(result).not.toBeNull();
    expect(result!.userGrid![0]![0]).not.toBe(gold);
  });
});
```

with:

```typescript
// ---------------------------------------------------------------------------
// applyRuleSteps — inconsistency guard
// ---------------------------------------------------------------------------

/** State with 80 cells placed (KNOWN_SOLUTION minus (0,0)) and NakedSingle active. */
function makeAlmostCompleteState(opts: { wrongAt?: [number, number] } = {}): KillerPuzzleState {
  const spec = makeTrivialSpec();
  const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
  userGrid[0]![0] = 0; // leave (0,0) blank — NakedSingle will deduce it
  if (opts.wrongAt) {
    const [wr, wc] = opts.wrongAt;
    const gold = KNOWN_SOLUTION[wr]![wc]!;
    userGrid[wr]![wc] = gold === 9 ? 1 : gold + 1; // wrong digit
  }
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

/** State with duplicate digits in userGrid and no goldenSolution — soundness assertion inactive. */
function makeInternallyInconsistentState(): KillerPuzzleState {
  const spec = makeTrivialSpec();
  const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
  userGrid[0]![0] = 0; // leave (0,0) blank — NakedSingle would place something
  // Force row 0 to have a duplicate: (0,1) gets the same digit as (0,2)
  userGrid[0]![1] = KNOWN_SOLUTION[0]![2]!; // row-duplicate
  return {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: ['NakedSingle', ...DEFAULT_ALWAYS_APPLY_RULES],
    // Real golden solution; the row-duplicate makes isUserCorrupted true,
    // which makes buildEngine disable the soundness assertion internally.
    goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
  };
}

describe('applyRuleSteps — NakedSingle applies placement and peer eliminations', () => {
  it('places (0,0) with NakedSingle as the only always-apply rule (no separate CSE needed)', () => {
    // NakedSingle now handles both placement and peer elimination in one rule, so the
    // cascade works correctly without any separate CellSolutionElimination rule.
    const spec = makeTrivialSpec();
    const userGrid = KNOWN_SOLUTION.map(row => [...row]) as number[][];
    userGrid[0]![0] = 0;
    const state: KillerPuzzleState = {
      specData: specToData(spec),
      cageStates: specToCageStates(spec),
      userGrid,
      virtualCages: [],
      turns: [],
      alwaysApplyRules: ['NakedSingle'],
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      givenDigits: null,
      originalImageUrl: null,
      warpedImageUrl: null,
      userRemovedCandidates: [],
    };
    const { state: result } = applyRuleSteps(state);
    // NakedSingle is in alwaysApplyRules, so the cascade runs and (0,0) is placed.
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });
});

describe('applyRuleSteps — continues even with wrong placements', () => {
  it('places the deducible digit when board is consistent', () => {
    const state = makeAlmostCompleteState();
    const { state: result } = applyRuleSteps(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when userGrid has a row-duplicate — cage constraint overrides', () => {
    // Row 0 has a duplicate digit. The engine treats the board as-is.
    // The trivial spec gives (0,0) a 1-cell cage with total = KNOWN_SOLUTION[0][0],
    // so the cage constraint uniquely forces (0,0) regardless of the row duplicate.
    const state = makeInternallyInconsistentState();
    const { state: result } = applyRuleSteps(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  it('still places (0,0) when a wrong digit is present elsewhere — treat as correct', () => {
    // Wrong digit at (0,1) — engine proceeds as if it were correct.
    // (0,0) is forced by its 1-cell cage constraint (total = KNOWN_SOLUTION[0][0]).
    const state = makeAlmostCompleteState({ wrongAt: [0, 1] });
    const { state: result } = applyRuleSteps(state);
    expect(result.userGrid![0]![0]).toBe(KNOWN_SOLUTION[0]![0]);
  });

  itNS('places some digit in (0,0) when the golden candidate was explicitly eliminated', () => {
    // User removed the correct digit from (0,0). Engine continues as if that removal
    // is intentional — some other digit gets forced via remaining constraints.
    const state = makeAlmostCompleteState();
    const gold = KNOWN_SOLUTION[0]![0]!;
    const stateWithElim: KillerPuzzleState = {
      ...state,
      userRemovedCandidates: [[0, 0, gold]],
    };
    const { state: result } = applyRuleSteps(stateWithElim);
    expect(result.userGrid![0]![0]).not.toBe(0); // some digit was placed
    expect(result.userGrid![0]![0]).not.toBe(gold); // not the golden digit
  });
});
```

- [x] **Step 3: Run the test file**

Run: `cd web && npx vitest run src/session/engine.test.ts`
Expected: PASS (all tests in the file).

- [x] **Step 4: Commit**

```bash
git add web/src/session/engine.test.ts
git commit -m "test: rename applyAutoPlacements/applyNextAutoPlacement tests to applyRuleSteps"
```

---

### Task 8: Update `fuzz.test.ts`

**Files:**
- Modify: `web/src/session/fuzz.test.ts`

- [x] **Step 1: Update the import**

Replace (line 28):

```typescript
import { rebuildUserGrid, applyAutoPlacements } from './engine.js';
```

with:

```typescript
import { rebuildUserGrid, applyRuleSteps } from './engine.js';
```

- [x] **Step 2: Update the round-trip check**

Replace (line 89):

```typescript
  const rebuilt = applyAutoPlacements(rebuildUserGrid(state));
```

with:

```typescript
  const rebuilt = applyRuleSteps(rebuildUserGrid(state)).state;
```

- [x] **Step 3: Update the doc comments**

Replace (line 12):

```typescript
 *   3. Round-trip consistency: rebuildUserGrid + applyAutoPlacements reproduces
```

with:

```typescript
 *   3. Round-trip consistency: rebuildUserGrid + applyRuleSteps reproduces
```

Replace (lines 86-88):

```typescript
  // 3. Round-trip: rebuildUserGrid + applyAutoPlacements == current userGrid.
  //    This verifies that the turn history fully encodes the explicit user
  //    placements and that auto-placements are deterministically re-derived.
```

with:

```typescript
  // 3. Round-trip: rebuildUserGrid + applyRuleSteps == current userGrid.
  //    This verifies that the turn history fully encodes the explicit user
  //    placements and that rule-driven deductions are deterministically re-derived.
```

- [x] **Step 4: Run the test file**

Run: `cd web && npx vitest run src/session/fuzz.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/session/fuzz.test.ts
git commit -m "test: update fuzz round-trip check to applyRuleSteps"
```

---

### Task 9: Update `actions.test.ts`

**Files:**
- Modify: `web/src/session/actions.test.ts`

- [x] **Step 1: Remove the `stepAutoPlacement` import**

Replace (around line 36, part of a larger multi-line import from `./actions.js`):

```typescript
  stepAutoPlacement,
```

Delete this line entirely from the import list.

- [x] **Step 2: Rewrite the fast-forward drain invariant test**

Replace the entire `describe('fast-forward drain invariant (#78)', ...)` block (around lines 623-650):

```typescript
// ---------------------------------------------------------------------------
// #78 – Fast-forward drain invariant
// Draining stepAutoPlacement() iteratively after enterCellStep() must reach
// the same final userGrid as enterCell() in a single call. This is the
// session-level contract the main.ts fast-forward fix relies on.
// ---------------------------------------------------------------------------

describe('fast-forward drain invariant (#78)', () => {
  beforeEach(() => { makeKillerConfirmed(); });

  it('stepAutoPlacement loop reaches same userGrid as enterCell', () => {
    const snapshot = getState()!;
    const r = 1, c = 1, digit = KNOWN_SOLUTION[0]![0]!;

    // Single-shot path
    setState(snapshot);
    enterCell(r, c, digit);
    const singleGrid = getState()!.userGrid;

    // Iterative drain path — what the fast-forward fix does in handleCellEntry
    setState(snapshot);
    enterCellStep(r, c, digit);
    while (stepAutoPlacement() !== null) { /* drain */ }
    const drainGrid = getState()!.userGrid;

    expect(drainGrid).toEqual(singleGrid);
  });
});
```

with:

```typescript
// ---------------------------------------------------------------------------
// #78 – Animated entry invariant
// enterCellStep() must commit the same final userGrid as enterCell() in a
// single call — the animated path folds the same ruleSteps via recordTurn,
// it just also returns them for the UI to animate.
// ---------------------------------------------------------------------------

describe('animated entry invariant (#78)', () => {
  beforeEach(() => { makeKillerConfirmed(); });

  it('enterCellStep commits the same userGrid as enterCell', () => {
    const snapshot = getState()!;
    const r = 1, c = 1, digit = KNOWN_SOLUTION[0]![0]!;

    // Single-shot path
    setState(snapshot);
    enterCell(r, c, digit);
    const singleGrid = getState()!.userGrid;

    // Animated entry point
    setState(snapshot);
    const { state } = enterCellStep(r, c, digit);
    expect(getState()!.userGrid).toEqual(state.userGrid);

    expect(state.userGrid).toEqual(singleGrid);
  });
});
```

- [x] **Step 3: Update the Bug #60 comment**

Replace (around lines 511-525):

```typescript
// ---------------------------------------------------------------------------
// Bug #60 — addVirtualCage skips applyAutoPlacements
// ---------------------------------------------------------------------------

describe('Bug #60 regression — addVirtualCage triggers auto-placements', () => {
  // Setup: makeBoxCageSpec (9 box-cages total=45 each) confirmed with NakedSingle
  // in alwaysApplyRules. At confirm all 81 cells stay empty because no cage forces
  // any individual cell (every permutation of {1..9} satisfies each box cage).
  //
  // We then directly set 8 of 9 cells in box-0 via setState (bypassing enterCell
  // so applyAutoPlacements doesn't run yet). This leaves (0,0) as the sole empty
  // cell in its box — a naked single whose digit NakedSingle can determine.
  //
  // addVirtualCage must call applyAutoPlacements so NakedSingle fires and (0,0)
  // is placed. Before the fix it was missing that call so (0,0) stayed 0.
  //
  // Cells are populated from goldenSolution (not KNOWN_SOLUTION) so that the
  // candidate-soundness assertion in the engine never fires.
```

with:

```typescript
// ---------------------------------------------------------------------------
// Bug #60 — addVirtualCage skips the rule-folding pass
// ---------------------------------------------------------------------------

describe('Bug #60 regression — addVirtualCage triggers auto-placements', () => {
  // Setup: makeBoxCageSpec (9 box-cages total=45 each) confirmed with NakedSingle
  // in alwaysApplyRules. At confirm all 81 cells stay empty because no cage forces
  // any individual cell (every permutation of {1..9} satisfies each box cage).
  //
  // We then directly set 8 of 9 cells in box-0 via setState (bypassing enterCell
  // so recordTurn's rule-folding doesn't run yet). This leaves (0,0) as the sole
  // empty cell in its box — a naked single whose digit NakedSingle can determine.
  //
  // addVirtualCage must fold ruleSteps via recordTurn so NakedSingle fires and
  // (0,0) is placed. Before the fix it was missing that call so (0,0) stayed 0.
  //
  // Cells are populated from goldenSolution (not KNOWN_SOLUTION) so that the
  // candidate-soundness assertion in the engine never fires.
```

Replace (around line 557):

```typescript
  itNS('addVirtualCage triggers applyAutoPlacements — NakedSingle places (0,0)', () => {
```

with:

```typescript
  itNS('addVirtualCage triggers rule-folding — NakedSingle places (0,0)', () => {
```

- [x] **Step 4: Run the test file**

Run: `cd web && npx vitest run src/session/actions.test.ts`
Expected: PASS (all tests).

- [x] **Step 5: Commit**

```bash
git add web/src/session/actions.test.ts
git commit -m "test: update actions.test.ts for enterCellStep's new return shape"
```

---

### Task 10: Minimal `main.ts` compile fix for `enterCellStep`'s new return shape

**Files:**
- Modify: `web/src/main.ts`

This task only adapts `handleCellEntry`'s animated branch to the new `enterCellStep` return shape, preserving today's animation behaviour (still driven by `getNextAutoApplyStep`/`applyAutoApplyStep`, unchanged in this sprint). It removes the now-incorrect `preAnimationRemoved` save/restore hack, since `recordTurn` now persists rule-driven eliminations correctly by design. Sprint B replaces this block's internals with `AnimationPlayer`.

- [x] **Step 1: Update the animated branch**

Replace (around lines 1504-1551):

```typescript
        let state = enterCellStep(selectedCell.row, selectedCell.col, digit);
        // Save the pre-animation userRemovedCandidates so animation-only eliminations
        // (accumulated by applyAutoApplyStep) can be discarded at cleanup without
        // losing candidates the user manually eliminated before this animation started.
        const preAnimationRemoved = state.userRemovedCandidates;
        currentState = state;
        animRefresh(currentState);
        updateUndoButton(state);
        await new Promise<void>(resolve => { setTimeout(resolve, fastForwardRequested ? 0 : delay); });
        while (true) {
          const step = getNextAutoApplyStep(currentState);
          if (step === null) break;

          if (fastForwardRequested) {
            currentState = applyAutoApplyStep(currentState, step);
            continue;
          }

          // Show hint pill + highlight for this rule, then wait.
          hintHighlightCells = new Set(step.highlightCells.map(([r, c]) => `${r},${c}`));
          hintElimCells = new Set(
            step.mutations
              .filter((m): m is EliminateCandidateMutation => m.type === 'eliminateCandidate')
              .map(m => `${m.row},${m.col}`),
          );
          showHintPill(el('hint-pill'), el('hint-pill-label'), step.displayName);
          animRefresh(currentState);
          await new Promise<void>(resolve => { setTimeout(resolve, delay); });

          // Apply the rule's changes and immediately show the result before next step.
          currentState = applyAutoApplyStep(currentState, step);
          hintHighlightCells = new Set();
          hintElimCells = new Set();
          hideHintPill(el('hint-pill'));
          animRefresh(currentState);
        }
        // Final cleanup after all steps (or fast-forward drain).
        // Commit the auto-placed digits in userGrid and restore userRemovedCandidates
        // to the pre-animation snapshot, discarding the transient animation-only
        // eliminations (buildEngine's full-solve pass will recompute them).
        hideHintPill(el('hint-pill'));
        hintHighlightCells = new Set();
        hintElimCells = new Set();
        const finalState: PuzzleState = { ...currentState, userRemovedCandidates: preAnimationRemoved };
        setState(finalState);
        currentState = finalState;
        refreshDisplay();
        updateUndoButton(currentState);
```

with:

```typescript
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

          // Show hint pill + highlight for this rule, then wait.
          hintHighlightCells = new Set(step.highlightCells.map(([r, c]) => `${r},${c}`));
          hintElimCells = new Set(
            step.mutations
              .filter((m): m is EliminateCandidateMutation => m.type === 'eliminateCandidate')
              .map(m => `${m.row},${m.col}`),
          );
          showHintPill(el('hint-pill'), el('hint-pill-label'), step.displayName);
          animRefresh(currentState);
          await new Promise<void>(resolve => { setTimeout(resolve, delay); });

          // Apply the rule's changes and immediately show the result before next step.
          currentState = applyAutoApplyStep(currentState, step);
          hintHighlightCells = new Set();
          hintElimCells = new Set();
          hideHintPill(el('hint-pill'));
          animRefresh(currentState);
        }
        // Final cleanup after all steps (or fast-forward drain). enterCellStep already
        // committed the fully-folded final state to the store via recordTurn —
        // just resync currentState and redraw.
        hideHintPill(el('hint-pill'));
        hintHighlightCells = new Set();
        hintElimCells = new Set();
        currentState = committedState;
        refreshDisplay();
        updateUndoButton(currentState);
```

- [x] **Step 2: Run `tsc`**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no errors). If `PuzzleState` is now an unused import in `main.ts` because `finalState: PuzzleState` was the only annotated use, check with:

Run: `cd web && npx tsc --noEmit 2>&1 | grep -i "main.ts"`
Expected: no output. (`PuzzleState` is used elsewhere in `main.ts` for `currentState`'s type, so this should be a non-issue — but verify.)

- [x] **Step 3: Run the full unit test suite**

Run: `cd web && npm test`
Expected: PASS (all test files).

- [x] **Step 4: Commit**

```bash
git add web/src/main.ts
git commit -m "fix: adapt handleCellEntry to enterCellStep's new return shape

Drops the preAnimationRemoved save/restore hack — recordTurn now persists
rule-driven eliminations into userRemovedCandidates by design, so there is
no 'transient animation-only' state to discard. Animation still uses
getNextAutoApplyStep/applyAutoApplyStep against baseState; Sprint B replaces
this with AnimationPlayer."
```

---

### Task 11: Bronze gate and final verification

**Files:** none (verification only)

- [x] **Step 1: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh` (from repo root)
Expected: `tsc --noEmit` (both configs) and `npm test` all pass, producing `.bronze-gate-ok`.

- [x] **Step 2: Note known transient UX gap**

The animated entry path (`autoPlacementDelay > 0`) currently shows hint-pill animation only for rule steps not already folded by `recordTurn` — since `recordTurn` now folds everything, `getNextAutoApplyStep(baseState)` still produces the same `ruleSteps` as before (computed from `baseState`, which is pre-fold), so animation should behave identically to pre-Sprint-A. No action needed; this is verified functionally by Task 10's tsc/test pass and visually in Sprint B's Playwright run.

- [x] **Step 3: No commit needed for this task** — verification only.

---

## Sprint A Done — Next

Sprint A is complete once Task 11 passes. Proceed to
`docs/superpowers/plans/2026-06-12-execution-path-unification-sprint-b.md`
for the `main.ts` `AnimationPlayer` wiring.
