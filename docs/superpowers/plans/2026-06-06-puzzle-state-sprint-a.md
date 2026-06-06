# Puzzle State Redesign — Sprint A: State Field Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mutable `autoRemovedCandidates` animation side-channel with an explicit `userRemovedCandidates` field, making `PuzzleState` self-contained and `buildEngine()` a pure function of the current snapshot.

**Architecture:** Add `userRemovedCandidates` to `PuzzleState` and maintain it directly in `UserAction.apply()`. Update `buildEngine()` to read from this field instead of replaying turns via `userRemoved()`. Undo reconstructs `userRemovedCandidates` from turns in `rebuildUserGrid()`. This sprint leaves the animation paths (`getNextAutoApplyStep`, `applyAutoApplyStep`) functional but migrated to the new field — Sprint B will replace them with the VCR player.

**Tech Stack:** TypeScript, Vitest. Run tests with `cd web && npm test`. Run type-check with `cd web && npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md` §1 (State Model)

---

## File Map

| File | Change |
|---|---|
| `web/src/session/types.ts` | Remove `autoRemovedCandidates`; add `userRemovedCandidates`; update `UserAction.apply()` for 4 action types |
| `web/src/session/engine.ts` | Update `isUserCorrupted()`, `buildEngine()`, `applyAutoApplyStep()`, `rebuildUserGrid()`; simplify `userRemoved()` |
| `web/src/session/actions.ts` | Replace `autoRemovedCandidates: []` with `userRemovedCandidates: []` at 3 initialization sites |
| `web/src/session/engine.test.ts` | Rename field in fixtures; rewrite 2 golden-filter tests to reflect new behaviour |
| `web/src/session/engine.autoApply.test.ts` | Rename field in fixtures and assertions |
| `web/src/session/actions.test.ts` | Rename field in 6 fixtures |
| `web/src/session/fuzz.test.ts` | Rename field in 1 fixture |

---

### Task 1: Update `PuzzleState` — remove old field, add new field

**Files:**
- Modify: `web/src/session/types.ts:248-265`

The `autoRemovedCandidates` field is replaced by `userRemovedCandidates`. The four action types that previously returned `state` unchanged in `UserAction.apply()` now update the new field.

- [ ] **Step 1: Write the failing test**

Add to `web/src/session/engine.test.ts` in a new `describe('userRemovedCandidates in UserAction.apply', ...)` block:

```typescript
import type {
  EliminateCandidateAction, RestoreCandidateAction,
  ResetCellCandidatesAction, ApplyHintAction,
} from './types.js';

describe('userRemovedCandidates in UserAction.apply', () => {
  const base = (): PuzzleState => ({
    ...makeBaseState(),   // existing helper in engine.test.ts
    userRemovedCandidates: [],
  });

  it('eliminateCandidate adds triple to userRemovedCandidates', () => {
    const action: EliminateCandidateAction = { type: 'eliminateCandidate', row: 0, col: 0, digit: 5 };
    const next = UserAction.apply(action, base());
    expect(next.userRemovedCandidates).toEqual([[0, 0, 5]]);
  });

  it('restoreCandidate removes the most-recent matching triple', () => {
    const state: PuzzleState = { ...base(), userRemovedCandidates: [[0,0,5],[0,0,5]] };
    const action: RestoreCandidateAction = { type: 'restoreCandidate', row: 0, col: 0, digit: 5 };
    const next = UserAction.apply(action, state);
    expect(next.userRemovedCandidates).toEqual([[0,0,5]]);
  });

  it('resetCellCandidates removes all triples for that cell', () => {
    const state: PuzzleState = { ...base(), userRemovedCandidates: [[0,0,5],[0,0,7],[1,1,3]] };
    const action: ResetCellCandidatesAction = { type: 'resetCellCandidates', row: 0, col: 0 };
    const next = UserAction.apply(action, state);
    expect(next.userRemovedCandidates).toEqual([[1,1,3]]);
  });

  it('applyHint appends all eliminations', () => {
    const action: ApplyHintAction = { type: 'applyHint', eliminations: [[2,3,4],[5,6,7]] };
    const next = UserAction.apply(action, base());
    expect(next.userRemovedCandidates).toEqual([[2,3,4],[5,6,7]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- --reporter=verbose engine.test
```

Expected: TypeScript compile error — `userRemovedCandidates` does not exist on `PuzzleState`, and `autoRemovedCandidates` is still required.

- [ ] **Step 3: Update `PuzzleState` interface in `types.ts`**

In `web/src/session/types.ts`, replace the `autoRemovedCandidates` field (lines ~248–256) with `userRemovedCandidates`:

```typescript
  /**
   * [row, col, digit] triples explicitly removed by the user via
   * eliminateCandidate / applyHint actions, minus any subsequently restored.
   * Maintained directly by UserAction.apply() — no turn-replay needed.
   */
  readonly userRemovedCandidates: readonly [number, number, number][];
```

Remove these lines entirely:
```typescript
  /**
   * [row, col, digit] triples eliminated automatically during the rule-by-rule
   * animation. Applied by buildEngine on every call so each solver step sees
   * previously applied eliminations and does not re-produce them.
   * Rolled back automatically when the user undoes (snapshot restoration).
   */
  readonly autoRemovedCandidates: readonly [number, number, number][];
```

- [ ] **Step 4: Update `UserAction.apply()` in `types.ts`**

In `web/src/session/types.ts`, the `UserAction.apply()` switch currently has these cases returning `state` unchanged:

```typescript
      case 'eliminateCandidate':
      case 'restoreCandidate':
      case 'resetCellCandidates':
      case 'applyHint':
        return state;
```

Replace with:

```typescript
      case 'eliminateCandidate':
        return {
          ...state,
          userRemovedCandidates: [
            ...state.userRemovedCandidates,
            [action.row, action.col, action.digit] as [number, number, number],
          ],
        };
      case 'restoreCandidate': {
        const list = [...state.userRemovedCandidates];
        const idx = [...list]
          .reverse()
          .findIndex(([r, c, d]) => r === action.row && c === action.col && d === action.digit);
        if (idx !== -1) list.splice(list.length - 1 - idx, 1);
        return { ...state, userRemovedCandidates: list };
      }
      case 'resetCellCandidates':
        return {
          ...state,
          userRemovedCandidates: state.userRemovedCandidates.filter(
            ([r, c]) => !(r === action.row && c === action.col),
          ),
        };
      case 'applyHint':
        return {
          ...state,
          userRemovedCandidates: [...state.userRemovedCandidates, ...action.eliminations],
        };
```

- [ ] **Step 5: Run type-check to find all broken callsites**

```bash
cd web && npx tsc --noEmit 2>&1 | head -60
```

Expected: errors at every `PuzzleState` literal that still uses `autoRemovedCandidates` or omits `userRemovedCandidates`. Each error message includes the file and line number — work through them in Tasks 2–4.

- [ ] **Step 6: Run the new tests to confirm they now pass**

```bash
cd web && npm test -- --reporter=verbose engine.test
```

Expected: the 4 new tests in the `userRemovedCandidates in UserAction.apply` block pass.

- [ ] **Step 7: Commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh
git add web/src/session/types.ts web/src/session/engine.test.ts
git commit -m "refactor: add userRemovedCandidates to PuzzleState, update UserAction.apply"
```

---

### Task 2: Update `engine.ts` — migrate all references

**Files:**
- Modify: `web/src/session/engine.ts`

- [ ] **Step 1: Update `isUserCorrupted()`**

In `web/src/session/engine.ts`, `isUserCorrupted()` currently calls `userRemoved(state)` to check if the user removed a golden digit. Replace with a direct read:

```typescript
// Replace:
  for (const [r, c, d] of userRemoved(state)) {
    if (goldenSolution[r]![c]! === d) return true;
  }

// With:
  for (const [r, c, d] of state.userRemovedCandidates) {
    if (goldenSolution[r]![c]! === d) return true;
  }
```

- [ ] **Step 2: Update `buildEngine()` — replace the removed+autoRemoved block**

In `web/src/session/engine.ts`, `buildEngine()` currently builds the removed list as:

```typescript
    const autoRemoved = state.autoRemovedCandidates ?? [];
    const safeAutoRemoved = activeGolden !== null
      ? autoRemoved.filter(([r, c, d]) => activeGolden[r]?.[c] !== d)
      : autoRemoved;

    const removed = [...userRemoved(state), ...safeAutoRemoved];
```

Replace with:

```typescript
    const removed = [...state.userRemovedCandidates];
```

The safety filter is no longer needed: `userRemovedCandidates` contains only user-driven eliminations, not rule-generated ones. If a user removes a golden-solution digit, `isUserCorrupted()` already detects it and sets `activeGolden = null`, disabling golden checks.

Also remove the comment block above the deleted lines.

- [ ] **Step 3: Simplify `userRemoved()` export**

The `userRemoved()` function currently replays all turns via `updateRemovedList`. It is still used by external callers (e.g. action log). Simplify it to read from state directly:

```typescript
/**
 * Returns user-explicitly-removed candidates from state.
 * Kept for backwards compatibility — prefer reading state.userRemovedCandidates directly.
 */
export function userRemoved(state: PuzzleState): [number, number, number][] {
  return [...state.userRemovedCandidates];
}
```

- [ ] **Step 4: Update `applyAutoApplyStep()` — use `userRemovedCandidates`**

`applyAutoApplyStep()` currently accumulates into `autoRemovedCandidates`. Migrate to `userRemovedCandidates` (Sprint B will remove this function entirely):

```typescript
export function applyAutoApplyStep(state: PuzzleState, step: RuleStep): PuzzleState {
  const newGrid = state.userGrid!.map(row => [...row]);
  for (const p of step.placements) newGrid[p.cell[0]]![p.cell[1]] = p.digit;
  return {
    ...state,
    userGrid: newGrid,
    userRemovedCandidates: [
      ...state.userRemovedCandidates,
      ...step.eliminations.map(e => [e.cell[0], e.cell[1], e.digit] as [number, number, number]),
    ],
  };
}
```

- [ ] **Step 5: Update `rebuildUserGrid()` — reconstruct `userRemovedCandidates`**

`rebuildUserGrid()` is called by `undo()` and `rewind()`. It currently rebuilds `userGrid` and `virtualCages` from turns, but does not reset `autoRemovedCandidates` — the root undo bug. Now it also reconstructs `userRemovedCandidates`:

```typescript
export function rebuildUserGrid(state: PuzzleState): PuzzleState {
  if (state.userGrid === null) return state;
  const newGrid: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  for (const turn of state.turns) {
    UserAction.applyToGrid(turn.action, newGrid);
  }

  const existingElims = new Map(
    state.virtualCages.map(vc => [virtualCageKeyFromCage(vc), vc.eliminatedSolns]),
  );
  const rebuiltVCs = userVirtualCages(state);
  const mergedVCs = rebuiltVCs.map(vc => {
    const key = virtualCageKeyFromCage(vc);
    return { ...vc, eliminatedSolns: existingElims.get(key) ?? vc.eliminatedSolns };
  });

  // Reconstruct userRemovedCandidates from the trimmed turn history.
  // This fixes the undo bug where eliminated candidates persisted across undo.
  const removed: [number, number, number][] = [];
  for (const turn of state.turns) {
    UserAction.updateRemovedList(turn.action, removed);
  }

  return { ...state, userGrid: newGrid, virtualCages: mergedVCs, userRemovedCandidates: removed };
}
```

- [ ] **Step 6: Run type-check**

```bash
cd web && npx tsc --noEmit 2>&1 | grep "engine.ts"
```

Expected: no errors in `engine.ts`.

- [ ] **Step 7: Commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh
git add web/src/session/engine.ts
git commit -m "refactor: migrate engine.ts to userRemovedCandidates"
```

---

### Task 3: Update `actions.ts` — fix initialization sites

**Files:**
- Modify: `web/src/session/actions.ts`

There are 3 places where a `PuzzleState` literal is created, each with `autoRemovedCandidates: []`.

- [ ] **Step 1: Update all 3 initialization sites**

In `web/src/session/actions.ts`, find and replace all occurrences:

```typescript
// Replace (appears 3 times, at lines ~148, ~185, ~373):
    autoRemovedCandidates: [],

// With:
    userRemovedCandidates: [],
```

Also update the comment at line ~759:
```typescript
// Replace:
 * eliminated so far (user placements + autoRemovedCandidates), giving a

// With:
 * eliminated so far (user placements + userRemovedCandidates), giving a
```

- [ ] **Step 2: Run type-check**

```bash
cd web && npx tsc --noEmit 2>&1 | grep "actions.ts"
```

Expected: no errors in `actions.ts`.

- [ ] **Step 3: Commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh
git add web/src/session/actions.ts
git commit -m "refactor: replace autoRemovedCandidates initialization in actions.ts"
```

---

### Task 4: Update tests — rename field and rewrite changed-behaviour tests

**Files:**
- Modify: `web/src/session/engine.test.ts`
- Modify: `web/src/session/engine.autoApply.test.ts`
- Modify: `web/src/session/actions.test.ts`
- Modify: `web/src/session/fuzz.test.ts`

- [ ] **Step 1: Update fixture field names across all test files**

In each file, replace `autoRemovedCandidates` with `userRemovedCandidates` in state literal objects. These are mechanical substitutions — do not change test logic.

Files and approximate locations:
- `engine.test.ts` lines ~41, ~297, ~309, ~357, ~380, ~403, ~518, ~559
- `engine.autoApply.test.ts` lines ~40, ~61, ~73, ~83, ~123
- `actions.test.ts` lines ~87, ~107, ~469, ~509, ~544, ~730, ~786
- `fuzz.test.ts` line ~51

- [ ] **Step 2: Rewrite the two golden-filter tests in `engine.test.ts`**

The old tests verified that `autoRemovedCandidates` containing a golden digit was silently filtered. The new behaviour: `userRemovedCandidates` is applied directly; golden checks are disabled via `isUserCorrupted()` when a golden digit is present.

Find the describe block containing `'filters autoRemovedCandidates that violate the golden solution'` and `'applies autoRemovedCandidates that do NOT violate the golden solution'`. Replace both tests:

```typescript
describe('buildEngine with userRemovedCandidates', () => {
  it('applies userRemovedCandidates that do not match the golden solution', () => {
    const gold = KNOWN_SOLUTION[0]![0]!;
    const nonGold = gold === 9 ? 1 : gold + 1;
    const state: PuzzleState = {
      ...makeBaseState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userRemovedCandidates: [[0, 0, nonGold]],
    };
    const { board } = buildEngine(state);
    expect([...board.cands(0, 0)]).not.toContain(nonGold);
  });

  it('applies userRemovedCandidates that match the golden solution (isUserCorrupted disables golden checks)', () => {
    const gold = KNOWN_SOLUTION[0]![0]!;
    const state: PuzzleState = {
      ...makeBaseState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userRemovedCandidates: [[0, 0, gold]],
    };
    // isUserCorrupted() detects this and disables golden solution checks.
    // The golden digit IS removed from the board (user explicitly removed it).
    const { board } = buildEngine(state);
    expect([...board.cands(0, 0)]).not.toContain(gold);
  });
});
```

- [ ] **Step 3: Update `engine.autoApply.test.ts` assertions**

Find all assertions that reference `autoRemovedCandidates` on the result state and rename them:

```typescript
// Replace:
    expect(next.autoRemovedCandidates).toContainEqual([1, 2, 7]);
// With:
    expect(next.userRemovedCandidates).toContainEqual([1, 2, 7]);

// Replace:
    expect(next.autoRemovedCandidates).toContainEqual([3, 4, 9]);
    expect(next.autoRemovedCandidates).toContainEqual([1, 1, 5]);
// With:
    expect(next.userRemovedCandidates).toContainEqual([3, 4, 9]);
    expect(next.userRemovedCandidates).toContainEqual([1, 1, 5]);
```

Also update the `describe` block title and comments:
```typescript
// Replace:
describe('buildEngine with autoRemovedCandidates', () => {
// With:
describe('buildEngine with userRemovedCandidates', () => {
```

- [ ] **Step 4: Run all tests**

```bash
cd web && npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: `537 passed` (533 original + 4 added in Task 1 — Task 4 renames fields only, adds no new tests).

- [ ] **Step 5: Run full type-check**

```bash
cd web && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh
git add web/src/session/engine.test.ts web/src/session/engine.autoApply.test.ts \
        web/src/session/actions.test.ts web/src/session/fuzz.test.ts
git commit -m "test: migrate test fixtures from autoRemovedCandidates to userRemovedCandidates"
```

---

### Task 5: Verify undo bug is fixed

The undo bug: eliminating a candidate, then undoing, still showed the candidate as eliminated because `autoRemovedCandidates` was not reset. With `userRemovedCandidates` reconstructed from turns in `rebuildUserGrid()`, this is now fixed.

- [ ] **Step 1: Write a regression test**

Add to `web/src/session/actions.test.ts` in the undo describe block:

```typescript
it('undo after eliminateCandidate restores the candidate', async () => {
  // Start from a confirmed killer state (use existing baseState fixture)
  setState(baseState);          // baseState is defined earlier in the file
  await confirm();

  // Eliminate candidate digit 5 from r1c1 (0-based: row 0, col 0)
  cycleCandidate(1, 1, 5);     // 1-based row/col

  let state = getState()!;
  expect(state.userRemovedCandidates).toContainEqual([0, 0, 5]);

  // Undo — candidate must be restored
  undo();
  state = getState()!;
  expect(state.userRemovedCandidates).not.toContainEqual([0, 0, 5]);
});
```

- [ ] **Step 2: Run the regression test**

```bash
cd web && npm test -- --reporter=verbose actions.test
```

Expected: the new test passes (the bug was fixed in Task 2 Step 5).

- [ ] **Step 3: Run the full bronze gate**

```bash
cd .. && bash scripts/run-bronze-gate.sh
```

Expected: all 538 tests pass (533 original + 4 from Task 1 + 1 new regression).

- [ ] **Step 4: Commit**

```bash
git add web/src/session/actions.test.ts
git commit -m "test: regression test — undo after eliminateCandidate restores candidate"
```

---

## Sprint A Complete

Sprint A delivers:
- `userRemovedCandidates` is an explicit field on `PuzzleState`, maintained by `UserAction.apply()`
- `buildEngine()` reads `state.userRemovedCandidates` directly — no turn replay, no safety filter
- `undo()` and `rewind()` correctly restore `userRemovedCandidates` via `rebuildUserGrid()`
- `autoRemovedCandidates` is gone from the codebase
- All existing tests pass; undo bug regression test added

**Next:** Sprint B — collapse the three animation paths (`applyAutoPlacements`, `applyNextAutoPlacement`, `getNextAutoApplyStep`) into one, make `buildEngine()` return `ruleSteps`, and replace `applyAutoApplyStep()` with the VCR animation player.
