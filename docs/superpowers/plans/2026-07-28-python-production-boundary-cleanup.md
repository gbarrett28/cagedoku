# Python/TypeScript Production-Boundary Cleanup Implementation Plan

> **For Codex or Claude Code:** execute one sprint at a time. Each sprint is deliberately scoped to fit within a three-hour agent session, ends with a passing bronze gate, and produces at most one reviewable commit. Do not combine sprints or create an empty audit commit.

**Goal:** Remove redundant Python production logic and accidental Python entry points while making the production browser pipeline the authority for OCR, crop geometry, recogniser inference, and retrain evaluation.

**Architecture:** Delete non-retained callers and whole experimental paths before simplifying their dependencies. TypeScript owns digit bounding-box selection, raw crop extraction, stretch/letterbox warping, features, inference, evaluation, and solving. Python may curate labels, choose a named TS warp strategy, augment training data, fit with scikit-learn, and run the three private R2 helpers.

**Primary design:** `docs/superpowers/specs/2026-07-28-python-production-boundary-cleanup-design.md`

## Sprint contract

Every sprint below has an **agent budget of at most three hours** in either Codex or Claude Code. The estimate includes navigation, implementation, every listed verification gate, and the commit. If unexpected work would exceed the budget:

1. do not broaden the sprint;
2. keep or restore a coherent implementation boundary;
3. make the focused tests and `bash scripts/run-bronze-gate.sh` pass;
4. record the discovered follow-up in the next sprint before committing.

For every sprint:

- start from the preceding sprint's green commit;
- use Serena for TypeScript/Python navigation and edits;
- use `find_referencing_symbols` before deleting a symbol or module;
- preserve unrelated user changes;
- use TDD for retained behaviour;
- delete tests with deleted behaviour rather than adapting doomed APIs;
- run the listed focused checks;
- run `bash scripts/run-bronze-gate.sh` from the repository root as the final required gate;
- commit only when the bronze gate and every additional gate listed for that sprint pass.

Feature-branch sprints require the bronze gate only. Run `bash scripts/run-silver-gate.sh` once in Sprint 16, after final documentation hygiene. Then push the feature branch and open a pull request; do not merge it to `master`.

Before Sprint 1, commit the existing contour-tree work and create an isolated worktree with `superpowers:using-git-worktrees`. Read `docs/architecture.md` and `docs/image-pipeline.md` before changing the image/training pipeline.

## Target data contract

`corpus.db` stores the exact variable-sized digit bounding-box crop copied from the already-warped puzzle grid. Cropping is a production TypeScript decision and cannot be varied by training.

```ts
export type WarpStrategy = 'stretch' | 'letterbox';

export interface RawDigitCrop {
  readonly rect: BRect;          // x, y, width, height in the warped grid
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;   // row-major; length === width * height
}
```

Each new `cell_reads` row contains:

```text
source_x, source_y, source_width, source_height, source_pixels
warp_strategy
recognition_pixels              # exact derived 64×64 deployed input
hog_features, hole_features, prediction
```

`source_pixels` is the strategy-neutral training source. `recognition_pixels` is audit evidence for the deployed prediction. Python must never treat `recognition_pixels` as raw or implement its own stretch/letterbox transform.

---

## Sprint 1 — Remove the unused split recogniser

**Budget:** 1–2 hours.

**Files:** `web/src/main.ts`, `web/src/session/store.ts`, `web/src/image/inpImage.ts`, their tests, `web/e2e/app.spec.ts`, `pyproject.toml`, current image/inventory docs; delete `web/train_split_recogniser.py` and `web/public/split_recogniser.{bin,json}`.

- [x] Add a Playwright regression test that records requests during startup and asserts no path contains `split_recogniser`.
- [x] Confirm it fails because startup loads the assets.
- [x] Remove `loadSplitRec`, `_splitRec`, `_splitRecLoading`, `getSplitRec`, and the unused `parsePuzzleImage` parameter.
- [x] Delete the trainer/assets and their packaging/docs references. Leave the retained ink-profile `splitNum` algorithm unchanged.
- [x] Run:

```bash
cd web
npx vitest run src/session/store.test.ts src/image/numberRecognition.test.ts
npx playwright test e2e/app.spec.ts -g "split recogniser"
cd ..
rg "split_recogniser|loadSplitRec|_splitRec" web
bash scripts/run-bronze-gate.sh
bash scripts/run-silver-gate.sh
```

- [x] Commit: `refactor: remove unused split recogniser`.

**Done when:** startup does not request or retain any split-recogniser model state and both gates pass.

---

## Sprint 2 — Introduce raw-crop extraction in the production recognisers

**Budget:** 2–3 hours.

**Files:** `web/src/image/numberRecognition.ts`, `web/src/image/inpImage.ts`, their tests and directly affected result types.

- [x] Add failing tests for `extractRawDigitCrop(cv, warpedGrid, rect)` using a known non-square ROI. Cover non-positive and out-of-bounds rectangles.
- [x] Add failing parity tests for `warpRawDigitCrop(cv, crop, 'stretch'|'letterbox', 64)` against the current production recognition thumbnails.
- [x] Implement `RawDigitCrop`, `WarpStrategy`, `extractRawDigitCrop`, and `warpRawDigitCrop`. Reuse the current TypeScript/OpenCV.js destination geometry; do not create a second warp implementation.
- [x] Refactor classic `readClassicDigits` and killer `splitNum` to extract once and return both raw source crop and canonical recognition thumbnail. Maintain exact alignment with recognitions and `digitIndex`.
- [x] Thread `cellSourceCrops: ReadonlyMap<string, readonly RawDigitCrop[]>` through `ParseResult` and the immediate callers. Assert for every key:

```ts
sourceCrops.length === cellThumbs.length
sourceCrops.length === cellRecognitions.length
```

- [x] Run focused tests, then both gates:

```bash
cd web
npx vitest run src/image/numberRecognition.test.ts src/image/inpImage.test.ts
cd ..
bash scripts/run-bronze-gate.sh
bash scripts/run-silver-gate.sh
```

- [x] Commit: `feat: retain raw digit crops before recognition warping`.

**Done when:** production still recognises the same thumbnails, while every recognised digit also exposes its untouched bounding-box pixels from the warped grid.

---

## Sprint 3 — Persist raw and derived crop evidence

**Budget:** 2–3 hours.

**Files:** `web/src/image/trainingExport.ts`, `web/src/session/actions.ts`, `web/src/main.ts`, `web/scripts/corpus-db.ts`, `web/scripts/evaluate-corpus.ts`, their tests, `docs/corpus-db.md`, `docs/image-pipeline.md`.

- [x] Add DB round-trip tests for a non-square crop and byte ordering.
- [x] Migrate `cell_reads`:
   - rename legacy `crop_pixels` to `recognition_pixels` when necessary;
   - add `source_x`, `source_y`, `source_width`, `source_height`, `source_pixels`, and `warp_strategy`;
   - leave source columns NULL for historical rows;
   - require all newly inserted rows to supply valid non-null source data.
- [x] Update browser export to schema version 2:

```ts
{
  digit: number;
  sourceRect: BRect;
  sourceWidth: number;
  sourceHeight: number;
  sourcePixels: number[];
  recognitionPixels: number[];
  warpStrategy: WarpStrategy;
}
```

- [x] Update `main.ts` and `evaluate-corpus.ts` so new evaluations persist exact raw source evidence plus the deployed derived evidence.
- [x] Add validation: positive dimensions; `sourcePixels.length === sourceWidth * sourceHeight`; `recognitionPixels.length === 4096`; known strategy.
- [x] Do not relabel historical 64×64 data as raw. A fresh `(puzzle_hash, git_hash)` evaluation is how a complete row is produced.
- [x] Run:

```bash
cd web
npx vitest run src/image/trainingExport.test.ts scripts/corpus-db.test.ts src/image/inpImage.test.ts
cd ..
bash scripts/run-bronze-gate.sh
bash scripts/run-silver-gate.sh
```

- [x] Commit: `feat: store raw and deployed digit crop evidence`.

**Done when:** `corpus.db` can reproduce the deployed thumbnail and can later derive either warp strategy from the stored raw crop without recropping.

---

## Sprint 4 — Add deterministic browser evaluation reports

**Budget:** 2–3 hours.

**Files:** create `web/scripts/evaluation-report.ts` and test; modify `web/scripts/evaluate-corpus.ts`, `web/scripts/corpus-db.ts`, and tests.

- [x] TDD these pure interfaces:

```ts
type EvaluationBucket = 'clean' | 'backtracked' | 'notSolved';
interface EvaluationOutcome {
  puzzleHash: string;
  path: string;
  bucket: EvaluationBucket;
  reason: string | null;
  specHash: string | null;
}
interface EvaluationReport {
  version: 1;
  modelSha256: string;
  outcomes: readonly EvaluationOutcome[];
}
```

- [x] Implement `compareEvaluationReports`; rank `clean=2`, `backtracked=1`, `notSolved=0`. Fail only when an existing baseline puzzle drops rank. Sort outcomes/regressions by path.
- [x] Add evaluator flags `--puzzle-dir`, `--report-out`, and `--compare-report`. Reuse the existing browser worker; do not copy it or introduce Python OCR.
- [x] Test content-hash-idempotent directory ingestion, deterministic reports, model hashing, and regression exit status through a factored function.
- [x] Run:

```bash
cd web
npx vitest run scripts/evaluation-report.test.ts scripts/corpus-db.test.ts
cd ..
bash scripts/run-bronze-gate.sh
```

- [x] Commit: `feat: report production browser corpus outcomes`.

**Done when:** the retained evaluator can produce and compare deterministic reports without any workflow change yet.

---

## Sprint 5 — Cut CI over to browser evaluation and delete the Python evaluator

**Budget:** 2–3 hours.

**Files:** `web/eval-baseline.json`, `.github/workflows/retrain.yml`, `pyproject.toml`, current docs; delete `killer_sudoku/training/evaluate.py`, `killer_sudoku/training/status.py`, and evaluator-specific tests.

- [x] Generate `web/eval-baseline.json` with the shipped model and Guardian fixtures through the production preview and `evaluate-corpus.ts`.
- [x] Replace the workflow's compare-only Python step with: build; start preview; wait for readiness; run the TS evaluator against the newly generated model; compare with the baseline; always stop the preview process.
- [x] Delete Python evaluator/status code, tests, `ks-evaluate`, and dependencies/comments retained only for that path.
- [x] Verify no current code refers to `training.evaluate`, `collect_status`, `StatusStore`, or `ks-evaluate`.
- [x] Run the focused evaluation tests and bronze gate.
- [x] Commit: `ci: evaluate retrained models through production browser`.

**Done when:** CI evaluates the candidate model through the deployable browser path, and no Python evaluator remains.

---

## Sprint 6 — Make human review preserve raw conflict crops

**Budget:** 2–3 hours.

**Files:** `killer_sudoku/training/review_low_confidence.py`, `killer_sudoku/training/apply_review_corrections.py`, `web/train_recogniser.py`, and their focused tests.

- [x] Add a round-trip test using a 3×7 raw crop. The override record contains `sourceRect`, `sourceWidth`, `sourceHeight`, and raw `cropPng`; loading must reproduce the exact array.
- [x] Add a failure case where PNG dimensions disagree with metadata.
- [x] Remove review `confidence` mode, startup model fitting, `ovo_predictions`, `score_candidates`, `least_confident`, and `fit_deployed_hog_model` before simplifying rendering.
- [x] Build review items only from duplicate conflicts in `cell_reads.source_pixels`. Render the browser-selected raw crop; do not read `recognition_pixels` for an override.
- [x] In `load_overrides_file`, decode grayscale PNG and require shape `(sourceHeight, sourceWidth)`. Preserve pixels unchanged. Do not warp here.
- [x] Run focused Python tests and bronze.
- [x] Commit: `refactor: preserve raw conflict crops during review`.

**Done when:** a manual correction preserves the original TS-selected bounding box and can later be warped exactly once by either strategy.

---

## Sprint 7 — Delete the agreement and comparison-training harness

**Budget:** 1–2 hours.

**Files:** delete `agreement_pool.py`, `balanced_sample.py`, `train_combinations.py`, `synthetic_holdout.py` and their tests; update current image/inventory docs and surviving review imports.

- [x] Confirm `build_full_corpus_pool`, `build_agreement_pool`, `balanced_split`, and `generate_cross_font_holdout` have no retained callers after Sprint 6.
- [x] Delete the whole family; do not adapt it to `cell_reads`.
- [x] Remove stale imports, CLI/docs references, and dependencies used only by the family.
- [x] Run retained review/training tests and bronze.
- [x] Commit: `refactor: remove recogniser agreement harness`.

**Done when:** reachability from tests or historical manual tools no longer keeps a second OCR architecture alive.

---

## Sprint 8 — Retire PCA from TypeScript and add production-model validation

**Budget:** 2–3 hours.

**Files:** `web/src/image/numberRecognition.ts` and test; create `web/scripts/validate-model.ts` and test; remove `web/scripts/compare-recognisers.py` and `web/scripts/convert_npz_to_ts.py` if their last TS/PCA use is gone.

- [x] 1. Add a failing test that a `pca_rbf` manifest raises an explicit unsupported-classifier error.
- [x] 2. Delete PCA parameter parsing, templates, recogniser class, and dispatch. Retain the shipped HOG/hole RBF path.
- [x] 3. Add `validateModel(modelBinPath, modelJsonPath, canonicalCrops)` which uses `loadNumRecogniser`; it contains no classifier implementation.
- [x] 4. Its CLI reads schema-v2 `recognitionPixels` for deployed-model auditing. It must never call them raw or rewarp them.
- [x] 5. Test committed model loading using two canonical samples.
- [x] 6. Delete comparison/conversion scripts once references prove they are obsolete.
- [x] 7. Run focused tests, build, and bronze.
- [x] 8. Commit: `refactor: retain only production HOG RBF loading`.

**Done when:** the browser supports one manifest type and externally written models can be validated through the real loader.

---

## Sprint 9 — Retire legacy Python recogniser architectures and data

**Budget:** 2–3 hours.

**Files:** `web/train_recogniser.py`, tests, `pyproject.toml`, current docs; delete `killer_sudoku/training/hog_model_loader.py`, `train_number_recogniser.py`, `export_model_web.py`, `killer_sudoku/data/`, and their tests.

- [x] 1. Replace the stale PCA-active test with an assertion that the active trainer is HOG/RBF.
- [x] 2. Delete `PcaRbfRecogniser`, PCA branches/constants/tests, legacy model loading/export, package data, and `ks-train-numbers`.
- [x] 3. Collapse the trainer abstraction only after alternate implementations are gone; do not retain a one-member abstract hierarchy.
- [x] 4. Keep fitting/export, augmentation, and TS feature calls intact for later raw-input work.
- [x] 5. Run trainer tests, model validation tests, absence greps, and bronze.
- [x] 6. Commit: `refactor: remove legacy Python recognisers and checkpoints`.

**Done when:** Python has one fitting implementation matching the only shipped browser model.

---

## Sprint 10 — Delete the redundant Python image and solver packages wholesale

**Budget:** 1–2 hours.

**Files:** delete `killer_sudoku/image/`, `killer_sudoku/solver/`, and tests whose sole subject is those packages; adjust only direct retained imports/docs required for green tests.

- [x] 1. Use Serena references on `InpImage`, `locate_grid`, `validate_cage_layout`, `CayenneNumber`, Python `PuzzleSpec`, and `ProcessingError`.
- [x] 2. If a retained caller appears, stop and add its migration to this sprint; do not create an adapter.
- [x] 3. Delete both packages as directories before doing survivor refactors.
- [x] 4. Delete tests for their production behaviour rather than porting them to caches.
- [x] 5. Run forbidden-import greps and bronze.
- [x] 6. Commit: `refactor: remove redundant Python image and solver pipelines`.

**Done when:** Python has no importable image-to-puzzle or puzzle-solving implementation.

---

## Sprint 11 — Delete dependent diagnostics, acquisition, and migration tools

**Budget:** 1–2 hours.

**Files:** delete `calibrate.py`, border/debug scripts, `digit_rects.py`, `scrape_puzzles.py`, `web/extract_guardian_samples.py`, `web/migrate_pic_cache.py`, and their tests; update `pyproject.toml` and current docs.

- [x] 1. Confirm every script is now callerless or depended only on the deleted Python image pipeline.
- [x] 2. Delete them wholesale, including `ks-scrape`, scraper extras, Ruff overrides, and direct tests.
- [x] 3. Do not replace one-time migration or diagnostic scripts with TS wrappers absent a current user/CI entry point.
- [x] 4. Run absence greps and bronze.
- [x] 5. Commit: `refactor: remove obsolete Python OCR utilities`.

**Done when:** no Python user-level entry point remains outside recogniser training/curation.

---

## Sprint 12 — Expose production stretch and letterbox warping through the TS bridge

**Budget:** 2–3 hours.

**Files:** create a retained shared Node OpenCV.js loader; delete the now-callerless `web/scripts/find-digit-blobs-server.ts`; modify `web/scripts/ts-bridge.ts`, `killer_sudoku/training/ts_bridge.py`, and their tests; reuse `warpRawDigitCrop` from Sprint 2.

- [x] 1. Add TS parity tests: for one non-square raw crop, `--op warp-crops` output for both strategies must exactly match direct production `warpRawDigitCrop` output.
- [x] 2. Add Python batching/error tests for:

```python
@dataclass(frozen=True)
class RawDigitCrop:
    pixels: npt.NDArray[np.uint8]  # shape is height,width


def warp_crops(crops, strategy: Literal['stretch', 'letterbox'], size: int = 64) -> NDArray[np.uint8]: ...
```

- [x] 3. Confirm `find-digit-blobs-server.ts` lost its only caller when `extract_guardian_samples.py` was deleted. Move only its proven Node OpenCV.js loading mechanism into the new retained loader, then delete the obsolete server and its request protocol. Do not refactor or preserve the doomed diagnostic path.
- [x] 4. Implement batched `warp-crops`; validate positive dimensions, pixel lengths, strategy, and exact square output.
- [x] 5. Python raises on bridge failure and has no local fallback.
- [x] 6. Keep existing `predict`/`solve` operations temporarily; their callers are removed, but narrowing is isolated in Sprint 14.
- [x] 7. Run TS/Python bridge tests and bronze.
- [x] 8. Commit: `feat: expose production crop warping to training`.

**Done when:** Python can select stretch or letterbox but the executed warp is byte-for-byte the production TypeScript implementation.

---

## Sprint 13 — Make the trainer consume raw crops and choose a TS warp strategy

**Budget:** 2–3 hours.

**Files:** `web/train_recogniser.py`, tests, `web/browser_train.json` migration as necessary, export/override loaders, current training docs.

- [x] 1. Add CLI `--warp-strategy {stretch,letterbox}`; default to the currently deployed HOG strategy.
- [x] 2. Define discriminated training inputs:
   - **raw:** dimensions plus bounding-box pixels; eligible for either strategy and passed once through `warp_crops`;
   - **legacy canonical:** explicit `recognitionPixels` plus the strategy that produced them; eligible only when that strategy matches.
- [x] 3. Never infer that a 64×64 array is raw. Migrate version-1 committed browser samples to explicitly tagged canonical records if original raw crops cannot be reconstructed. New browser exports and reviewed overrides are raw.
- [x] 4. Load raw DB/export/override samples, call the selected TS warp exactly once, then perform dithering and TS feature extraction.
- [x] 5. Synthetic generation may create training-only raw glyph arrays, but it must call the same TS warp before features; it must not claim to reproduce browser bounding-box selection.
- [x] 6. Add tests for both strategies, mixed raw/legacy input, incompatible legacy exclusion, invalid dimensions, and hard bridge failures.
- [x] 7. Train to a temporary directory and validate the exact output with `validate-model.ts` using canonical audit samples.
- [x] 8. Run focused tests and bronze.
- [x] 9. Commit: `feat: train raw crops with selectable TS warping`.

**Done when:** changing the flag changes only the TS-derived warp, never cropping, and all raw corpus/review samples remain reusable.

---

## Sprint 14 — Narrow the bridge and fold deduplication into ingestion

**Budget:** 1–2 hours.

**Files:** `web/scripts/ts-bridge.ts`, `killer_sudoku/training/ts_bridge.py`, tests, `web/train_recogniser.py`; delete `web/dedupe_browser_train.py` and test.

1. Confirm `predict` and `solve` have no callers after the deletion sprints.
2. Delete those bridge operations, payload types, model-path arguments, and tests. Retain only `warp-crops` and `extract-features`.
3. Add ingestion deduplication after all sources are merged and before weighting/dithering. Key raw samples by label, kind, width, height, and bytes; key canonical legacy samples additionally by declared strategy. First occurrence wins; different labels are not merged.
4. Delete the standalone dedupe script/tests.
5. Verify `--op predict` and `--op solve` fail as unknown operations.
6. Run bridge/trainer tests and bronze.
7. Commit: `refactor: narrow bridge to production warp and features`.

**Done when:** the bridge exposes exactly the two production-math operations required by training.

---

## Sprint 15 — Reduce packaging and document the retained boundary

**Budget:** 2–3 hours.

**Files:** `pyproject.toml`, `uv.lock`, `.github/workflows/retrain.yml`, `docs/architecture.md`, `docs/image-pipeline.md`, `docs/python-scripts-inventory.md`, `docs/corpus-db.md`, `AGENTS.md`, `CLAUDE.md`, superseded plan notice.

1. Audit imports in the three human Python scripts, `ts_bridge.py`, and `_r2_*.py`.
2. Remove all `[project.scripts]`, obsolete OCR/solver dependencies, deleted package data, extras, and Ruff overrides. Add only directly imported retained dependencies. Regenerate `uv.lock`.
3. Keep GitHub Actions invocations limited to `web/train_recogniser.py` plus the three private R2 helpers.
4. Current docs must say:
   - TS owns image-to-spec, bounding boxes, both warp strategies, features, prediction, evaluation, and solving;
   - `cell_reads.source_pixels` is the raw variable-sized bounding-box crop from the warped grid;
   - `recognition_pixels` is the derived deployed 64×64 audit input;
   - Python owns training orchestration/augmentation/fitting/curation only;
   - only train, review, and apply-review are human Python entry points;
   - HOG/hole RBF is the sole shipped recogniser.
5. Add a “Superseded by” link to the 2026-07-26 plan; do not rewrite historical evidence.
6. Run editable-install/help checks, documentation greps, and bronze.
7. Commit: `chore: expose only recogniser training and CI Python`.

**Done when:** packaging, CI, AGENTS/CLAUDE guidance, and current architecture docs all describe the same retained surface.

---

## Sprint 16 — Final deletion audit and end-to-end verification

**Budget:** 1–2 hours.

1. Verify repository-owned executable Python files are exactly:

```text
web/train_recogniser.py
killer_sudoku/training/review_low_confidence.py
killer_sudoku/training/apply_review_corrections.py
scripts/_r2_list.py
scripts/_r2_download.py
scripts/_r2_delete.py
```

Agent hooks under `.claude/` and `.codex/` are tooling exceptions.
2. Verify no Python code contains production OCR/solver concepts such as `cv2`, `findContours`, `getPerspectiveTransform`, `warpPerspective`, deployed classifier voting, `PuzzleSpec`, or `ProcessingError`.
3. Verify the TS bridge accepts `warp-crops` and `extract-features`, and explicitly rejects `predict` and `solve`.
4. Train both `--warp-strategy letterbox` and a small smoke subset with `stretch` into temporary directories. Validate generated models with the TypeScript loader without overwriting `web/public`.
5. Run:

```bash
git diff --check
bash scripts/run-bronze-gate.sh
bash scripts/run-silver-gate.sh
```

6. Commit only genuine stale-reference fixes: `chore: complete Python production-boundary cleanup`. Do not create an empty commit.
7. Push the feature branch and open a pull request. Do not merge it to `master`.

**Done when:** the design success criteria are demonstrated by current code, executable-surface greps, two strategy smoke runs, and both gates.

---

## Final state checklist

- [ ] Every implementation sprint stayed within the three-hour agent budget and ended bronze-green.
- [ ] Split-recogniser startup work and assets are gone.
- [ ] `corpus.db` stores raw variable-sized digit bounding-box pixels/dimensions from the warped grid.
- [ ] Cropping remains fixed in TypeScript; training can vary only the TypeScript stretch/letterbox warp.
- [ ] Derived recognition pixels remain available separately for deployed-prediction audits.
- [ ] Review and overrides preserve raw crops without warping.
- [ ] Python evaluator/status and agreement architecture are gone.
- [ ] PCA, historical loaders/converters/checkpoints, Python image/solver packages, and obsolete OCR utilities are gone.
- [ ] TS bridge exposes only batched production warping and feature extraction.
- [ ] Python contains no production crop, warp, feature, inference, or solver reimplementation.
- [ ] Retrain CI evaluates candidate models through the production browser.
- [ ] Python entry points match the six-file whitelist above.
- [ ] Current docs, tests, packaging, and shipped HOG/RBF model agree.
- [ ] Bronze and silver gates pass.
