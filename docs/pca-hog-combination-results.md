# PCA/HOG Combination Results

Full guardian+observer+classic_guardian(easy)+classic_observer corpora, gated
on PCA/HOG agreement + clean solve (see
`docs/superpowers/plans/2026-07-24-pca-hog-agreement-recogniser.md`),
balanced to 100 samples/digit (80 train / 20 holdout) across all 10 digit
classes. Training data is dithered (`web/train_recogniser.py`'s
`dither_batch`, 5 variants/sample); holdouts are never dithered.

Training set: 800 real samples (4800 after dithering). Same-distribution
holdout: 200. Cross-font holdout: 10080 (digits 0-9 rendered in every
discoverable system TTF font, never used in training).

| Combination | Train accuracy | Same-distribution accuracy | Cross-font accuracy |
|---|---|---|---|
| pca_stretch | 1.0000 | 1.0000 | 0.3420 |
| pca_letterbox | 1.0000 | 1.0000 | 0.5514 |
| hog_stretch | 1.0000 | 1.0000 | 0.7351 |
| **hog_letterbox** | **1.0000** | **1.0000** | **0.8680** |

## Root cause of the earlier (dreadful) numbers — found and fixed

An earlier run of this same benchmark got same-distribution accuracy of only
~42-52% across all four combinations, with train accuracy 48-79% — clearly
wrong for a model class that should comfortably fit 80 samples/class.
Investigating why (see `killer_sudoku` git history around 2026-07-25, branch
`fix/killer-cage-totals-row-col-transposition`) found the actual cause:

**A genuine `[col, row]` vs `[row, col]` indexing bug**, present in three
places that all fed this training pipeline:

1. `web/src/image/inpImage.ts`'s `buildCageTotals` and
   `web/src/image/borderClustering.ts`'s `sampleStrip` — two compensating
   swaps in the live web image pipeline that canceled out for solving
   purposes but produced a genuinely transposed detected grid.
2. `killer_sudoku/training/agreement_pool.py`'s `build_agreement_pool`
   (killer branch): `total_str = str(int(totals_pca[col, row]))` should have
   been `totals_pca[row, col]` — `cage_totals` is row-major throughout this
   codebase (see `CLAUDE.md`'s Coordinate Conventions section).
3. `killer_sudoku/training/collect_numerals.py`'s `_extract_cell_contours`
   and `bootstrap_numerals` had the same pattern.

This is the exact, concrete bug behind the "19 misread as 16" example
originally flagged in this experiment: the crop extracted was genuinely a
printed `9` at cell (row=6, col=0), but `totals_pca[col, row]` fetched the
total from the transposed cell (row=0, col=6), which happened to read `16`.
Both PCA and HOG independently "confirmed" the wrong label because they were
being shown a correct crop paired with someone else's total, not because of
any actual model weakness.

**Fixing the indexing bug (not more data, not smarter agreement-gating)
took same-distribution accuracy from ~42-52% to a clean 100% across all
four combinations**, and train accuracy to 100% as well — confirming the
original diagnosis that PCA's low train accuracy was a *label noise*
signature (a model that can't fit its own training data isn't fixable by
adding more of the same bad data).

## Verdict: the winner flipped, and it's now deployed

With label noise removed, **`hog_letterbox` clearly wins** on cross-font
accuracy (0.8680, vs `pca_letterbox`'s 0.5514) — same-distribution and train
accuracy are uninformative for choosing between combinations (all four hit
100%), so cross-font is the only remaining signal. This also revises the
original HOG diagnosis: HOG's earlier "overfitting" signature (train ≫
holdout) was likely mostly the *same* label-noise problem manifesting
differently (HOG's higher-dimensional feature space could memorize noisy
labels rather than fail to fit them at all, the way PCA did), not primarily
an intrinsic data-volume shortfall.

`ACTIVE_RECOGNISER` in `web/train_recogniser.py` is now `HogRecogniser()`,
and `killer_sudoku/training/train_combinations.py`'s `main()` saves the
fitted `hog_letterbox` model directly to `web/public/num_recogniser.bin` /
`.json` (the live bundled model the deployed app loads) as part of this same
run — this is the actual production model now, not just a training-script
default.

**Caveats:**
1. Same-distribution and train accuracy sitting at a perfect 100% on an
   800-sample set is a small-sample ceiling effect, not evidence the
   underlying problem is trivially solved — it just means label noise was
   the dominant limiter, not model capacity. A larger training set would be
   more informative and is worth pursuing as a follow-up.
2. Cross-font accuracy (86.8%) is still below the previous shipped PCA
   model's holdout accuracy on its own training distribution. Real-world
   performance should be monitored via `corpus.db`'s evaluation history
   (`web/scripts/evaluate-corpus.ts`) after this deploy.
3. Confusion-prone digit pairs (6/9, 2/7, 3/8) are still worth flagging for
   manual review in the agreement pool rather than auto-accepting, as a
   defense-in-depth measure independent of this specific bug.
