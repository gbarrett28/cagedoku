# Sprint 2 — #165: Virtual Cage Difference — Valid Total Blocked

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a difference virtual cage to be added with any non-negative total (including 0). The existing invariant checker already detects when a cage total disagrees with the golden solution and surfaces a Rewind hint — no new mechanism is needed.

**Architecture:** Remove the `solutions.length === 0` early-throw in `addVirtualCage` for diff cages. The `findWrongVirtualCageTurnIdx` / `checkPuzzleInvariant` path in `engine.ts` handles the inconsistency case. No other files change.

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- Branch: `feature/bug-fixes-160-161-162-165-166-167`
- Bronze gate must pass before every commit
- Before merging to master: run corpus evaluator and verify no regression vs baseline
- `addVirtualCage` lives in `web/src/session/actions.ts:1024-1079`
- `findWrongVirtualCageTurnIdx` lives in `web/src/session/engine.ts:662-671`
- `virtualCageGoldenSum` in `engine.ts:157-164` handles negativeCells correctly: positive cells add, negative cells subtract

---

### Task 1: Remove the early throw and add regression tests

**Files:**
- Modify: `web/src/session/actions.ts:1024-1079` (`addVirtualCage`)
- Test: `web/src/session/actions.test.ts`

**Interfaces:**
- `addVirtualCage(cells, total, negativeCells?)` — public export in `actions.ts`
- `getHints()` — public export in `actions.ts`; returns `{ hints: HintItem[] }` where a Rewind hint has `rewindToTurnIdx: number`
- `loadSpecDirect(spec)` / `confirmPuzzle(board)` — used in tests to set up confirmed state with a known golden solution
- `findWrongVirtualCageTurnIdx(state)` from `engine.ts` — returns the turn index of the first cage whose total disagrees with the golden solution, or null

- [ ] **Step 1: Write the failing test**

In `web/src/session/actions.test.ts`, add:

```typescript
describe('addVirtualCage — diff cage total=0', () => {
  it('allows total=0 for a diff cage even when solDiffs returns no distinct-digit solutions', () => {
    // Set up a confirmed puzzle state. Use any 2-cell diff cage where the golden
    // solution has the same digit in both cells (so diff = 0 is consistent).
    // The test just asserts no throw; actual puzzle state setup follows
    // existing patterns in the test file (loadSpecDirect + confirmPuzzle).
    expect(() => addVirtualCage(
      [[0, 0], [1, 0]],  // two cells in the same column — need distinct digits
      5,                  // total=5 is valid; use a non-zero first to confirm the cage can be added
      [[1, 0]],          // r2c1 is the negative cell
    )).not.toThrow();
  });

  it('allows total=0 for a diff cage', () => {
    // After setup: state must be confirmed with a golden solution
    // where the two cells have equal values (so diff=0 is correct).
    // This verifies the formerly-thrown path is now accepted.
    expect(() => addVirtualCage([[4, 0], [4, 1]], 0, [[4, 1]])).not.toThrow();
  });
});
```

*Note:* The exact test setup (loadSpecDirect, confirmPuzzle) must follow the pattern used in other `addVirtualCage` tests already in the file. Adapt the cell coordinates to match the test puzzle's golden solution.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/session/actions.test.ts -t "diff cage total=0"
```

Expected: FAIL — throws `"Total 0 has no valid solutions for 1 positive and 1 negative cells"`.

- [ ] **Step 3: Remove the early throw**

In `web/src/session/actions.ts`, in `addVirtualCage` at lines 1038-1051, remove the `solutions.length === 0` check. The diff cage block becomes:

```typescript
  if (isDiff) {
    // Diff cage validation
    if (total < 0) throw new Error('Total must be non-negative for a difference cage');
    const negKeys = new Set(negativeCells!.map(([r, c]) => `${r},${c}`));
    for (const k of negKeys) {
      if (!unique.has(k)) throw new Error(`Negative cell ${k} is not in the selected cells`);
    }
    if (negKeys.size === cells.length) {
      throw new Error('At least one positive cell is required');
    }
  } else {
```

(The `const posCount`, `const negCount`, `const solutions`, and `if (solutions.length === 0)` lines are deleted entirely.)

- [ ] **Step 4: Write the rewind detection test**

Add to `web/src/session/actions.test.ts`:

```typescript
describe('getHints — wrong virtual cage total triggers rewind', () => {
  it('returns a Rewind hint when a diff cage total disagrees with golden solution', () => {
    // Add a diff cage whose total does NOT match the golden solution.
    // e.g. cells with golden values 3 and 5 — diff is 2 but we annotate 0.
    addVirtualCage([[ROW_A, COL_A], [ROW_B, COL_B]], 0, [[ROW_B, COL_B]]);
    const { hints } = getHints();
    expect(hints.length).toBe(1);
    expect(hints[0]!.ruleName).toBe('Rewind');
  });
});
```

*Note:* Replace `ROW_A`, `COL_A`, `ROW_B`, `COL_B` with cell coordinates from the test puzzle where the golden-solution diff is not 0.

- [ ] **Step 5: Run all tests**

```bash
cd web && npx vitest run src/session/actions.test.ts
```

Expected: all pass including new tests.

- [ ] **Step 6: Run bronze gate**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && bash scripts/run-bronze-gate.sh
```

Expected: all checks pass, token created.

- [ ] **Step 7: Commit**

```bash
git add web/src/session/actions.ts web/src/session/actions.test.ts
git commit -m "fix: allow total=0 for diff virtual cage; rewind handles inconsistency (#165)"
```
