# Sprint 3 — #162: Cage Strikeout Display Doesn't Update

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the user strikes out a cage solution, digits belonging only to that solution must disappear from the cage cell display (not remain as strikethrough candidates).

**Architecture:** Root cause: `applyRuleSteps` in `engine.ts` folds ALL rule-step mutations — including `EliminateCandidateMutation` — into `state.userRemovedCandidates`. The `candidatesFromBoard` function reads `userRemovedCandidates` and adds those digits back to `solverCands` for strikethrough display, making solver-derived eliminations visible as if the user had manually removed them. Fix: filter out `eliminateCandidate` mutations before folding in `applyRuleSteps`. Solver-derived eliminations are re-computed by `buildEngine` each time and must not be persisted in `userRemovedCandidates`. `recordTurn` intentionally keeps the same behaviour for user-triggered rule steps — those auto-eliminations correctly show as strikethrough.

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- Branch: `feature/bug-fixes-160-161-162-165-166-167`
- Bronze gate must pass before every commit
- Before merging to master: run corpus evaluator and verify no regression vs baseline
- `applyRuleSteps` is in `web/src/session/engine.ts:493-497`
- `candidatesFromBoard` is in `web/src/session/actions.ts:685-800`
- `userRemovedCandidates` in `PuzzleState` is the only persistent store for candidate removal state

---

### Task 1: Fix applyRuleSteps and add regression test

**Files:**
- Modify: `web/src/session/engine.ts:493-497` (`applyRuleSteps`)
- Test: `web/src/session/ruleMutation.test.ts` or `web/src/session/actions.test.ts`

**Interfaces:**
- `applyRuleSteps(state: PuzzleState): { state: PuzzleState; ruleSteps: readonly RuleStep[]; board: BoardState }` — return signature unchanged
- `eliminateCageSolution(label: string, solution: number[]): PuzzleState` — triggers `applyRuleSteps`, public export in `actions.ts:962-973`
- `candidatesFromBoard(board: BoardState, state: PuzzleState): CandidatesResponse` — public export; `CandidatesResponse.cells[r][c].userRemoved` is the field to assert on

- [ ] **Step 1: Write the failing test**

In `web/src/session/actions.test.ts`, add:

```typescript
describe('eliminateCageSolution — userRemovedCandidates', () => {
  it('does not add solver-derived eliminations to userRemovedCandidates when a cage solution is struck out', () => {
    // After setup: confirmed killer state with a cage that has at least 2 solutions.
    // Strike out one solution that contains a digit unique to that solution in some cell.
    // The digit should disappear from the cell candidates, NOT appear as userRemoved.
    const before = requireConfirmed();
    const beforeRemoved = before.userRemovedCandidates.length;

    eliminateCageSolution('A', [1, 9]); // strike out solution {1,9} from cage A

    const after = requireConfirmed();
    // userRemovedCandidates must not have grown — solver-derived eliminations
    // triggered by the cage solution strikeout must not be persisted here.
    expect(after.userRemovedCandidates.length).toBe(beforeRemoved);
  });
});
```

*Note:* This test requires a confirmed killer puzzle state to be set up in `beforeEach` following the same pattern as other confirmed-state tests in `actions.test.ts`. Use a cage labelled 'A' with solutions that include {1,9}.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/session/actions.test.ts -t "userRemovedCandidates"
```

Expected: FAIL — `after.userRemovedCandidates.length > beforeRemoved` because solver eliminations are currently persisted.

- [ ] **Step 3: Apply the fix**

In `web/src/session/engine.ts`, replace the body of `applyRuleSteps` (lines 493-497):

```typescript
export function applyRuleSteps(state: PuzzleState): { state: PuzzleState; ruleSteps: readonly RuleStep[]; board: BoardState } {
  const { ruleSteps, board } = buildEngine(state, { skipValidation: true });
  // Skip EliminateCandidateMutation: solver-derived eliminations are re-computed by
  // buildEngine on each call and must not be persisted in userRemovedCandidates.
  // Only PlaceDigitMutation (auto-placed digits) and cage mutations need persisting.
  const folded = ruleSteps
    .flatMap(s => s.mutations)
    .filter(m => m.type !== 'eliminateCandidate')
    .reduce((s, m) => m.apply(s), state);
  return { state: folded, ruleSteps, board };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npx vitest run src/session/actions.test.ts -t "userRemovedCandidates"
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite**

```bash
cd web && npx vitest run
```

Expected: all existing tests pass. If any test asserts that `userRemovedCandidates` grows after a rule step (not a user `cycleCandidate`), that test was asserting the buggy behaviour and must be updated with a comment explaining the fix.

- [ ] **Step 6: Run bronze gate**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && bash scripts/run-bronze-gate.sh
```

Expected: all checks pass, token created.

- [ ] **Step 7: Commit**

```bash
git add web/src/session/engine.ts web/src/session/actions.test.ts
git commit -m "fix: skip EliminateCandidateMutation in applyRuleSteps to fix cage strikeout display (#162)"
```
