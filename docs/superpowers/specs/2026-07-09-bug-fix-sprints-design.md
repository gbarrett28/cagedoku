# Bug Fix Sprints — Design Spec

**Date:** 2026-07-09
**Issues:** #160, #161, #162, #165, #166, #167

---

## Overview

Six bugs diagnosed from the open issues list. All root causes are known. The sprints are ordered: trivial independent fixes first, root-cause before downstream, complex engine changes last.

---

## Sprint 1 — #167: False OCR error message

**File:** `web/src/main.ts:1538-1544` (`handleConfirm`)

**Bug:** The message `"cage totals appear to have OCR errors"` is hardcoded and fires for any solve failure, including solver stalls on otherwise-valid puzzles. Users see a misleading OCR blame when OCR is fine.

**Fix:** Before emitting the error message, check whether the failure is actually OCR-related (i.e. whether any cage total is 0, which is the fingerprint of a misread). Only use the OCR-specific wording in that case; use a generic "puzzle could not be solved" message otherwise.

**Test:** Unit test that a stalled-but-valid puzzle spec does not produce the OCR error string; a spec with a zero cage total does.

---

## Sprint 2 — #165: Virtual cage difference — valid total blocked

**Files:** `web/src/session/actions.ts` (`addVirtualCage`)

**Bug:** A virtual difference cage (`SUM(S1) − SUM(S2)`) is rejected outright when its annotated total is 0 (or any value that doesn't match the engine's constraint check), even when that total is geometrically valid — e.g. two non-unit cells that can hold the same digit. Valid constraints cannot be added.

**Fix:**
1. Remove the pre-entry validation that blocks the input.
2. Before adding the cage to state, evaluate `SUM(S1) − SUM(S2)` against the golden solution digits.
3. If the annotated total does not match the golden-solution value, ensure a rewind state is set (if one is not already present) so the user can recover if the constraint yields no solutions.
4. Proceed to add the cage regardless — the solver arbitrates against the golden solution.

**Test:** Unit test that a difference cage with total=0 between two non-unit cells can be added successfully. Unit test that the rewind state is set when the annotated total mismatches the golden solution value.

---

## Sprint 3 — #162: Cage strikeout display doesn't update

**Files:** `web/src/session/ruleMutation.ts:64-68` (`EliminateCandidateMutation.apply`)

**Bug:** When the user strikes out cage solution candidates, `EliminateCandidateMutation.apply` appends solver-generated eliminations into `state.userRemovedCandidates`. A downstream step in `candidatesFromBoard` then adds these back as visible strikethrough candidates. Struck-out cage solutions continue to appear in the cage display.

**Fix:** `EliminateCandidateMutation.apply` should only write eliminations that came from the user's explicit strikeout action into `userRemovedCandidates`, not solver-generated eliminations. Audit the distinction between user-initiated and solver-initiated removals in this mutation and write only the former.

**Test:** Unit test that striking out a cage solution removes it from `candidatesFromBoard` output. Unit test that solver eliminations do not appear in `userRemovedCandidates` after `EliminateCandidateMutation.apply`.

---

## Sprint 4 — #166: Hint highlights non-existent candidates

**Files:** `web/src/main.ts:476-543` (`drawHintDigitMarkers`)

**Bug:** Unit Partition Filter hints highlight candidate cells that have already been eliminated. This is downstream of Sprint 3: because #162 incorrectly populates `userRemovedCandidates` with solver eliminations, `drawHintDigitMarkers` finds those digits in `cellInfo.userRemoved` and draws red circles over non-existent candidates.

**Fix:** After Sprint 3, re-run existing hint tests to confirm this resolves automatically. If residual highlighting logic remains (hint overlay using stale removed-candidates data independently of #162), add an explicit guard: only draw a hint marker for a digit if that digit is still present as a visible candidate in the cell.

**Test:** Re-run unit partition filter tests post-Sprint-3. If a residual fix is needed, add a unit test: a hint for an already-eliminated candidate must not produce a marker.

---

## Sprint 5 — #161: Auto-solve fires with no animation

**Files:** `web/src/main.ts:1700-1707` (`handleCandidateCycle`), `web/src/session/actions.ts` (`confirmPuzzle`)

**Bug:** Two paths suppress animation:
1. `handleCandidateCycle` calls `cycleCandidate` then `refreshDisplay()` with no `ruleSteps` exposed, so `AnimationPlayer` never fires.
2. `confirmPuzzle` folds initial rule-step deductions into state silently.

When the user places the last candidate (eliminating wrong options), the puzzle completes immediately with no visual feedback, and the start animation is also skipped.

**Fix:** Thread `ruleSteps` from `cycleCandidate` through `handleCandidateCycle` so that `AnimationPlayer` receives them. Separately ensure `confirmPuzzle` exposes its initial deduction steps for animation. The completion animation should fire as normal once the board is fully solved via candidate cycling.

**Test:** Unit test that `handleCandidateCycle` returns non-empty `ruleSteps` when placing the last digit completes the board. Integration test (or Playwright) that the completion animation fires when the board is solved by candidate elimination.

---

## Sprint 6 — #160: Big Apple variant not recognised during OCR

**Files:** `web/src/engine/index.ts:69-81` (`detectBigApple`)

**Bug:** `detectBigApple` uses rule-based solving only. If the rule engine stalls, the function returns `false` even when a Big Apple–unique solution exists via backtracking. The app cannot distinguish "rules stalled" from "no unique Big Apple solution", so it falls back to Classic and fails to recognise the puzzle variant.

**Fix:** After the rule engine stalls on the second pass, run a constrained backtracker limited to the Big Apple rule set. If backtracking finds exactly one solution, report the puzzle as Big Apple. If it finds zero or more than one, report as not Big Apple. The backtracker used elsewhere in the engine can be reused here with appropriate constraints.

**Test:** Unit test with a puzzle that has multiple Classic solutions but exactly one Big Apple solution: `detectBigApple` must return `true`. Unit test with a puzzle that has multiple Big Apple solutions: must return `false`.

---

## Dependency Graph

```
Sprint 1 (#167)  — independent
Sprint 2 (#165)  — independent
Sprint 3 (#162)  — independent; root cause of Sprint 4
Sprint 4 (#166)  — depends on Sprint 3 (may reduce to verification only)
Sprint 5 (#161)  — independent
Sprint 6 (#160)  — independent; most complex
```
