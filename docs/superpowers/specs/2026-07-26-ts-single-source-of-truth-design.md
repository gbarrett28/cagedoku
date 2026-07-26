# TS as Single Source of Truth for Image/Digit-Recognition Logic — Design

> **Post-execution note (2026-07-26):** the Migration Mapping table below
> reflects the *intended* design. In practice, grid location/`InpImage`,
> `digit_rects.py`, and the PCA-based `RBFClassifier`/`hog_model_loader.py`
> were **not** retired — real constraints found only by reading the actual
> call graph (a live scheduled-CI caller, a dual-recogniser cross-check that
> needs two independent readings of the same crops, and a frozen PCA
> checkpoint with no TS-compatible export) made that unsafe. See
> `docs/superpowers/plans/2026-07-26-ts-single-source-of-truth.md`'s
> "Execution Outcome" section for the full account. Feature extraction and
> classification (HOG+hole extraction, RBF-SVM/linear-OVO inference) **did**
> fully migrate to `ts_bridge.py` everywhere reachable.

## Problem

Multiple pieces of the image and digit-recognition pipeline are independently
implemented in both Python and TypeScript, with no automated check that they
agree:

- **Confirmed diverged**: grid location and given-digit crop extraction
  (`killer_sudoku/image/grid_location.py` + `inp_image.py` vs
  `web/src/image/inpImage.ts`). A Python-side investigation using the Python
  pipeline reported zero duplicate-given-digit conflicts on puzzles the real
  app was actually failing on — the two pipelines were producing different
  crops from the same source images.
- **Parity claimed, never verified**: HOG extraction, hole-feature extraction,
  and OvO-RBF-SVM inference. Python's `RBFClassifier`
  (`killer_sudoku/image/number_recognition.py`) and TS's
  `ovoVote`/`rbfPredictWithConfidence` (`numberRecognition.ts`) are two
  hand-written implementations of the same formula, reading the same exported
  model weights, with no test anywhere comparing their output directly.
- **Also independently implemented, same risk category**: killer-puzzle
  border/cage-total detection (`InpImage._identify_borders`,
  `_build_cage_totals` vs TS's production border-strip clustering,
  `borderClustering.ts`'s `clusterBorders`/`stripFeatures`/`anchorKey`). TS
  also has an experimental contour-tree-based border detector, but it is not
  in the production code path — `includeTree`/`contourTree` is an opt-in
  diagnostic capture, never used for the actual border decision — so it is
  not part of this migration's scope.

Beyond duplicated effort, this is a live correctness risk: if Python's
training-time feature extraction has ever silently drifted from TS's
inference-time extraction, the deployed model is fit on features slightly
different from what it sees in production — a far worse and harder-to-detect
problem than a debugging tool giving a wrong answer once.

## Governing Principle

Already added to `CLAUDE.md`:

> If code is needed in the production app, it must be written in TypeScript,
> and that same code — not a reimplementation — must be called from
> everywhere else that needs it.

This design describes the target architecture that principle implies for the
image/digit-recognition pipeline specifically.

## Architecture

The central move: nothing is *ported*. `ts_bridge.ts` (new) is a thin Node CLI
wrapper that imports the exact same functions the browser bundles —
`hogExtract`/`extractHoleFeatures` (`numberRecognition.ts`/`holeFeatures.ts`)
and the OvO-RBF predict logic (`ovoVote`/`rbfPredictWithConfidence`). Same
file, same function, invoked from a Node process instead of the browser's
module graph. There is no parity to verify going forward, because there is
only one implementation — parity only became a question because Python
maintained a second, independent one.

Two calling mechanisms, matching two different runtime dependencies:

- **Grid location, crop extraction, border/cage-total detection** need
  OpenCV.js/WASM, which needs a real browser. These stay Playwright-driven,
  extending `web/scripts/evaluate-corpus.ts`'s existing pattern (and the
  `given_digit_reads` capture built earlier this session) into a
  corpus-wide cache-population pass.
- **HOG extraction, hole features, RBF-SVM predict** are pure array math, no
  OpenCV dependency. These go through `ts_bridge.ts`: reads JSON from stdin or
  a file, writes JSON to stdout or a file, dispatches on an `--op` flag. One
  entry point, not two — stdin/file is a caller-side choice (small ad hoc
  calls pipe JSON directly; large batch calls use files, mainly so there's an
  inspectable artifact), not a second implementation to maintain.

Python's role narrows to what's genuinely Python-native: orchestrating the
corpus walk, `scikit-learn`'s `SVC.fit()` (and, if the PCA experiment below
proceeds, `PCA.fit()`), dithering augmentation (numba kernel), and gluing
pieces together — reading from the cache or calling `ts_bridge` for anything
crop- or feature-related, never reimplementing it.

## Components

**`web/scripts/ts-bridge.ts`** (new). CLI entry point, imports directly from
`numberRecognition.ts`/`holeFeatures.ts` — no reimplementation. Two ops:
- `extract-features` — crops in, HOG + hole feature vectors out.
- `predict` — crops + a model bin/json path in, predicted label + confidence
  + runner-up + full OvO vote breakdown out (the same vote-level detail this
  session needed to hand-reconstruct in Python to debug the 3-vs-7 confusion).

Invoked as `npx tsx web/scripts/ts-bridge.ts --op predict --input crops.json`
(or piping JSON to stdin with no `--input`).

**`killer_sudoku/training/ts_bridge.py`** (new). Thin Python wrapper: builds
the subprocess call, writes the JSON payload (stdin for small payloads, a
temp file for large batches), parses the result. One shared helper, used by
every Python call site that currently reimplements feature extraction or
classification. Batches always — one subprocess call per batch of crops,
never one call per crop (the ~100-300ms Node startup cost is fine amortized,
expensive repeated).

**Cache-population script**. Extends `evaluate-corpus.ts`'s Playwright-driven
pattern (reusing its `makeWarmPage`/claim-and-complete machinery) to walk the
*entire* corpus — not just puzzles a prior eval run flagged — and populate the
cache tables below for every cell in every puzzle: given digits *and*
cage-total digits, killer *and* classic.

**`given_digit_reads` generalizes into `cell_reads`**, covering every cell
type and every puzzle rather than only flagged classic puzzles.

## Data Model

**`cell_reads`** (generalizes `given_digit_reads`) — one row per digit crop:
- `puzzle_hash`, `git_hash`
- `cell_type`: `'given_digit'` | `'cage_total_digit'`
- `row`, `col`, `digit_index` (0 for given digits and single-digit totals;
  0/1 for a two-digit cage total like "16")
- `predicted_label`, `confident`
- `clashes_with` (JSON; only meaningful for `given_digit` rows — always `[]`
  for cage-total digits, which aren't sudoku-rule-checked)
- `crop_pixels`, `hog_features`, `hole_features` (JSON arrays)

**Border/cage-total geometry** (`border_x`, `border_y`, `cage_totals`) is
per-puzzle, not per-cell — it's added as columns on the existing
`evaluations` table (keyed by the same `(puzzle_hash, git_hash)` it already
uses) rather than a new table.

**Versioning**: already solved by the existing `(puzzle_hash, git_hash)`
convention. A code change is a new commit, which is a new `git_hash` — new
cache rows get populated fresh under that hash rather than silently reusing
stale ones. Older rows aren't deleted; "current" work just prefers the latest
hash.

## Migration Mapping

| File | What retires | What replaces it |
|---|---|---|
| `killer_sudoku/image/grid_location.py` | All of it | Cache lookup (`cell_reads` + `evaluations`) |
| `killer_sudoku/image/inp_image.py` (`InpImage`) | Grid location, classic given-digit reading, `_identify_borders`/`_build_cage_totals` | Cache lookup by `puzzle_hash` |
| `killer_sudoku/training/digit_rects.py` | Bounding-box computation | Cache lookup |
| `killer_sudoku/image/number_recognition.py` | `RBFClassifier`, digit-reading logic | `ts_bridge.predict()` |
| `killer_sudoku/training/hog_model_loader.py` | `HogNumber`, `load_hog_classifier` | `ts_bridge.predict()` with an explicit model path arg |
| `web/train_recogniser.py` | `extract_hog`, `extract_hole_features` | Cache lookup for real corpus crops; `ts_bridge.extract_features()` for dithered variants (see below) |
| `killer_sudoku/training/agreement_pool.py` | `_make_hog_recogniser()`'s own feature/classify logic | `ts_bridge.predict()` pointed at the frozen checkpoint's bin/json; corpus-walk orchestration itself stays |
| `killer_sudoku/training/review_low_confidence.py` | `_make_current_hog_recogniser()`, `_classic_puzzles_from_flagged()`'s re-derivation | Cache lookup by `puzzle_hash`; `ts_bridge.predict()` for scoring against a specific model |

**Dithered training variants** (translate/erode/dilate/noise augmentation) are
synthesized fresh at training time — they never existed in the corpus walk,
so they can't be pre-cached. These get a live `ts_bridge.extract_features()`
batch call per training run (~4,800 crops, matching the actual training-set
size measured this session) rather than a cache lookup. Same underlying TS
code either way, just cache-hit vs live-call depending on whether the crop is
real or synthetic.

## Error Handling

**No silent fallback to a Python reimplementation, ever.** If the
`ts_bridge` subprocess fails (crash, malformed JSON, unexpected exit code) or
the cache is missing/stale for a puzzle some analysis needs, that's a hard
error surfaced to the caller — never a quiet drop into a Python-side
approximation. That fallback is exactly the failure mode this refactor exists
to eliminate. Cache misses are not auto-populated on demand; the caller is
told to run the cache-population script for that `git_hash`.

## Testing

- **`ts-bridge.test.ts`** (vitest) — the CLI wrapper itself: arg parsing,
  `--op` dispatch, stdin/file input and stdout/file output handling. Ordinary
  script testing, not a cross-language comparison (that category of test no
  longer applies — there's only one implementation to test).
- **Cache-population script** — extends `evaluate-corpus.ts`'s existing test
  coverage to the wider per-cell/per-puzzle capture.
- **`ts_bridge.py`** — unit tests mocking the subprocess call (correct JSON
  construction, correct error propagation on failure), plus one real
  end-to-end integration test invoking the actual bridge script, to catch
  environment issues a mock would miss (wrong cwd, `tsx` not resolvable).
- **Migrated call sites** — each existing Python test touching a retired code
  path gets rewritten against the new cache/bridge-based behavior. Enumerating
  every affected test is plan-level detail, not spec-level.

## Extensibility Check: Adding a PCA Stage After HOG

Worked through during design as a test of the boundary, not a committed
feature: PCA has a fit phase and a transform phase, and they land in
different places under this architecture.

- **Fitting** PCA (computing components from the training set) is
  training-time-only, same category as `SVC.fit()` — stays Python, via
  `sklearn.decomposition.PCA().fit_transform()` on the HOG+hole features the
  cache already provides. This becomes a fifth combination in
  `train_combinations.py`'s existing comparison harness alongside
  `pca_stretch`/`pca_letterbox`/`hog_stretch`/`hog_letterbox`.
- **Applying** an already-fitted PCA transform (subtract mean, multiply by
  the component matrix) is pure deterministic linear algebra — goes in TS,
  written once, called from both the browser and `ts_bridge.ts`'s `predict`
  op. The exported model format gains an optional PCA block (mean vector +
  component matrix); TS's predict path applies it when present, skips it
  when absent (no format migration needed for the current no-PCA model).

Nothing about this needs new cache columns or new bridge ops for fitting — it
confirms the boundary (Python fits, TS transforms, Python never reimplements)
generalizes to future experiments without special-casing.

## What Stays Python-Only

`scikit-learn`'s `SVC.fit()` / `PCA.fit()`, the dithering augmentation kernel
(numba), `balanced_split`'s sample partitioning, and overall corpus-walk/
curation orchestration (which corpora to include, how to merge manual
overrides). None of these are things TS needs to do or could sensibly own —
they operate on data the cache/bridge already supplied correctly.

## Out of Scope for This Spec

- Implementation phasing (which piece migrates first, how to avoid a
  big-bang cutover) — a planning-stage decision, made in the implementation
  plan, not here.
- The actual PCA-after-HOG experiment — the section above confirms it *fits*
  the architecture; deciding whether to pursue it is a separate decision.
- Renaming `given_digit_reads` to `cell_reads` is a naming choice for the
  implementation plan to finalize, not a spec-level blocker.
