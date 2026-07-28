# Python Scripts Inventory

Audit of `killer_sudoku`'s and `web`'s Python code (~70 non-test files, excluding
`__init__.py`/stubs), done 2026-07-26 while closing out the TS-single-source-of-truth
migration.

**Caveat:** dates below are last-*commit* dates (`git log -1 --format=%ad -- <path>`),
not last-*run* dates — there's no execution telemetry available. Several "2026-07-26"
dates are from edits made during that migration session, not evidence of real usage.

## Not "temp" — structured library/engine code (~38 files)

| Path | Purpose | Last touched | Still reachable? |
|---|---|---|---|
| `killer_sudoku/image/*.py` (8 files: `border_clustering.py`, `border_detection.py`, `cell_scan.py`, `config.py`, `grid_location.py`, `inp_image.py`, `number_recognition.py`, `validation.py`) | Legacy image pipeline: grid location, border clustering/detection, cell scanning, digit recognition (`RBFClassifier`/`CayenneNumber`), `InpImage` orchestrator | 2026-07-24 | **Temporarily** — only the manual agreement/training family still calls it; scheduled evaluation no longer does |
| `killer_sudoku/solver/grid.py`, `puzzle_spec.py` | `ProcessingError` (image-pipeline error, misplaced here historically) and `PuzzleSpec` (the validated cage-layout contract) | 2026-07-26 | **Temporarily** — imported only by the legacy Python image/agreement family |

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
- `killer_sudoku/training/train_combinations.py` (2026-07-25) — compares PCA/HOG × stretch/letterbox architectures
- `killer_sudoku/training/synthetic_holdout.py` (2026-07-25) — renders TTF-font digits as a cross-font generalization check
- `killer_sudoku/training/calibrate.py` (2026-06-28) — data-driven threshold calibration for one specific grid-location constant
- `killer_sudoku/training/scrape_puzzles.py` (2026-06-28) — scrapes Guardian puzzle images
- `killer_sudoku/training/review_low_confidence.py` (2026-07-26) — generates a tick-sheet for manually reviewing low-confidence/conflicting digit reads
- `killer_sudoku/training/apply_review_corrections.py` (2026-07-25) — merges that tick-sheet's corrections back in
- `killer_sudoku/training/balanced_sample.py` — not a script (no `__main__`), just a helper the above import

### Pure debug/visualization one-offs
No automation, clearly "run this once while investigating a specific image":

- `killer_sudoku/training/debug_borders.py` (2026-06-28) — draws classified border decisions on a warped image
- `killer_sudoku/training/debug_border_strips.py` (2026-06-28) — draws where border-sampling strips land
- `web/scripts/compare-recognisers.py` (2026-07-26) — diffs two model versions' predictions on harvested samples

## Bottom line

Of ~70 substantive Python files, roughly **23 are genuine "temp/manual" scripts** —
about a third. Five of those (the migration chain) look like they've served their
purpose and probably haven't run in a while; the rest are still plausible manual
tools for retraining/debugging work, just with no way to confirm actual recent use
beyond edit history.

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

Nothing else in this inventory is confirmed dead. The migration-chain scripts,
debug tools, and manual training CLIs above are flagged only as "hasn't been
edited in a while" — that is not the same claim as "has zero callers." None of
them were deleted.
