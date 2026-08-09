# Greyscale Digit Recogniser Retraining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, review, train, validate, and integrate a digit recogniser whose input is the greyscale crop from the warped grid while leaving binary-image segmentation unchanged.

**Architecture:** The completed `cell_reads` population supplies labels, bounding boxes, and greyscale pixels. TypeScript owns the single production greyscale preparation operation and exposes it through the existing private `warp-crops` bridge. The existing corpus exporter continues to apply corrections, form four clusters per digit, sample across them, and emit schema-v2 `corpus_train.json`; the existing PCA trainer continues to deduplicate, centre, fit, and export the model. Binary segmentation remains unchanged.

**Tech Stack:** TypeScript, OpenCV.js, Vitest, Node/tsx bridge, Python 3, sqlite3, NumPy, Pillow, scikit-learn, Ruff, mypy, Playwright.

## Global Constraints

- Use only evaluation identity `full-corpus-b708d8b`, produced from master commit `b708d8be538d816c37c9a42e3dc5b4a9f59e5bbe`; never mix older evaluation identities into any dataset, report, or comparison.
- Treat `corpus.db` as read-only; corrections and exclusions live in versioned sidecar JSON.
- Use only cleanly solved puzzles with `spec_error IS NULL` for provisional labels.
- Include both `given_digit` and `cage_total_digit` rows, retaining `digit_index` for multi-digit totals.
- Keep all image-to-image and image-to-feature production logic in TypeScript; Python may call only the existing private bridge operations.
- The first experiment uses real corpus crops only: no synthetic fonts, no translation jitter, and no binary erosion/dilation augmentation.
- Produce exactly four review clusters per digit and require visual review before freezing labels.
- Preserve binary-image segmentation and bounding-box selection while changing only the recogniser input pixels.
- Use row-major grid coordinates and row-first `(row, col)` parameters.

---

### Task 1: Exact-hash corpus audit and greyscale row loading

**Files:**
- Create: `tests/test_export_corpus_training_data.py`
- Modify: `scripts/_export_corpus_training_data.py`
- Modify: `docs/corpus-db.md`

**Interfaces:**
- Produces: `CorpusAudit`, `DigitRow`, `audit_corpus(conn, evaluation_id) -> CorpusAudit`, and `fetch_eligible_rows(conn, evaluation_id) -> list[DigitRow]`.
- Consumes: SQLite tables `puzzles`, `evaluations`, and `cell_reads` as documented in `docs/corpus-db.md`.

- [x] **Step 1: Write failing audit tests against a temporary SQLite database**

```python
def test_audit_requires_one_completed_evaluation_per_registered_puzzle(tmp_path: Path) -> None:
    conn = make_corpus_db(tmp_path, statuses=[("p1", "done"), ("p2", "running")])
    with pytest.raises(ValueError, match="1 unfinished"):
        export.audit_corpus(conn, "full-corpus-b708d8b")


def test_audit_rejects_a_different_evaluation_identity(tmp_path: Path) -> None:
    conn = make_complete_corpus_db(tmp_path, evaluation_id="older-run")
    with pytest.raises(ValueError, match="full-corpus-b708d8b"):
        export.audit_corpus(conn, "older-run")
```

- [x] **Step 2: Run the focused tests and verify the missing interfaces fail**

Run: `.venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py -v`

Expected: FAIL because `CorpusAudit` and `audit_corpus` do not exist.

- [x] **Step 3: Add typed audit and row records plus strict validation**

```python
SOURCE_EVALUATION_ID = "full-corpus-b708d8b"

@dataclass(frozen=True)
class CorpusAudit:
    registered_puzzles: int
    terminal_evaluations: int
    distinct_puzzles: int
    digit_rows: int


@dataclass(frozen=True)
class DigitRow:
    puzzle_hash: str
    cell_type: Literal["given_digit", "cage_total_digit"]
    row: int
    col: int
    digit_index: int
    provisional_label: int
    width: int
    height: int
    gray_pixels: NDArray[np.uint8]
```

Implement `audit_corpus` so it rejects a non-matching identity, missing puzzles, duplicate puzzle rows, non-terminal rows, missing corners, and missing/malformed greyscale evidence before producing output. Implement `fetch_eligible_rows` with an explicit `WHERE e.git_hash = ? AND e.status = 'done' AND e.bucket = 'clean' AND e.spec_error IS NULL` join and validate every byte count and label.

- [x] **Step 4: Test the eligible-row filters and malformed evidence cases**

Add tests proving backtracked/not-solved rows, rows from another hash, unsupported cell types, invalid labels, and malformed greyscale lengths are rejected or excluded exactly as specified.

Run: `.venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py -v`

Expected: PASS.

- [x] **Step 5: Update the corpus documentation**

Document `evaluations.grid_corners` and `cell_reads.gray_pixels`, including the corner order and the guarantee that `gray_pixels` uses the same bounding box and dimensions as `source_pixels`.

- [x] **Step 6: Run Python checks and commit**

Run: `.venv/Scripts/python -m ruff check . && .venv/Scripts/python -m mypy . --ignore-missing-imports && .venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py -v`

Commit: `feat: audit greyscale corpus training source`

---

### Task 2: One TypeScript-owned greyscale recognition input

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Modify: `web/src/image/numberRecognition.crop.test.ts`
- Modify: `web/scripts/ts-bridge.ts`
- Modify: `web/scripts/ts-bridge.test.ts`
- Modify: `killer_sudoku/training/ts_bridge.py`
- Modify: `tests/test_ts_bridge.py`

**Interfaces:**
- Produces: `RecognitionInputMode = 'binary' | 'gray'` and `prepareRecognitionCrop(cv, crop, strategy, inputMode, targetSize) -> Uint8Array`.
- Extends: bridge `warp-crops` request with optional `inputMode`; no new bridge operation is permitted.
- Python wrapper: `warp_crops(crops, strategy, size, input_mode="binary") -> NDArray[np.uint8]`.

- [x] **Step 7: Simplify to one greyscale mode and address review findings with TDD**

Replace the three experimental modes with one contrast-normalised/inverted `gray` mode. Add failing tests proving 64×64 output, foreground-based centring on an off-white background, manifest loading (`binary` default for legacy manifests, valid `gray`, invalid values rejected), bridge rejection of explicit `null`, and Windows bridge command construction. Then implement only enough to pass them, including `try/finally` cleanup in the shared warp helper.

Run the focused TypeScript and Python bridge tests, then the bronze gate.

Commit: `refactor: pare greyscale recognition input to one mode`

---

### Task 3: Reuse the corpus exporter for greyscale crops and cluster review

**Files:**
- Modify: `scripts/_export_corpus_training_data.py`
- Modify: `tests/test_export_corpus_training_data.py`
- Reuse: `killer_sudoku/training/digit_corrections.json`

**Interfaces:**
- Keeps the current schema-v2 `web/corpus_train.json` contract and existing correction format.
- Changes the existing exporter to warp `gray_pixels` with `input_mode='gray'`.
- Reuses `cluster_ids_for`, `stratified_sample`, `N_CLUSTERS = 4`, and the 400-samples-per-digit default.

- [x] **Step 1:** Add failing tests proving the exporter uses greyscale pixels, requests `gray` preprocessing, retains four clusters, applies the existing corrections, and emits the unchanged schema-v2 format.
- [x] **Step 2:** Make the minimal exporter changes.
- [x] **Step 3:** Add a small contact sheet containing the existing 40 cluster means (ten digits × four clusters); do not build a new review application or correction schema.
- [x] **Step 4:** Run the exporter against `full-corpus-b708d8b`, inspect the contact sheet with the user, and regenerate only if corrections change.
- [x] **Step 5:** Run focused tests and the bronze gate.

Commit: `feat: export greyscale corpus training crops`

---

### Task 4: Retrain with the existing centred PCA trainer

**Files:**
- Reuse: `web/train_recogniser.py`
- Generated: candidate model outside `web/public/`

- [ ] **Step 1:** Verify with focused tests that PCA training disables translation jitter; retain the existing behaviour rather than adding a new policy layer.
- [ ] **Step 2:** Train from `web/corpus_train.json` with `--recogniser pca --warp-strategy letterbox-centered --no-synthetic --dither 0`, using the existing deduplication and fitting path.
- [ ] **Step 3:** Record the exact command, sample counts, correction hash, source evaluation, and model metrics alongside the candidate. Add only the minimal manifest `recognition_input_mode: 'gray'` field required by the browser contract.
- [ ] **Step 4:** Run focused trainer/model-validation tests and the bronze gate.

Commit: `feat: train centred greyscale digit recogniser`

---

### Task 5: Switch production recognition to same-box greyscale crops

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Modify: `web/src/image/numberRecognition.crop.test.ts`
- Modify: `web/src/image/inpImage.ts`
- Modify: `web/src/image/inpImage.test.ts`
- Modify: `web/public/number-recogniser-manifest.json`
- Modify: model binary files named by the manifest
- Modify: `docs/image-pipeline.md`

**Interfaces:**
- `readClassicDigits(cv, warpedBlk, warpedGray, ...)` and `splitNum(cv, br, warpedBlk, warpedGray, ...)` use binary pixels only to locate rectangles and greyscale pixels from the identical rectangle for `NumRecogniser.warpForRecognition`.
- `NumRecogniser.inputMode` is loaded from manifest `recognition_input_mode` and must agree with the bundled model.

- [ ] **Step 1: Write failing same-rectangle tests**

```typescript
it('segments on binary pixels but recognises the identical rectangle from gray', () => {
  const result = readClassicDigits(cv, binaryGrid, grayGrid, recogniser, geometry);
  expect(result.sourceCrops[0]).toEqual(expectedBinaryRect);
  expect(result.recognitionSourceCrops[0]).toEqual(expectedGrayPixelsFromSameRect);
  expect(recogniser.seenInputMode).toBe('gray-normalized');
});
```

Add the equivalent cage-total test, including both `digit_index` values of a two-digit total.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd web && npm test -- --run src/image/numberRecognition.crop.test.ts src/image/inpImage.test.ts`

Expected: FAIL because recognition still consumes the binary crop.

- [ ] **Step 3: Thread warped greyscale images through both recognition paths**

Use the binary contour/profile logic unchanged. Once each final bounding rectangle is known, extract `RawDigitCrop` from `warpedGray` for recognition and retain the binary crop only as segmentation evidence. Delete every temporary OpenCV matrix in the owning scope.

- [ ] **Step 4: Install the selected model and enforce its manifest contract**

Copy only the Task 5 winner into `web/public/`. Load `recognition_input_mode`; fail clearly on unsupported modes instead of silently defaulting, while retaining binary default only for explicitly legacy test manifests.

- [ ] **Step 5: Update pipeline documentation and run image tests**

Document that segmentation remains binary while inference uses the same bounding rectangle from the warped greyscale image.

Run: `cd web && npm test -- --run src/image/numberRecognition.crop.test.ts src/image/inpImage.test.ts src/image/numberRecognition.test.ts scripts/validate-model.test.ts`

Expected: PASS, including model/data contract tests.

- [ ] **Step 6: Run the bronze gate and commit**

Run: `bash scripts/run-bronze-gate.sh`

Commit: `feat: recognise digits from warped greyscale crops`

---

### Task 6: Full-corpus comparison and deployment decision

**Files:**
- Create: `docs/superpowers/reports/2026-08-09-greyscale-digit-recogniser-results.md`
- Modify if fixes are required: files identified by failing focused tests, with a new red-green cycle per fix

**Interfaces:**
- Baseline source: completed evaluation `full-corpus-b708d8b` only.
- Candidate source: one new full-corpus evaluation identity containing the integrated commit hash.
- Produces: puzzle-level comparison and explicit accept/reject decision.

- [ ] **Step 1: Run the silver gate before the expensive evaluation**

Run: `bash scripts/run-silver-gate.sh`

Expected: TypeScript, Vitest, production Playwright, development Playwright, Python lint, and mypy all pass.

- [ ] **Step 2: Run one complete candidate evaluation**

Use the repository's corpus evaluator with a new evaluation identity tied to the exact candidate commit. Do not overwrite or append to `full-corpus-b708d8b`.

- [ ] **Step 3: Verify candidate completeness before comparison**

Require 3,001 terminal evaluations for 3,001 distinct registered puzzles, zero running rows, zero duplicate puzzle rows, and complete recognition evidence. Abort the report if the audit fails.

- [ ] **Step 4: Write the comparison report**

Include clean/backtracked/not-solved/timeout/failure totals, puzzle-level fixes and regressions, digit and cell-type error breakdowns, segmentation-versus-recognition attribution, timing distribution, model size, and browser inference cost. Every baseline query must contain `git_hash = 'full-corpus-b708d8b'`.

- [ ] **Step 5: Make and record the deployment decision**

Accept only if the agreed recognition and end-to-end criteria pass without material segmentation regression. Otherwise keep the binary production model and retain the greyscale candidate/report for the next experiment.

- [ ] **Step 6: Commit the final report and any accepted model artifacts**

Run the appropriate focused tests plus `bash scripts/run-bronze-gate.sh` after any corrective edit.

Commit: `docs: report greyscale recogniser evaluation`

---

## Review Checkpoints

1. Review Task 3's 40 cluster means before exporting the final training set.
2. Review Task 4's retraining counts and metrics before installing the candidate model.
3. Review Task 6's full-corpus comparison before deploying or merging.
