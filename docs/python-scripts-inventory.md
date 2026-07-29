# Python Scripts Inventory

Audit of `killer_sudoku`'s and `web`'s Python code, begun 2026-07-26 while
closing out the TS-single-source-of-truth migration and updated as the production-
boundary cleanup removes confirmed-dead families.

**Caveat:** dates below are last-*commit* dates (`git log -1 --format=%ad -- <path>`),
not last-*run* dates — there's no execution telemetry available. Several "2026-07-26"
dates are from edits made during that migration session, not evidence of real usage.

## Removed structured OCR/solver code

The remaining `killer_sudoku/image/` and `killer_sudoku/solver/` packages were
removed wholesale after symbol-level reachability checks found only their own tests
and three dependent diagnostic helpers. The debug helpers, test-only digit-rectangle
extractor, and temporary bridge `predict`/`solve` operations were deleted rather than
refactored. The retained bridge exposes only production TypeScript crop warping and
feature extraction to Python training orchestration.

## Live — wired into scheduled automation

| Path | Purpose | Last touched |
|---|---|---|
| `web/train_recogniser.py` | Merges and deduplicates inputs, selects the TS crop warp, fits HOG+RBF-SVM, and writes the deployable manifest | 2026-07-29 (raw crops and features route through `ts_bridge`) |
| `scripts/_r2_list.py` / `_r2_download.py` / `_r2_delete.py` | List/pull/clear pending training-sample uploads from Cloudflare R2 | 2026-07-04 |
| `killer_sudoku/training/ts_bridge.py` | Calls production TypeScript crop warping and feature extraction for the trainer (not a user entry point) | 2026-07-29 |

Scheduled Python is now limited to `web/train_recogniser.py` plus the three private
R2 helpers. Model regression evaluation is TypeScript: the workflow builds the
production app and runs `web/scripts/evaluate-corpus.ts` over committed fixtures.

## Remaining manual scripts

### Human training/curation CLIs

- `killer_sudoku/training/review_low_confidence.py` (2026-07-28) — generates a tick-sheet for manually reviewing duplicate-conflict digit reads from browser-selected raw crops
- `killer_sudoku/training/apply_review_corrections.py` (2026-07-25) — merges that tick-sheet's corrections back in

## Bottom line

The agreement/comparison-training family (`agreement_pool.py`,
`balanced_sample.py`, `train_combinations.py`, and `synthetic_holdout.py`) has now
been removed as a unit. Its only non-test callers were inside that same family; the
manual review workflow retained only its small corpus-name/key helpers locally.
The standalone recogniser comparison and legacy NPZ-to-browser conversion scripts
were also removed when TypeScript retired PCA/template and linear manifests.
The Python PCA trainer/exporter, Python HOG model loader, frozen checkpoint package,
and `ks-train-numbers` entry point were then removed as one closed legacy family.
Callerless calibration, scraping, archive extraction, and pickle-cache migration tools
were removed next; no replacement wrappers were added.

## Removed entry points

The broken `cagedoku` entry point was removed earlier. The `ks-evaluate` entry point
and its Python evaluator/status store were removed when scheduled evaluation moved
to the production browser pipeline.

## The Python solver, fully retired (2026-07-26, after the correction above)

Once `killer_sudoku/solver/`'s actual reachability was traced properly (not just
checking one entry point — see the corrected row above), it turned out there
were **two** Python solving implementations: a legacy constraint/equation-based
`Grid.solve()`, and a newer rule-engine `Grid.engine_solve()` (mirroring
`web/src/engine/`). Both are now retired:

- The temporary bridge `solve` operation and Python wrapper were removed after
  reference checks found no production, CI, or user caller.
- The final `grid.py`/`puzzle_spec.py` remnants and the entire Python image pipeline
  were deleted with their direct tests rather than refactored.

## What did NOT get removed, and why

Exact-input deduplication now runs inside `web/train_recogniser.py` after all sources
are merged and before production warping, weighting, or dithering. The standalone
mutation script was removed after its replacement and regression tests were in place.
