# Bug 104: InvalidSolution — Backtracker Returns Invalid Grid + GitHub Submission Path

## Overview

Two independent problems filed under issue 104:

1. **Primary**: The MRV backtracker returned an invalid sudoku solution (row 4 has a duplicate digit 6). The assertion `validateSudokuSolution` caught it after the fact, but the puzzle entered a broken `goldenSolution` state before the check ran.
2. **Secondary**: The assertion modal reports the bug by opening a GitHub Issues URL, which requires the user to have a GitHub login. All other bug reports go through the in-app feedback endpoint (no login).

---

## Part 1 — Backtracker produces invalid solution

### Symptom

`mrvBacktrack` returned `[[3,5,7,2,6,1,4,9,8],[4,8,1,9,7,5,3,2,6],[6,2,9,3,4,8,5,7,1],[9,6,3,1,2,6,7,5,4],...]` for a classic puzzle encoded as 9 row-cages each summing to 45 (no given digits). Row 3 (0-indexed) is `[9,6,3,1,2,6,7,5,4]` — duplicate digit 6, sum 43.

### Context

The `search()` function in `backtracker.ts` already validates rows, columns, and boxes at the base case (when all cells are singletons), and should return `null` for an invalid state. That it returned a concrete invalid array means either:
- The base-case validation has an unexercised gap, OR
- The solution came from a non-base-case path (the rule engine produced all-singleton candidates before the backtracker ran), OR
- There is a mutation-sharing bug in the deep copy used for each trial branch

For a classic puzzle with no given digits, the rule engine cannot reduce any candidate, so `checkStalled` returns true and the backtracker is always called. The root cause is therefore internal to `mrvBacktrack` / `search`.

### Regression test (write first)

In `backtracker.test.ts`, add a test case using the exact spec from the bug report. A row-cage spec is available via a new helper `makeRowCageSpec()` in `fixtures.ts`:

```
makeRowCageSpec(): each of 9 rows is a single cage, cageTotal = 45, no given digits
```

The test asserts that `mrvBacktrack(bs)` returns either `null` or a value that passes `validateSudokuSolution`. This test must be written before the fix so it fails first.

### Fix

Two layers:

**Layer 1 — Defensive guard in `mrvBacktrack`**

After `search()` returns a non-null result, call `validateSudokuSolution(solution)`. If the check fails:
- Log `console.error('mrvBacktrack: invalid solution —', reason)` so the anomaly is visible in production logs
- Return `null`

This converts `InvalidSolution` (corrupt golden state) into `UnsolvedByRules` (clean stall), which is an acceptable degradation.

**Layer 2 — Fix the root cause**

With the regression test in place, debug the exact path that bypassed the base-case validation. Candidates in order of likelihood:

1. `search()`'s base-case validation iterates `cands[i][j].values().next().value` — if a Set contains `0` or `NaN` from a previous erroneous propagation, the duplicate check may not fire.
2. The `assign()` function replaces `cands[r][c]` with `new Set([d])` but only pushes `[r,c,d]` to propagate to peers. If any existing peer is already a singleton with a conflicting digit, propagation removes it correctly — but only if the peer's value was set via propagation and not pre-seeded from the rule engine. If the rule engine produced a wrong singleton for a peer, that peer is never "reduced to singleton" in this assign call and is never queued for propagation. Verify whether the board state before backtracking can contain wrong singletons.
3. Evaluate whether an initial full-propagation pass is needed at the start of `mrvBacktrack`, re-queuing all existing singletons to enforce their constraints before `search()` begins.

The regression test output (or a debugger trace) will identify which path applies. Fix the identified path, then confirm the regression test passes.

---

## Part 2 — Assertion modal: use in-app feedback

### Current behaviour

`showAssertionModal` opens a GitHub issue URL via `window.open(buildGitHubIssueUrl(violation.ctx), '_blank')`. The user must have a GitHub account.

### Fix

Replace with the existing `pendingBug` → feedback modal pattern:

1. In `showAssertionModal` (main.ts): instead of `window.open(...)`, set `pendingBug` to a formatted string containing the violation name, description, and solution JSON, then programmatically open the feedback modal (same as `feedback-btn` does today).
2. The feedback payload already includes `puzzleSpec` from `currentState`, `actionLog` from `formatActionLog()`, and `exception` from `pendingBug`. No new payload fields are needed.
3. Delete `buildGitHubIssueUrl` from `assertions.ts` (it is only used in `showAssertionModal`) and remove its test case from `assertions.test.ts`.

---

## Testing

- Regression test for the backtracker (new test in `backtracker.test.ts`) — fails first, passes after fix
- Manual verification: trigger an `InvalidSolution` assertion (requires a puzzle that triggers the bug, or a unit test that calls `showAssertionModal` directly) and verify the feedback modal opens pre-filled instead of a browser tab
- Bronze gate must pass before commit
