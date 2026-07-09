# Sprint 1 — #167: False OCR Error Message

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the "cage totals appear to have OCR errors" message only when cage totals are actually zero (the fingerprint of an OCR misread); use a generic solver-failed message otherwise.

**Architecture:** One-condition change inside `handleConfirm` in `web/src/main.ts`. No new files, no new functions.

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- Branch: `feature/bug-fixes-160-161-162-165-166-167`
- Bronze gate must pass before every commit (`bash scripts/run-bronze-gate.sh` from repo root)
- Before merging to master: run corpus evaluator and verify no regression vs baseline
- Coordinate system: all cell references are `[row, col]` 0-based internally, 1-based in user messages

---

### Task 1: Fix error message and add regression test

**Files:**
- Modify: `web/src/main.ts` — `handleConfirm` around line 1538

**Interfaces:**
- The condition reads `state.specData.cageTotals` — a `number[][]` where non-zero values are cage totals anchored at the top-left cell of each cage; 0 means "no cage starts here".
- `PuzzleState.isKiller(state)` narrows to `KillerPuzzleState` which has `specData.cageTotals`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/session/actions.test.ts` (or a new `web/src/main.errorMessage.test.ts`). The function under test is a pure helper extracted in Step 3:

```typescript
// In web/src/main.errorMessage.test.ts
import { confirmErrorMessage } from '../main.js';

describe('confirmErrorMessage', () => {
  it('blames OCR when a cage total is zero', () => {
    const cageTotals = [[0,0,10,0,0,0,0,0,0], ...Array(8).fill(Array(9).fill(0))];
    expect(confirmErrorMessage(cageTotals, 'Cell r1c1 is unsolved (0)'))
      .toMatch(/OCR errors/);
  });

  it('uses generic message when all cage totals are non-zero', () => {
    const cageTotals = [[15,0,10,0,0,0,0,0,0], ...Array(8).fill(Array(9).fill(0))];
    expect(confirmErrorMessage(cageTotals, 'Cell r1c1 is unsolved (0)'))
      .not.toMatch(/OCR errors/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/main.errorMessage.test.ts
```

Expected: FAIL — `confirmErrorMessage` not exported from `main.ts`.

- [ ] **Step 3: Add helper and fix handleConfirm**

In `web/src/main.ts`, add this export just before `handleConfirm`:

```typescript
/** Exported for testing only. */
export function confirmErrorMessage(cageTotals: number[][], solutionError: string): string {
  const hasZeroCageTotal = cageTotals.some(row => row.some(t => t === 0));
  return hasZeroCageTotal
    ? `Invalid puzzle — cage totals appear to have OCR errors (${solutionError}). Correct the totals and try again.`
    : `Puzzle could not be solved — check that cage totals and borders are correct (${solutionError}).`;
}
```

Then in `handleConfirm`, replace lines 1538-1544:

```typescript
    if (solutionError !== null) {
      const totals = PuzzleState.isKiller(state) ? state.specData.cageTotals : [];
      setStatus(confirmErrorMessage(totals, solutionError), true);
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npx vitest run src/main.errorMessage.test.ts
```

Expected: PASS — 2 tests pass.

- [ ] **Step 5: Run bronze gate**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && bash scripts/run-bronze-gate.sh
```

Expected: all checks pass, token created.

- [ ] **Step 6: Commit**

```bash
git add web/src/main.ts web/src/main.errorMessage.test.ts
git commit -m "fix: only blame OCR in confirm error when cage total is zero (#167)"
```
