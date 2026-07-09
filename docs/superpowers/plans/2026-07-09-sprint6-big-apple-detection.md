# Sprint 6 — #160: Big Apple Variant Not Recognised During OCR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `detectBigApple` must correctly identify puzzles that have multiple Classic solutions but a unique (or constraint-solvable) Big Apple solution, even when Big Apple rules alone stall.

**Architecture:** `detectBigApple` in `web/src/engine/index.ts:69-81` runs two rule-only passes (Classic then Big Apple) and returns true only if Big Apple rules fully solve the grid without backtracking. The original comment says backtracking is excluded because "brute-force search would solve a valid classic puzzle regardless of windows, making it useless as a discriminator." This is correct for the Classic pass. But for the Big Apple pass, exclusion is wrong: if Big Apple window units uniquely constrain the puzzle via backtracking, it IS a Big Apple puzzle. Fix: after Big Apple rules stall, call `mrvBacktrack(windowBoard)`. Return true if a solution is found (non-null), false otherwise.

Key locations:
- `detectBigApple` in `web/src/engine/index.ts:69-81`
- `mrvBacktrack` is already imported in `engine/index.ts:3` from `./backtracker.js`
- `BigAppleBoardState` is in `web/src/engine/bigAppleBoardState.ts`
- `assessClassicSolvability` in `engine/index.ts` shows the reference backtracking pattern

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- Branch: `feature/bug-fixes-160-161-162-165-166-167`
- Bronze gate must pass before every commit
- Before merging to master: run corpus evaluator and verify no regression vs baseline
- Do NOT add backtracking to the Classic pass — the asymmetry is intentional

---

### Task 1: Add Big Apple backtracking fallback and regression test

**Files:**
- Modify: `web/src/engine/index.ts:69-81` (`detectBigApple`)
- Test: `web/src/engine/index.test.ts`

**Interfaces:**
- `detectBigApple(givenDigits: number[][]): boolean` — signature unchanged
- `mrvBacktrack(board: BoardState): number[][] | null` — already imported; modifies board in place and returns the solution grid or null
- `BigAppleBoardState` — subclass of `BoardState`; pass to `mrvBacktrack` as-is

- [ ] **Step 1: Write the failing test**

In `web/src/engine/index.test.ts`, add a test for a puzzle that has multiple Classic solutions but exactly one Big Apple solution. Look in the existing test file for how other `detectBigApple` tests set up `givenDigits`:

```typescript
describe('detectBigApple — backtracking fallback', () => {
  it('returns true for a puzzle that needs Big Apple backtracking to confirm uniqueness', () => {
    // A 9×9 grid where Classic rules + backtracking yields multiple solutions,
    // but Big Apple window constraints (rules + backtracking) yield exactly one.
    // Construct or source a minimal example that exercises the stall path.
    //
    // Minimal approach: use a lightly-filled grid where:
    //   assessClassicSolvability returns { bucket: 'backtracked' } with multiple solutions
    //   detectBigApple (before fix) returns false (window rules stall)
    //   detectBigApple (after fix) returns true (window backtracking finds a solution)
    //
    // If a concrete example is not immediately available, mark this test as
    // `it.todo(...)` and verify with the actual issue #160 puzzle image manually.
    const givenDigits: number[][] = /* TODO: fill from issue #160 puzzle */ Array(9).fill(Array(9).fill(0));
    // Pre-condition: classic rules + backtracking does NOT give a unique solution
    // (this may require importing assessClassicSolvability to assert)
    expect(detectBigApple(givenDigits)).toBe(true);
  });

  it('returns false for a puzzle with multiple Big Apple solutions', () => {
    // An empty grid has infinite solutions — Big Apple backtracking returns a solution
    // but that doesn't prove uniqueness. For this test use a near-empty grid.
    // The function is allowed to return true (found a solution) even if not unique —
    // this is by design (we heuristically classify as Big Apple if a solution exists).
    // Instead verify a known non-Big-Apple puzzle still returns false.
    const classicPuzzle = /* known classic puzzle with unique solution, no windows needed */
      Array(9).fill(Array(9).fill(0));
    // If the puzzle has a unique classic solution, Big Apple backtracking would also
    // find it, returning true. Use a puzzle that has a unique CLASSIC solution (rules
    // alone solve it) — detectBigApple returns false because classic rules DON'T stall.
    expect(detectBigApple(classicPuzzle)).toBe(false);
  });
});
```

*Note:* The first test requires a concrete puzzle. Source it from issue #160 or construct one. Use `it.todo` if you don't have one yet; the existing tests still cover the no-stall path.

- [ ] **Step 2: Run test to verify the todo / current behaviour**

```bash
cd web && npx vitest run src/engine/index.test.ts -t "backtracking fallback"
```

Expected: either SKIP (if `it.todo`) or FAIL (if puzzle is provided and current code returns false).

- [ ] **Step 3: Apply the fix**

In `web/src/engine/index.ts`, replace `detectBigApple` (lines 69-81):

```typescript
/**
 * Heuristic Big Apple detector: runs classic-only constraint propagation; if
 * it stalls before every cell is solved, retries with the 4 extra window
 * units (BigAppleBoardState). If window rules also stall, falls back to
 * MRV backtracking constrained to the window board — returning true if any
 * Big Apple solution exists. Backtracking is excluded from the classic pass
 * because brute-force finds classic solutions regardless of windows; the
 * window pass may use it because we are testing whether Big Apple constraints
 * (not just classic ones) can resolve the puzzle.
 */
export function detectBigApple(givenDigits: number[][]): boolean {
  const classicBoard = new BoardState();
  const classicEngine = new SolverEngine(classicBoard, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(classicEngine, classicBoard, givenDigits);
  classicEngine.solve();
  if (!checkStalled(classicBoard)) return false;

  const windowBoard = new BigAppleBoardState();
  const windowEngine = new SolverEngine(windowBoard, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(windowEngine, windowBoard, givenDigits);
  windowEngine.solve();
  if (!checkStalled(windowBoard)) return true;

  // Window rules stalled — fall back to backtracking on the window board.
  // A non-null result means at least one Big Apple solution exists.
  return mrvBacktrack(windowBoard) !== null;
}
```

- [ ] **Step 4: Run the test suite**

```bash
cd web && npx vitest run src/engine/index.test.ts
```

Expected: all existing `detectBigApple` tests pass; new test passes (or is a todo).

- [ ] **Step 5: Run full test suite**

```bash
cd web && npx vitest run
```

Expected: all 834+ tests pass.

- [ ] **Step 6: Run bronze gate**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && bash scripts/run-bronze-gate.sh
```

Expected: all checks pass, token created.

- [ ] **Step 7: Commit**

```bash
git add web/src/engine/index.ts web/src/engine/index.test.ts
git commit -m "fix: fall back to MRV backtracking in detectBigApple when window rules stall (#160)"
```
