# Canny + Sweep-Fill Binarisation — Investigation Results (Abandoned)

## Status: investigated, not merged. Old-style threshold binarisation kept.

Branch: `feature/canny-sweepfill-binarisation` (not merged to master; kept
for reference — the code and this write-up are the deliverable, not a
production change).

## Problem this set out to solve

Cage-total digit extraction (`buildCageTotals`) binarises the warped grid
image before contour detection. The existing approach (still on master)
warps a single global `cv2.inRange`-style threshold computed once during
grid location and reuses it for digit extraction. A prior, separate
investigation (`feature/canny-cage-total-contours`, the
`fix-pdf-getorinsertcomputed` worktree — still present, untouched, not
part of this branch) found real cases where that global threshold fails:
a digit whose ink touches a solid gridline gets swallowed into the
gridline's connected component under one global cutoff (e.g. a "22" total
misread as a single "8").

This branch's goal: replace only the binarisation step — the thresholding
of the warped grey image into the ink/non-ink mask fed to `findContours`
— with Canny edge detection + a "sweep and cluster" fill (`buildSweepInkMask`
in `web/src/image/inpImage.ts`), reconstructing a solid ink mask from local
gradient structure instead of one global cutoff. Deliberately scoped to
*only* the binarisation step — box-ordering, `getNumContours`, `splitNum`,
and every other stage were left byte-identical to master (see the
diff: `git diff master -- web/src/image` on this branch touches only
`config.ts`, `inpImage.ts`, `opencv.ts`, ~271 lines).

## What was tried, in order

1. **Base sweep-fill algorithm**: k-means (3 clusters: dark/mid/light) on
   row-sweep and column-sweep segment averages between Canny edges: a
   deterministic rule (ink iff both sweeps agree the pixel is darkest-or-
   middle, i.e. white always wins any row/column disagreement).
2. **Conflict resolution refinement**: a segment average can be diluted by
   an incompletely-closed Canny edge (confirmed on real corpus output,
   `killer_sudoku_0.jpg` r8c5's "1" — a gap in the edge trace let one
   sweep's segment run past the stroke into background). Replaced the
   "white always wins" default for disagreeing pixels with a 9×9
   local-neighborhood-average reclassification against the same k-means
   centers — measurably closed the gap on real crops.
3. **Canny parameter sweep**: visually compared `apertureSize` (3/5/7) ×
   `L2gradient` (true/false) × `cannySigma` (0.20–0.70) on real crops.
   `apertureSize=3, L2gradient=true` was the clear winner (user-scored 7/10
   vs 5/10 baseline, vs -1/10 at aperture 7); `cannySigma` had negligible
   effect in the range tested. Locked in as the final configuration.

## Results

| Test | Old-style (master) | Canny+sweep-fill (this branch, tuned) |
|---|---|---|
| 8-puzzle hand-picked hard-case sample | 8/8 clean (100%) | 1/8 clean (12.5%), before Canny tuning |
| 50-puzzle random sample (guardian killer corpus) | 51/51 clean (100%) | 35/51 clean (~69%), after Canny tuning |
| **Full 379-puzzle guardian killer corpus** | **377/379 clean (99.5%)** | not run at full scale — abandoned before this was justified |

The 16 remaining Canny-branch failures on the 50-sample were all `sum
warning` (cage structure/box placement correct, grid-total sum off) —
never `layout errors`, never over-detected boxes, never low-confidence
recognizer flags. Manual review of 148 sampled digit crops found 4 actual
misreads; 3 of 4 were the *same* substitution: a "0" read as "6".

## Root cause: binarisation style, confirmed by direct A/B test

Isolated the variable with a same-box, different-pixel-source experiment
(temporary debug hooks in a disposable checkout, not part of this branch):
for the 3 confirmed "0"→"6" misreads, cropped the *exact same bounding box*
from (a) the Canny+sweep-fill mask and (b) master's old-style threshold
mask, and ran both through the *same* production recogniser
(`activeRecogniser().recognise()`, unmodified).

| Case | Canny+sweep-fill crop | Old-style crop | Expected |
|---|---|---|---|
| `killer_sudoku_104.jpg` r0c0 digit 1 | 6 (wrong) | 0 (correct) | 0 |
| `killer_sudoku_104.jpg` r4c0 digit 1 | 6 (wrong) | 0 (correct) | 0 |
| `killer_sudoku_1.jpg` r0c6 digit 1 | 6 (wrong) | 0 (correct) | 0 |

Same coordinates, same recogniser, only the pixel content changed — wrong
under Canny+sweep-fill, correct under the old threshold, every time. This
rules out box placement, cell assignment, and the recogniser model itself.
The digit recogniser (HOG/PCA-RBF-SVM) was trained on crops shaped by the
old threshold's ink rendering; Canny+sweep-fill renders the same "0" with
different local shape (plausibly a broken/altered loop), which is enough
to flip the classifier's decision while it stays confident (no case ever
reported `confident: 0`).

There was also one confirmed **segmentation** failure distinct from the
recognition pattern above: `killer_sudoku_132.jpg` r4c4, a single "8" split
by the sweep-fill mask into two disconnected boxes, read as "10" instead
of "8" — the same family of failure as the r8c5 edge-gap case, but at a
stroke self-intersection instead of a stroke tip.

## Decision

Abandoned. Fixing the binarisation-style mismatch would require retraining
the digit recogniser on Canny+sweep-fill-shaped crops — a materially bigger
project than this one — just to catch up to what the old threshold already
does at 99.5% on the full corpus. Not pursued further; branch kept
unmerged for reference (the sweep-fill algorithm, k-means clustering, and
Canny-parameter findings may be useful if this is revisited later, e.g.
alongside a recogniser retrain).

## Follow-up (not started)

The old-style threshold's own 2 residual failures on the full 379-puzzle
corpus are a smaller, more tractable next target than reviving Canny:

- `killer_sudoku_247.jpg` — `sum warning`
- `killer_sudoku_275.jpg` — `layout errors`

Not yet diagnosed as segmentation vs. recognition vs. misplacement.
