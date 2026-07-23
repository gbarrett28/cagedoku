There are some issues with the digit recogniser that we need to investigate.  The current recogniser was inherited from the last python branch.  Let us call this the "warped PCA recogniser".  Before we reinstated this on master, there was "letterbox HOG" reogniser.  I don't know which of these is the most accurate.  Issues:
1. The warped PCA recogniser was trained on puzzles aswsuming that a solution was a ground truth for digits.  However, the solutions were formed regardless of whterther the puzzle spec was valid so there are mistakes burnt into it.
2. There may be further corrections to this recogniser beyond the last python model
3. The bootstrapping flow for the warped PCA recogniser may be lost
3. The letterbox HOG recogniser may be better but we do not know because there were other errors on master when it was being developed

Some possible forward strategies:
1. a. Recover the latest warped PCA recogniser from master, OR
   b. retrain the warped PCA recogniser from scratch
2. Compare the two recognisers across the puzzle corpus either as is or use 1a or 1b for the warped PCA

1a seems like an almost free thing to do.  Then compare HOG vs 1a to see which recogniser is better.

## Session findings (2026-07-23, from the python-bitexact-port merge session)

Verified facts and leads gathered while investigating the merge -- not yet acted on:

**Re point 3 (bootstrapping flow "may be lost"):** it isn't. The full chain is
intact: `killer_sudoku/training/train_number_recogniser.py` (Step 2: PCA + SVM,
docstring literally says "Step 2 of the digit training pipeline") reads labelled
digits and produces `killer_sudoku/data/num_recogniser.npz`, which is tracked in
git (last committed 2026-04-14, commit `a880935`). `web/scripts/convert_npz_to_ts.py`
converts that `.npz` straight to `web/public/num_recogniser.{bin,json}` in the
`pca_rbf` format `numberRecognition.ts` expects. So **1a is confirmed free**: it's
just re-running `convert_npz_to_ts.py` against the already-committed `.npz` --
no retraining needed unless the `.npz` itself is considered stale.

**New wrinkle for the HOG-vs-PCA comparison (strategy 2):** the two recognisers
were never trained/evaluated on the same crop geometry, so a naive swap
confounds two variables at once, not one:
- HOG was trained on `letterboxWarp` crops (aspect-preserving, black-bar-padded
  to 64x64).
- The warped-PCA model was trained on direct corner-to-corner stretch crops
  (Python's `get_warp_from_rect`).
- `letterboxWarp` **no longer exists** in `numberRecognition.ts` --  it was
  fully replaced by `getWarpFromRect` (unconditional direct stretch), shared by
  both cage-total reading and classic given-digit reading, as part of this
  branch's bit-exact-port work.
- Consequence: comparing "HOG vs PCA" by just swapping the model file, without
  also swapping crop geometry back to letterbox for HOG, is not a fair
  classifier-only comparison -- HOG would be evaluated on a crop shape it was
  never trained on. Either retrain/re-evaluate HOG on stretch crops, or
  reintroduce `letterboxWarp` for a HOG-specific path, before drawing
  conclusions from the comparison.

**Lead on point 1 (mistakes burnt into ground truth) -- not confirmed, worth
checking first:** `web/extract_guardian_samples.py`'s digit-label ground truth
for cage totals comes from `pic.cage_totals` in a *cached* `PicInfo` object, not
a live OCR re-read. This branch fixed a genuine `buildCageTotals` axis-swap bug
(col/row indexing) that predates this session. If any cached `PicInfo` files
used to build training samples were generated *before* that fix, their
`cage_totals` -- and therefore the digit labels derived from them -- could be
silently wrong. Worth checking cache generation dates against the fix commit,
or just regenerating the caches, before trusting existing extracted samples as
ground truth. (Did not verify whether this has actually happened -- flagging as
a lead, not a confirmed cause.)

**Partial mitigation now available:** this session built a "retraining
suggestions" pipeline (`web/src/engine/retrainingSuggestions.ts`,
`web/scripts/review-retraining-suggestions.ts`,
`web/scripts/export-retraining-suggestions.ts`, `retraining_suggestions` table
in `corpus-db.ts`) that detects duplicate-digit OCR errors against the corpus
and queues corrections for human review -- never auto-applied. It's relevant to
point 1 but only catches one failure mode (a corrected digit must resolve a
row/col/box duplicate); it does not catch every way an invalid spec could
produce a silently-wrong "solved" digit. Currently 0 approved samples -- nothing
has gone through review yet, so it hasn't cleaned anything up so far.