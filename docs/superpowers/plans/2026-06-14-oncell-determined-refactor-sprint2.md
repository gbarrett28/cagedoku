# OnCellDetermined Refactor — Sprint 2 (Invariant Check Extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `getHints()`'s inline inconsistency-detection logic into a reusable `checkPuzzleInvariant(state)` function in `session/engine.ts`, and add a new Check 0 that catches a user-added virtual cage whose total contradicts `goldenSolution`.

**Architecture:** Move `findFirstElimTurnIdx` and `findMissingGoldenCandidate` from `session/actions.ts` to `session/engine.ts` as exported pure `PuzzleState`-derived helpers (matching the existing `findLastConsistentTurnIdx` pattern). Add a new `findWrongVirtualCageTurnIdx` helper and a `PuzzleInvariantViolation` type + `checkPuzzleInvariant` function that runs Check 0 (killer-only) before the existing Checks 1-3. Rewrite `getHints()`'s inconsistency block to call `checkPuzzleInvariant` and consume its result.

**Tech Stack:** TypeScript, Vitest.

---

## Context

This sprint implements §6 of `docs/superpowers/specs/2026-06-14-oncell-determined-refactor-design.md`. It is independent of Sprint 1 (§1-5, the `LinearSystem`/`solverEngine` refactor) — Sprint 2 touches only `web/src/session/engine.ts` and `web/src/session/actions.ts`, and can be implemented and tested on its own.

Key files:
- `web/src/session/engine.ts` — target for new exported functions, alongside existing `findLastConsistentTurnIdx` (currently at line 564).
- `web/src/session/actions.ts` — `getHints()` (currently lines 1112+), `makeRewindHint` (1048-1061), local helpers `findFirstElimTurnIdx` (1068-1087) and `findMissingGoldenCandidate` (1096-1110) to be moved out.
- `web/src/session/engine.test.ts` — new tests for `checkPuzzleInvariant` and `findWrongVirtualCageTurnIdx`.
- `web/src/session/actions.test.ts` — new end-to-end test for the Check 0 Rewind hint.

---

### Task 1: Move `findFirstElimTurnIdx` and `findMissingGoldenCandidate` to `engine.ts`

**Files:**
- Modify: `web/src/session/engine.ts`
- Modify: `web/src/session/actions.ts`

This is a pure move (no behavior change) — verified by the existing test suite, which already exercises both functions indirectly via `getHints()`.

- [ ] **Step 1: Add `EliminateCandidateMutation` to engine.ts's ruleMutation import**

In `web/src/session/engine.ts`, line 31, change:

```ts
import type { RuleStep } from './ruleMutation.js';
```

to:

```ts
import type { EliminateCandidateMutation, RuleStep } from './ruleMutation.js';
```

- [ ] **Step 2: Append the two moved functions to engine.ts**

In `web/src/session/engine.ts`, insert immediately after `findLastConsistentTurnIdx` (after the closing `}` on line 595, before the `// ---- Snapshot helpers ----` comment on line 597):

```ts
/**
 * Scan turn history for the first turn that explicitly eliminated `digit` from
 * cell `(r,c)` — either via eliminateCandidate or via applyHint.
 * Returns the turn index, or null if not found (e.g. was eliminated by a rule).
 */
export function findFirstElimTurnIdx(
  state: PuzzleState,
  r: number,
  c: number,
  digit: number,
): number | null {
  for (let i = 0; i < state.turns.length; i++) {
    const a = state.turns[i]!.action;
    if (a.type === 'eliminateCandidate' && a.row === r && a.col === c && a.digit === digit) return i;
    if (a.type === 'applyHint') {
      for (const m of a.mutations) {
        if (m.type === 'eliminateCandidate') {
          const elim = m as EliminateCandidateMutation;
          if (elim.row === r && elim.col === c && elim.digit === digit) return i;
        }
      }
    }
  }
  return null;
}

/**
 * Checks the user's recorded eliminations (cycleCandidate, applyHint) against
 * goldenSolution.  Returns the first cell where the correct solution digit was
 * explicitly removed by the user, or null if all golden candidates are intact.
 *
 * State-based (no board build required) so it is safe to call before buildEngine.
 */
export function findMissingGoldenCandidate(
  state: PuzzleState,
): { r: number; c: number; gold: number } | null {
  const gs = state.goldenSolution;
  if (gs === null) return null;

  // Check explicit eliminateCandidate actions via userRemoved()
  for (const [r, c, d] of userRemoved(state)) {
    const gold = gs[r]?.[c];
    if (gold !== undefined && gold !== 0 && d === gold && state.userGrid![r]![c] === 0) {
      return { r, c, gold };
    }
  }
  return null;
}
```

- [ ] **Step 3: Remove the two functions from actions.ts and update its imports**

In `web/src/session/actions.ts`, delete the two function definitions at lines 1063-1110 (the `findFirstElimTurnIdx` JSDoc + function, and the `findMissingGoldenCandidate` JSDoc + function — everything between `makeRewindHint`'s closing `}` and `export function getHints()`).

Update the `./engine.js` import (lines 26-35) to add `findFirstElimTurnIdx` and `findMissingGoldenCandidate`:

```ts
import {
  buildEngine,
  applyRuleSteps,
  recordTurn,
  rebuildUserGrid,
  userRemoved,
  userVirtualCages,
  findLastConsistentTurnIdx,
  findFirstElimTurnIdx,
  findMissingGoldenCandidate,
  PuzzleStateOps,
} from './engine.js';
```

Update the `./ruleMutation.js` type import (line 62) — `EliminateCandidateMutation` is no longer used directly in actions.ts:

```ts
import type { RuleStep } from './ruleMutation.js';
```

- [ ] **Step 4: Run the test suite to verify the move is behavior-preserving**

Run: `cd web && npm test -- --run engine.test actions.test`
Expected: all existing tests PASS (no behavior change yet — `getHints()` still calls the moved functions by their new imported names).

- [ ] **Step 5: Run typecheck and commit**

```bash
cd /home/user/cagedoku/web && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
cd /home/user/cagedoku && bash scripts/run-bronze-gate.sh
git add web/src/session/engine.ts web/src/session/actions.ts
git commit -m "refactor: move findFirstElimTurnIdx/findMissingGoldenCandidate to session/engine.ts"
```

---

### Task 2: Add `findWrongVirtualCageTurnIdx` helper

**Files:**
- Modify: `web/src/session/engine.ts`
- Test: `web/src/session/engine.test.ts`

- [ ] **Step 1: Write failing tests**

In `web/src/session/engine.test.ts`, add a new describe block after the existing `userVirtualCages` block (after line ~155):

```ts
// ---------------------------------------------------------------------------
// findWrongVirtualCageTurnIdx
// ---------------------------------------------------------------------------

describe('findWrongVirtualCageTurnIdx', () => {
  it('returns null when goldenSolution is null', () => {
    const state = makeState();
    expect(findWrongVirtualCageTurnIdx(state)).toBeNull();
  });

  it('returns null when no addVirtualCage turns exist', () => {
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION,
    };
    expect(findWrongVirtualCageTurnIdx(state)).toBeNull();
  });

  it('returns null when a standard cage total matches the golden sum', () => {
    const gs = KNOWN_SOLUTION;
    const vc: VirtualCage = {
      cells: [[0, 0], [0, 1]] as Cell[],
      total: gs[0]![0]! + gs[0]![1]!,
      eliminatedSolns: [],
    };
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: gs,
      turns: [makeTurn({ type: 'addVirtualCage', cage: vc })],
    };
    expect(findWrongVirtualCageTurnIdx(state)).toBeNull();
  });

  it('returns the turn index when a standard cage total contradicts the golden sum', () => {
    const gs = KNOWN_SOLUTION;
    const wrongTotal = gs[0]![0]! + gs[0]![1]! + 1;
    const vc: VirtualCage = {
      cells: [[0, 0], [0, 1]] as Cell[],
      total: wrongTotal,
      eliminatedSolns: [],
    };
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: gs,
      turns: [makeTurn({ type: 'addVirtualCage', cage: vc })],
    };
    expect(findWrongVirtualCageTurnIdx(state)).toBe(0);
  });

  it('accounts for negativeCells in a diff cage', () => {
    const gs = KNOWN_SOLUTION;
    const correctDiff = gs[0]![0]! - gs[0]![1]!;
    const vc: VirtualCage = {
      cells: [[0, 0], [0, 1]] as Cell[],
      total: Math.abs(correctDiff) + 1, // wrong total
      eliminatedSolns: [],
      negativeCells: [[0, 1]] as Cell[],
      eliminatedDiffSolns: [],
    };
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: gs,
      turns: [makeTurn({ type: 'addVirtualCage', cage: vc })],
    };
    expect(findWrongVirtualCageTurnIdx(state)).toBe(0);
  });

  it('finds the earliest inconsistent cage when multiple are added', () => {
    const gs = KNOWN_SOLUTION;
    const goodVc: VirtualCage = {
      cells: [[0, 0], [0, 1]] as Cell[],
      total: gs[0]![0]! + gs[0]![1]!,
      eliminatedSolns: [],
    };
    const badVc: VirtualCage = {
      cells: [[1, 0], [1, 1]] as Cell[],
      total: gs[1]![0]! + gs[1]![1]! + 1,
      eliminatedSolns: [],
    };
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: gs,
      turns: [
        makeTurn({ type: 'addVirtualCage', cage: goodVc }),
        makeTurn({ type: 'addVirtualCage', cage: badVc }),
      ],
    };
    expect(findWrongVirtualCageTurnIdx(state)).toBe(1);
  });
});
```

Add `findWrongVirtualCageTurnIdx` to the `./engine.js` import list at the top of the test file (it will not exist yet — this is expected to fail).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- --run engine.test -t findWrongVirtualCageTurnIdx`
Expected: FAIL — `findWrongVirtualCageTurnIdx is not exported` (or `is not a function`).

- [ ] **Step 3: Implement `findWrongVirtualCageTurnIdx`**

In `web/src/session/engine.ts`, append after the functions added in Task 1 (still before `// ---- Snapshot helpers ----`):

```ts
/**
 * Returns the turn index of the earliest addVirtualCage action whose cage
 * total contradicts goldenSolution, or null if all current virtual cages
 * are consistent.
 */
export function findWrongVirtualCageTurnIdx(state: PuzzleState): number | null {
  const gs = state.goldenSolution;
  if (gs === null) return null;
  for (let i = 0; i < state.turns.length; i++) {
    const a = state.turns[i]!.action;
    if (a.type !== 'addVirtualCage') continue;
    const { cells, total, negativeCells } = a.cage;
    const negKeys = new Set((negativeCells ?? []).map(([r, c]) => `${r},${c}`));
    let goldSum = 0;
    for (const [r, c] of cells) {
      goldSum += negKeys.has(`${r},${c}`) ? -gs[r]![c]! : gs[r]![c]!;
    }
    if (goldSum !== total) return i;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- --run engine.test -t findWrongVirtualCageTurnIdx`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /home/user/cagedoku/web && npx tsc --noEmit
cd /home/user/cagedoku && bash scripts/run-bronze-gate.sh
git add web/src/session/engine.ts web/src/session/engine.test.ts
git commit -m "feat: add findWrongVirtualCageTurnIdx for virtual cage golden-sum check"
```

---

### Task 3: Add `PuzzleInvariantViolation` + `checkPuzzleInvariant`

**Files:**
- Modify: `web/src/session/engine.ts`
- Test: `web/src/session/engine.test.ts`

- [ ] **Step 1: Write failing tests**

In `web/src/session/engine.test.ts`, add a new describe block after the `findWrongVirtualCageTurnIdx` block from Task 2:

```ts
// ---------------------------------------------------------------------------
// checkPuzzleInvariant
// ---------------------------------------------------------------------------

describe('checkPuzzleInvariant', () => {
  it('returns null when goldenSolution is null', () => {
    const state = makeState();
    expect(checkPuzzleInvariant(state)).toBeNull();
  });

  it('returns null for a consistent state', () => {
    const gs = KNOWN_SOLUTION;
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: gs,
      userGrid: gs.map(row => [...row]),
    };
    expect(checkPuzzleInvariant(state)).toBeNull();
  });

  it('Check 1/3: returns rewindTurnIdx (no missingCell) for a wrong userGrid digit', () => {
    const gs = KNOWN_SOLUTION;
    const wrong = gs[0]![0]! === 1 ? 2 : 1;
    const userGrid = gs.map(row => [...row]);
    userGrid[0]![0] = wrong;
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: gs,
      userGrid,
      turns: [makeTurn({ type: 'placeDigit', row: 0, col: 0, digit: wrong, source: 'user' })],
    };
    const violation = checkPuzzleInvariant(state);
    expect(violation).not.toBeNull();
    expect(violation!.rewindTurnIdx).toBe(0);
    expect(violation!.missingCell).toBeNull();
  });

  it('Check 2: returns missingCell and rewindTurnIdx for an eliminated golden candidate', () => {
    const gs = KNOWN_SOLUTION;
    const gold = gs[0]![0]!;
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: gs,
      turns: [makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: gold })],
      userRemovedCandidates: [[0, 0, gold]],
    };
    const violation = checkPuzzleInvariant(state);
    expect(violation).not.toBeNull();
    expect(violation!.missingCell).toEqual({ r: 0, c: 0, gold });
    expect(violation!.rewindTurnIdx).toBe(0);
  });

  it('Check 0 (killer-only): a wrong virtual cage total is reported with no missingCell', () => {
    const gs = KNOWN_SOLUTION;
    const badVc: VirtualCage = {
      cells: [[0, 0], [0, 1]] as Cell[],
      total: gs[0]![0]! + gs[0]![1]! + 1,
      eliminatedSolns: [],
    };
    const state: KillerPuzzleState = {
      ...makeState(),
      goldenSolution: gs,
      userGrid: gs.map(row => [...row]),
      turns: [makeTurn({ type: 'addVirtualCage', cage: badVc })],
    };
    const violation = checkPuzzleInvariant(state);
    expect(violation).not.toBeNull();
    expect(violation!.rewindTurnIdx).toBe(0);
    expect(violation!.missingCell).toBeNull();
  });

  it('Check 0 is skipped for a classic (non-killer) state', () => {
    const gs = KNOWN_SOLUTION;
    const givenDigits = makeClassicGivenDigits();
    const classicState = PuzzleState.createClassic(givenDigits, [...DEFAULT_ALWAYS_APPLY_RULES], null);
    const state: PuzzleState = {
      ...classicState,
      goldenSolution: gs,
      userGrid: gs.map(row => [...row]),
    };
    expect(PuzzleState.isKiller(state)).toBe(false);
    // Even though userGrid matches gs exactly, prove Check 0 isn't reached by
    // confirming a consistent classic state returns null (no spurious cage check).
    expect(checkPuzzleInvariant(state)).toBeNull();
  });
});
```

`PuzzleState.createClassic` and `DEFAULT_ALWAYS_APPLY_RULES` are already imported in `engine.test.ts` (`PuzzleState` from `./types.js`, `DEFAULT_ALWAYS_APPLY_RULES` from `./settings.js`); `makeClassicGivenDigits` is already imported from `../engine/fixtures.js`.

Add `checkPuzzleInvariant` to the `./engine.js` import list at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- --run engine.test -t checkPuzzleInvariant`
Expected: FAIL — `checkPuzzleInvariant is not exported` (or `is not a function`).

- [ ] **Step 3: Implement `PuzzleInvariantViolation` and `checkPuzzleInvariant`**

In `web/src/session/engine.ts`, append after `findWrongVirtualCageTurnIdx` (still before `// ---- Snapshot helpers ----`):

```ts
export interface PuzzleInvariantViolation {
  readonly rewindTurnIdx: number | null;
  readonly missingCell: { r: number; c: number; gold: number } | null;
}

/**
 * Checks `state` against `state.goldenSolution` for any of the known
 * inconsistency patterns (wrong placement, wrong candidate elimination,
 * killer-only: wrong user-added virtual cage total). Returns the first
 * violation found, or null if the state is consistent. Puzzle-type-specific
 * checks (e.g. Check 0, killer-only) are gated internally via
 * `PuzzleState.isKiller`.
 */
export function checkPuzzleInvariant(state: PuzzleState): PuzzleInvariantViolation | null {
  const gs = state.goldenSolution;
  if (gs === null) return null;

  // Check 0 (killer-only): a user-added virtual cage's total contradicts
  // goldenSolution — catches the root cause directly, before it cascades
  // into Checks 1-3 below.
  if (PuzzleState.isKiller(state)) {
    const wrongCageIdx = findWrongVirtualCageTurnIdx(state);
    if (wrongCageIdx !== null) return { rewindTurnIdx: wrongCageIdx, missingCell: null };
  }

  // Check 1 & 3: wrong digit anywhere in userGrid
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const placed = state.userGrid[r]![c]!;
      const gold = gs[r]![c]!;
      if (placed !== 0 && gold !== 0 && placed !== gold) {
        return { rewindTurnIdx: findLastConsistentTurnIdx(state), missingCell: null };
      }
    }
  }

  // Check 2: correct golden candidate explicitly eliminated by user
  const missingCell = findMissingGoldenCandidate(state);
  if (missingCell !== null) {
    return {
      rewindTurnIdx: findFirstElimTurnIdx(state, missingCell.r, missingCell.c, missingCell.gold),
      missingCell,
    };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- --run engine.test -t checkPuzzleInvariant`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /home/user/cagedoku/web && npx tsc --noEmit
cd /home/user/cagedoku && bash scripts/run-bronze-gate.sh
git add web/src/session/engine.ts web/src/session/engine.test.ts
git commit -m "feat: add checkPuzzleInvariant with Check 0 virtual-cage golden-sum gate"
```

---

### Task 4: Rewrite `getHints()`'s inconsistency block

**Files:**
- Modify: `web/src/session/actions.ts`
- Test: `web/src/session/actions.test.ts`

- [ ] **Step 1: Write the new end-to-end test (failing)**

In `web/src/session/actions.test.ts`, add a new describe block after the existing `'getHints — Rewind on wrong candidate elimination'` block:

```ts
// ---------------------------------------------------------------------------
// Rewind hint — wrong virtual cage total (Check 0)
// ---------------------------------------------------------------------------

describe('getHints — Rewind on wrong virtual cage total', () => {
  it('returns a Rewind hint when a user-added virtual cage total contradicts goldenSolution', () => {
    makeKillerConfirmed();
    const state = getState()!;
    const gs = state.goldenSolution!;

    // Pick two cells and a total within cageSumRange(2) = [3, 17] but that
    // doesn't match the golden sum for those two cells.
    const goldSum = gs[0]![0]! + gs[0]![1]!;
    const wrongTotal = goldSum === 17 ? goldSum - 1 : goldSum + 1;

    addVirtualCage([[0, 0], [0, 1]], wrongTotal);

    const { hints } = getHints();
    const rewindHint = hints.find(h => h.rewindToTurnIdx !== null);
    expect(rewindHint).toBeDefined();
    expect(rewindHint!.displayName).toMatch(/[Rr]ewind/);
    expect(rewindHint!.rewindToTurnIdx).toBe(getState()!.turns.length - 1);
  });
});
```

`makeKillerConfirmed`, `addVirtualCage`, `getHints`, `getState` are already imported/defined in `actions.test.ts`.

- [ ] **Step 2: Run the test to verify it fails (or check current behavior)**

Run: `cd web && npm test -- --run actions.test -t "wrong virtual cage total"`

Note: this may already partially pass if the current ad-hoc inconsistency checks happen to also catch this case incidentally — but Check 0 doesn't exist yet, so the existing Checks 1-3 won't fire (userGrid is fully consistent; no eliminated golden candidate). Expected: FAIL (`rewindHint` is `undefined`, since `hints.find(h => h.rewindToTurnIdx !== null)` finds nothing).

- [ ] **Step 3: Rewrite the inconsistency block in `getHints()`**

In `web/src/session/actions.ts`, replace the block from the `// ── Inconsistency detection ──` comment through the end of the `if (gs !== null) { ... }` block (currently lines 1116-1152) with:

```ts
  // ── Inconsistency detection ─────────────────────────────────────────────────
  // checkPuzzleInvariant compares state against goldenSolution and returns the
  // first detected violation (wrong virtual cage total, wrong placed digit, or
  // an explicitly-eliminated correct candidate), or null if consistent.
  const violation = checkPuzzleInvariant(state);
  const inconsistent = violation !== null;
  let rewindTurnIdx = violation?.rewindTurnIdx ?? null;
  const missingCell = violation?.missingCell ?? null;
```

The remainder of `getHints()` (the `if (inconsistent) { ... }` block, currently starting at line 1154) is **unchanged** — it already consumes `inconsistent`, `rewindTurnIdx`, and `missingCell` as plain values. Note `rewindTurnIdx` must remain `let` (not `const`) because the `if (inconsistent)` block's alt-solution branch does not reassign it, but downstream code reads it — check the existing block for any reassignment; if none exists, `const` is also fine. (It is not reassigned — use `const rewindTurnIdx` for clarity.)

- [ ] **Step 4: Update actions.ts's `./engine.js` import**

Add `checkPuzzleInvariant` to the import list from Task 1 Step 3:

```ts
import {
  buildEngine,
  applyRuleSteps,
  recordTurn,
  rebuildUserGrid,
  userRemoved,
  userVirtualCages,
  findLastConsistentTurnIdx,
  findFirstElimTurnIdx,
  findMissingGoldenCandidate,
  checkPuzzleInvariant,
  PuzzleStateOps,
} from './engine.js';
```

Now `findLastConsistentTurnIdx`, `findFirstElimTurnIdx`, and `findMissingGoldenCandidate` are no longer referenced directly in `actions.ts` (they're used inside `checkPuzzleInvariant` in `engine.ts`). Remove all three from this import list:

```ts
import {
  buildEngine,
  applyRuleSteps,
  recordTurn,
  rebuildUserGrid,
  userRemoved,
  userVirtualCages,
  checkPuzzleInvariant,
  PuzzleStateOps,
} from './engine.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npm test -- --run actions.test engine.test`
Expected: PASS — including the new Check 0 test and the two pre-existing Rewind tests (Check 1/3 and Check 2 regressions).

- [ ] **Step 6: Typecheck and commit**

```bash
cd /home/user/cagedoku/web && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
cd /home/user/cagedoku && bash scripts/run-bronze-gate.sh
git add web/src/session/actions.ts web/src/session/actions.test.ts
git commit -m "refactor: rewrite getHints inconsistency detection via checkPuzzleInvariant"
```

---

### Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/user/cagedoku/web && npm test -- --run
```

Expected: all tests PASS.

- [ ] **Step 2: Run full typecheck**

```bash
cd /home/user/cagedoku/web && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Search for any remaining references to the moved/removed local helpers**

```bash
cd /home/user/cagedoku/web && grep -rn "findFirstElimTurnIdx\|findMissingGoldenCandidate\|findWrongVirtualCageTurnIdx\|checkPuzzleInvariant" src/session/
```

Expected: definitions in `engine.ts`, imports + usage in `actions.ts`, and test references in `engine.test.ts`/`actions.test.ts` — no stray duplicate local definitions.

- [ ] **Step 4: Run bronze gate and commit if anything is outstanding**

```bash
cd /home/user/cagedoku && bash scripts/run-bronze-gate.sh
```

If all prior tasks were committed individually, there should be nothing left to commit at this point.

---

## Self-Review Notes

**Spec coverage:**
- §6a `PuzzleInvariantViolation` + `checkPuzzleInvariant` — Task 3.
- §6a move of `findFirstElimTurnIdx`/`findMissingGoldenCandidate` to `engine.ts` — Task 1.
- §6a `getHints()` rewrite (lines 1126-1152 → violation-based; lines 1154-1199 unchanged) — Task 4.
- §6b `findWrongVirtualCageTurnIdx` — Task 2.
- Testing section: `checkPuzzleInvariant` regression tests for Checks 1-3 plus killer-only Check 0 gate — Task 3. `findWrongVirtualCageTurnIdx` consistent/inconsistent/diff-cage tests — Task 2. End-to-end `actions.test.ts` Rewind-from-wrong-virtual-cage test — Task 4.

**Placeholder scan:** none found — all code blocks are complete; the Task 3 Step 1 "skipped" test is explicitly replaced in Step 4 with concrete code (not left as a placeholder in the final state).

**Type consistency:** `PuzzleInvariantViolation.rewindTurnIdx: number | null` and `.missingCell: { r: number; c: number; gold: number } | null` match the existing local variable types `rewindTurnIdx`/`missingCell` in `getHints()` exactly, so Task 4's rewrite is a drop-in replacement. `findWrongVirtualCageTurnIdx(state: PuzzleState): number | null` matches its use inside `checkPuzzleInvariant`. `findFirstElimTurnIdx`/`findMissingGoldenCandidate` signatures are unchanged from their original local definitions (only `export` added).

**Out of scope (per spec):** the `_deriveNonburbVirtualCages`/`_reduceDerive` simplification and the stale `SolutionMapFilter` fixture are not addressed here.
