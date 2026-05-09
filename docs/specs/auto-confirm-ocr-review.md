# Spec: Auto-Confirm OCR Review

## Problem

The OCR Review Screen currently appears after every successful image upload, requiring
the user to click "Confirm & Solve" even when OCR produced a clean result. This is
unnecessary friction for well-scanned puzzles.

## Desired Behaviour

After image processing, if all layout validation checks pass **and** the solver finds
a complete assignment for all 81 cells, the app transitions directly to Playing mode —
the OCR Review Screen is never shown. The OCR Review Screen only appears when there is
an actionable problem for the user to correct.

**Invariant:** whenever the OCR Review Screen is shown, the status bar always contains
a non-empty error or warning message. The review screen never appears as a neutral
"please confirm" prompt.

---

## Auto-Confirm Logic

Immediately after `uploadPuzzle()` succeeds, the app runs the following checks
sequentially (on the unmodified OCR output — no draft edits have been made yet):

| # | Check | Failure → show review with message |
|---|---|---|
| 1 | **Layout validation**: `applyDraftLayout()` on OCR borders + totals returns no `errorCells` and no `warnings` | Structural error: *"Each cage needs exactly one total in its valid range — highlighted in red"* (error cells highlighted in amber on canvas) |
| 2 | **Sum check**: cage totals sum to exactly 405 (already covered by step 1's `warnings`) | *"Cage totals sum to N (expected 405) — please correct the totals"* |
| 3 | **Solver completion**: new `solverFindsCompleteSolution()` verifies the solver produces a complete assignment (every cell reduced to exactly one candidate). See note below. | *"Solver could not determine all cells — please check the cage layout and totals"* |

If all three checks pass, `confirmPuzzle()` is called immediately and Playing mode
is rendered. No review screen is shown.

---

## New `solverFindsCompleteSolution()` Function

A new exported function in `web/src/session/actions.ts`:

```typescript
/**
 * Returns true if solve() produces a complete assignment for all 81 cells
 * (every cell reduced to exactly one candidate). Does not mutate state.
 * Throws if called after confirming.
 *
 * Note: this is NOT a uniqueness proof. solve() uses MRV backtracking as a
 * fallback and returns one solution; it does not search for a second distinct
 * solution. For OCR'd newspaper puzzles this is an appropriate proxy — published
 * puzzles always have a unique solution, so a complete assignment signals that
 * the cage layout is plausible. A false positive (multiple solutions, backtracker
 * picks one) would only occur if OCR produced a genuinely under-constrained
 * layout, which is rare and non-critical: the user can still correct it from the
 * Playing screen via the review flow.
 */
export function solverFindsCompleteSolution(): boolean
```

- Reads the current pre-confirm state from the store
- Calls `solve(spec, givenDigits)` (same call as in `confirmPuzzle()`)
- Returns `true` if every cell has exactly one candidate
- **Does not call `setState()` or mutate any state**

This adds one extra solver run on the happy path (a second run follows in
`confirmPuzzle()`). Both runs complete in well under 100 ms for realistic puzzles.

---

## Changes to `handleProcess()` (main.ts)

`handleProcess()` gains an auto-confirm attempt before calling `applyUploadResult()`:

1. Inline-initialize `draftBorderX`, `draftBorderY`, `draftEdited` from the OCR spec
   (this initialization currently lives inside `applyUploadResult()`; it must be
   available before the auto-confirm check runs).
2. Call `applyDraftLayout()` on those initial draft borders.
3. If validation passes (no errors, no warnings) and `solverFindsCompleteSolution()`
   returns `true`: call `confirmPuzzle()`, call `renderPlayingMode()`, clear
   `pendingCellThumbs`, return — review screen never shown.
4. Otherwise: call `applyUploadResult()` to show the review screen, then set the
   appropriate error status (see table above). For structural errors, also set
   `reviewErrorCells` and call `redrawGrid()` to highlight the problem cages.

Because `draftEdited` is `false` on auto-confirm, the training upload path is
not triggered — consistent with the existing behaviour when the user clicks
"Confirm & Solve" without making any manual edits.

---

## Scope

- **In scope**: killer and classic puzzle types.
- **Out of scope**: partial solutions (auto-confirm requires all 81 cells assigned by
  the solver; puzzles where the solver stalls fall through to the review screen).
- **No UI layout changes**: the OCR Review Screen itself is unchanged.
- **No new UI elements**: the success path simply skips the review screen silently.

---

## Acceptance Criteria

1. Uploading a clean killer puzzle image (valid layout, sums to 405, solver finds
   complete assignment) transitions directly to Playing mode without ever rendering
   the review screen.
2. Uploading an image with a mis-read cage total shows the review screen with an error
   message in the status bar and the problem cage highlighted.
3. Uploading an image with a layout where the solver stalls (cannot assign all cells)
   shows the review screen with "Solver could not determine all cells…".
4. From the review screen, the existing "Confirm & Solve" flow is unchanged.
5. No training data is uploaded on auto-confirm (no manual corrections were made).
