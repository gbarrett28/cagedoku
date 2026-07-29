# Python Scripts Inventory

Audit of `killer_sudoku`'s and `web`'s Python code, begun 2026-07-26 while
closing out the TS-single-source-of-truth migration and updated as the production-
boundary cleanup removes confirmed-dead families.

**Caveat:** dates below are last-*commit* dates (`git log -1 --format=%ad -- <path>`),
not last-*run* dates — there's no execution telemetry available. Several "2026-07-26"
dates are from edits made during that migration session, not evidence of real usage.

## Not "temp" — structured library/engine code (~38 files)

| Path | Purpose | Last touched | Still reachable? |
|---|---|---|---|
| `killer_sudoku/image/*.py` (8 files: `border_clustering.py`, `border_detection.py`, `cell_scan.py`, `config.py`, `grid_location.py`, `inp_image.py`, `number_recognition.py`, `validation.py`) | Legacy image pipeline: grid location, border clustering/detection, cell scanning, digit recognition (`RBFClassifier`/`CayenneNumber`), `InpImage` orchestrator | 2026-07-24 | **Obsolete** — no training/review caller remains; only diagnostics and acquisition utilities scheduled for wholesale removal still import it |
| `killer_sudoku/solver/grid.py`, `puzzle_spec.py` | `ProcessingError` (image-pipeline error, misplaced here historically) and `PuzzleSpec` (the validated cage-layout contract) | 2026-07-26 | **Obsolete** — retained only by the legacy Python image/diagnostic family scheduled for wholesale removal |

## Live — wired into scheduled automation

| Path | Purpose | Last touched |
|---|---|---|
| `web/train_recogniser.py` | Fits the deployed HOG+RBF-SVM model | 2026-07-26 (routes feature extraction through `ts_bridge` now) |
| `scripts/_r2_list.py` / `_r2_download.py` / `_r2_delete.py` | List/pull/clear pending training-sample uploads from Cloudflare R2 | 2026-07-04 |
| `killer_sudoku/training/ts_bridge.py` | Calls TypeScript feature extraction for the trainer (not a user entry point) | 2026-07-26 |

Scheduled Python is now limited to `web/train_recogniser.py` plus the three private
R2 helpers. Model regression evaluation is TypeScript: the workflow builds the
production app and runs `web/scripts/evaluate-corpus.ts` over committed fixtures.

## Actual temp/manual scripts (~23 files)

### A one-time-looking data-migration chain
No CI wiring, narrow single-purpose, no evidence of recent real use:

- `web/migrate_pic_cache.py` (2026-07-04) — converts old `.jpk` pickle caches to JSON
- `web/extract_guardian_samples.py` (2026-07-24) — re-extracts cage-total thumbnails from that JSON cache
- `web/dedupe_browser_train.py` (2026-06-28) — drops exact-duplicate crops from `browser_train.json`
- `killer_sudoku/training/export_model_web.py` (2026-06-28) — converts `.npz` → the TS `.bin`/`.json` format (superseded in spirit by `HogRecogniser.save()` doing this directly now)
- `web/scripts/convert_npz_to_ts.py` (2026-07-22) — looks like a near-duplicate of `export_model_web.py`; worth checking if one is stale

### Manual training/tuning CLIs
Run by hand when retraining or investigating something:

- `killer_sudoku/training/train_number_recogniser.py` (2026-07-26) — fits the PCA/SVM `.npz` checkpoint; has a live `ks-train-numbers` entry point but no evidence anyone runs it regularly
- `killer_sudoku/training/calibrate.py` (2026-06-28) — data-driven threshold calibration for one specific grid-location constant
- `killer_sudoku/training/scrape_puzzles.py` (2026-06-28) — scrapes Guardian puzzle images
- `killer_sudoku/training/review_low_confidence.py` (2026-07-28) — generates a tick-sheet for manually reviewing duplicate-conflict digit reads from browser-selected raw crops
- `killer_sudoku/training/apply_review_corrections.py` (2026-07-25) — merges that tick-sheet's corrections back in

### Pure debug/visualization one-offs
No automation, clearly "run this once while investigating a specific image":

- `killer_sudoku/training/debug_borders.py` (2026-06-28) — draws classified border decisions on a warped image
- `killer_sudoku/training/debug_border_strips.py` (2026-06-28) — draws where border-sampling strips land
- `web/scripts/compare-recognisers.py` (2026-07-26) — diffs two model versions' predictions on harvested samples

## Bottom line

The agreement/comparison-training family (`agreement_pool.py`,
`balanced_sample.py`, `train_combinations.py`, and `synthetic_holdout.py`) has now
been removed as a unit. Its only non-test callers were inside that same family; the
manual review workflow retained only its small corpus-name/key helpers locally.

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

- Added `--op solve` to `web/scripts/ts-bridge.ts`, calling the real production
  solver (`web/src/engine/index.ts`'s `solve()`) directly — no reimplementation.
- Added `killer_sudoku/training/ts_bridge.py`'s `solve()`, which transposes
  `PuzzleSpec.regions`/`cage_totals` (confirmed col-major by reading
  `validate_cage_layout`'s union-find loop directly, not its docstring — a real
  row/col bug caught by a deliberately transpose-sensitive test) to the
  row-major shape the TS side expects.
- Deleted: `killer_sudoku/solver/engine/**` (~30 files), `equation.py`,
  `types.py` (`GridLike`, only used by `equation.py`), and `killer_sudoku/output/`
  (`SolImage`, only used by `Grid.__init__`). `Grid` itself is gone from
  `grid.py` — only `ProcessingError` remains there.

## What did NOT get removed, and why

The remaining migration-chain scripts, debug tools, and legacy training CLIs are
handled by later wholesale-removal sprints after their callers are proved absent.
They are not being refactored merely because they still exist.
