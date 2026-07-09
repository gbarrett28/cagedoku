# Sprint 4 — #166: Hint Highlights Non-Existent Candidates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hint digit markers must not appear over candidates that don't exist in the cell.

**Architecture:** This bug is downstream of Sprint 3. After Sprint 3's fix, solver-derived eliminations no longer appear in `userRemovedCandidates`, so `drawHintDigitMarkers` in `main.ts:476-543` should no longer draw red circles over phantom candidates. This sprint verifies the fix resolved the issue; if any residual guard is needed in `drawHintDigitMarkers` it is added here.

The red-circle path in `drawHintDigitMarkers`:
```typescript
if (!cellInfo.candidates.includes(d) && !cellInfo.userRemoved.includes(d)) continue;
```
With Sprint 3 applied: `cellInfo.userRemoved` will only contain true user-initiated removals, so a digit that was auto-eliminated by the solver will be absent from both `candidates` and `userRemoved` — the `continue` will fire and no marker is drawn.

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- Branch: `feature/bug-fixes-160-161-162-165-166-167`
- Bronze gate must pass before every commit
- Before merging to master: run corpus evaluator and verify no regression vs baseline
- Sprint 3 must be committed before starting this sprint
- `drawHintDigitMarkers` is in `web/src/main.ts:476-543`

---

### Task 1: Verify Sprint 3 resolves the hint marker bug

**Files:**
- Read: `web/src/engine/rules/unitPartitionFilter.test.ts` — existing tests for the Unit Partition Filter rule
- Possibly modify: `web/src/main.ts:476-543` (`drawHintDigitMarkers`) if a residual guard is needed

- [ ] **Step 1: Run Unit Partition Filter tests**

```bash
cd web && npx vitest run src/engine/rules/unitPartitionFilter.test.ts
```

Expected: all 3 existing tests pass.

- [ ] **Step 2: Write a regression test for the hint marker condition**

In `web/src/session/actions.test.ts`, add:

```typescript
describe('candidatesFromBoard — userRemoved does not contain solver eliminations', () => {
  it('a digit auto-eliminated by rules after cage strikeout is absent from userRemoved', () => {
    // Setup: confirmed killer state. Strike out a cage solution.
    eliminateCageSolution('A', [1, 9]);

    const { board } = buildEngineForTest(requireConfirmed());  // helper or use buildEngine exported
    const data = candidatesFromBoard(board, requireConfirmed());

    // Find the cell that held digit 1 only in solution {1,9}
    // e.g. r5c1 in the test puzzle. Its userRemoved must NOT contain 1.
    const cell = data.cells[4]![0]!;
    expect(cell.userRemoved).not.toContain(1);
    // And 1 must not be in candidates either (solver excluded it)
    expect(cell.candidates).not.toContain(1);
  });
});
```

*Note:* Adjust row/col indices to match the test puzzle. `candidatesFromBoard` must be imported from `actions.ts`.

- [ ] **Step 3: Run test to verify it passes (Sprint 3 already fixed this)**

```bash
cd web && npx vitest run src/session/actions.test.ts -t "userRemoved does not contain"
```

Expected: PASS — Sprint 3's fix makes this pass without any further change.

- [ ] **Step 4: Inspect drawHintDigitMarkers for residual guard**

Read `web/src/main.ts:488-505` (the red-circle loop):

```typescript
for (const { cell: [r, c], digit: d } of hint.eliminations) {
  if ((userGrid[r]?.[c] ?? 0) !== 0) continue;
  const cellInfo = candidatesData.cells[r]?.[c];
  if (!cellInfo) continue;
  if (!cellInfo.candidates.includes(d) && !cellInfo.userRemoved.includes(d)) continue;
  // ... draw circle
}
```

With Sprint 3 applied, `cellInfo.userRemoved` no longer contains solver-derived entries. If a hint targets a digit that is absent from both `candidates` and `userRemoved`, the `continue` fires correctly. **No additional guard is needed** unless the loop incorrectly draws circles for digits in `userRemoved` that were never visible. If on manual inspection the condition still fails, add:

```typescript
  // Only draw if the digit is still a visible candidate (not fully gone)
  if (cellInfo.candidates.length === 0 && cellInfo.userRemoved.length === 0) continue;
```

- [ ] **Step 5: Run bronze gate**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && bash scripts/run-bronze-gate.sh
```

Expected: all checks pass, token created.

- [ ] **Step 6: Commit**

```bash
git add web/src/session/actions.test.ts
# Include web/src/main.ts only if a residual guard was needed
git commit -m "test: verify hint markers don't appear over phantom candidates (#166)"
```
