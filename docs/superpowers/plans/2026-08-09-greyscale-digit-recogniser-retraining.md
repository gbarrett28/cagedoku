# Greyscale Digit Recogniser Retraining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, review, train, validate, and integrate a digit recogniser whose input is the greyscale crop from the warped grid while leaving binary-image segmentation unchanged.

**Architecture:** The completed `cell_reads` population supplies labels, bounding boxes, and greyscale pixels. TypeScript owns every production image transformation and exposes greyscale preparation through the existing private `warp-crops` bridge; Python performs completeness auditing, clustering, human-review orchestration, dataset splitting, augmentation policy, and sklearn fitting. The browser switch is made only after cluster review and puzzle-level offline validation pass.

**Tech Stack:** TypeScript, OpenCV.js, Vitest, Node/tsx bridge, Python 3, sqlite3, NumPy, Pillow, scikit-learn, Ruff, mypy, Playwright.

## Global Constraints

- Use only evaluation identity `full-corpus-b708d8b`, produced from master commit `b708d8be538d816c37c9a42e3dc5b4a9f59e5bbe`; never mix older evaluation identities into any dataset, report, or comparison.
- Treat `corpus.db` as read-only; corrections and exclusions live in versioned sidecar JSON.
- Use only cleanly solved puzzles with `spec_error IS NULL` for provisional labels.
- Include both `given_digit` and `cage_total_digit` rows, retaining `digit_index` for multi-digit totals.
- Keep all image-to-image and image-to-feature production logic in TypeScript; Python may call only the existing private bridge operations.
- The first experiment uses real corpus crops only: no synthetic fonts, no translation jitter, and no binary erosion/dilation augmentation.
- Split train, validation, and test sets by `puzzle_hash`, never by individual crop.
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

- [ ] **Step 1: Write failing audit tests against a temporary SQLite database**

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

- [ ] **Step 2: Run the focused tests and verify the missing interfaces fail**

Run: `.venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py -v`

Expected: FAIL because `CorpusAudit` and `audit_corpus` do not exist.

- [ ] **Step 3: Add typed audit and row records plus strict validation**

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

- [ ] **Step 4: Test the eligible-row filters and malformed evidence cases**

Add tests proving backtracked/not-solved rows, rows from another hash, unsupported cell types, invalid labels, and malformed greyscale lengths are rejected or excluded exactly as specified.

Run: `.venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py -v`

Expected: PASS.

- [ ] **Step 5: Update the corpus documentation**

Document `evaluations.grid_corners` and `cell_reads.gray_pixels`, including the corner order and the guarantee that `gray_pixels` uses the same bounding box and dimensions as `source_pixels`.

- [ ] **Step 6: Run Python checks and commit**

Run: `.venv/Scripts/python -m ruff check . && .venv/Scripts/python -m mypy . --ignore-missing-imports && .venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py -v`

Commit: `feat: audit greyscale corpus training source`

---

### Task 2: TypeScript-owned greyscale recognition preprocessing

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Modify: `web/src/image/numberRecognition.crop.test.ts`
- Modify: `web/scripts/ts-bridge.ts`
- Modify: `web/scripts/ts-bridge.test.ts`
- Modify: `killer_sudoku/training/ts_bridge.py`
- Modify: `tests/test_ts_bridge.py`

**Interfaces:**
- Produces: `RecognitionInputMode = 'binary' | 'gray-inverted-contrast' | 'gray-adaptive' | 'gray-normalized'` and `prepareRecognitionCrop(cv, crop, strategy, inputMode, targetSize) -> Uint8Array`.
- Extends: bridge `warp-crops` request with optional `inputMode`; no new bridge operation is permitted.
- Python wrapper: `warp_crops(crops, strategy, size, input_mode="binary") -> NDArray[np.uint8]`.

- [ ] **Step 1: Add failing TypeScript tests for the three greyscale candidates**

```typescript
it.each([
  'gray-inverted-contrast',
  'gray-adaptive',
  'gray-normalized',
] as const)('prepares deterministic %s crops at 64x64', inputMode => {
  const first = prepareRecognitionCrop(cv, GRAY_CROP, 'letterbox-centered', inputMode, 64);
  const second = prepareRecognitionCrop(cv, GRAY_CROP, 'letterbox-centered', inputMode, 64);
  expect(first).toHaveLength(4096);
  expect(first).toEqual(second);
});
```

Also assert that `inputMode: 'binary'` is byte-for-byte identical to the current `warpRawDigitCrop` result.

- [ ] **Step 2: Run the focused TypeScript tests and verify failure**

Run: `cd web && npm test -- --run src/image/numberRecognition.crop.test.ts scripts/ts-bridge.test.ts`

Expected: FAIL because `RecognitionInputMode` and `prepareRecognitionCrop` do not exist.

- [ ] **Step 3: Implement the minimal TypeScript preprocessing functions**

Add small, separately testable helpers for contrast inversion/normalisation and reuse `letterboxWarp` plus `centerByCentroid`. Keep OpenCV allocations inside `try/finally` blocks. `NumRecogniser.warpForRecognition` must call `prepareRecognitionCrop` using a readonly `inputMode` property, defaulting to `binary` for old manifests.

- [ ] **Step 4: Extend the existing bridge request and Python wrapper**

```typescript
interface WarpCropsRequest {
  op: 'warp-crops';
  strategy: WarpStrategy;
  inputMode?: RecognitionInputMode;
  size: number;
  crops: SerializedRawDigitCrop[];
}
```

Validate the enum at the bridge boundary and default omitted values to `binary`. Update the Python dataclass/request construction without implementing image transforms in Python.

- [ ] **Step 5: Run bridge parity and diagnostics**

Run: `cd web && npm test -- --run src/image/numberRecognition.crop.test.ts scripts/ts-bridge.test.ts`

Run: `.venv/Scripts/python -m pytest tests/test_ts_bridge.py -v`

Expected: PASS, including legacy binary parity.

- [ ] **Step 6: Commit**

Commit: `feat: add greyscale recognition preprocessing`

---

### Task 3: Four-cluster label-review artifact and durable corrections

**Files:**
- Modify: `scripts/_export_corpus_training_data.py`
- Modify: `tests/test_export_corpus_training_data.py`
- Modify: `killer_sudoku/training/apply_review_corrections.py`
- Modify: `tests/test_apply_review_corrections.py`
- Create when generated: `killer_sudoku/training/greyscale_digit_corrections.json`

**Interfaces:**
- Produces: `SampleKey`, `ClusterSummary`, `cluster_digit_rows(rows, input_mode, seed) -> dict[int, list[ClusterSummary]]`, `render_cluster_review(...) -> str`, and schema-versioned correction JSON.
- Correction key: `(puzzle_hash, evaluation_id, cell_type, row, col, digit_index)`.
- Consumes: `DigitRow` from Task 1 and `ts_bridge.warp_crops(..., input_mode=...)` from Task 2.

- [ ] **Step 1: Write failing tests for stable keys and four clusters**

```python
def test_cluster_review_has_four_clusters_for_every_digit() -> None:
    summaries = export.cluster_digit_rows(BALANCED_ROWS, "gray-normalized", seed=0)
    assert set(summaries) == set(range(10))
    assert all(len(clusters) == 4 for clusters in summaries.values())


def test_sample_key_includes_evaluation_and_digit_index() -> None:
    assert export.sample_key(ROW) == (
        ROW.puzzle_hash, "full-corpus-b708d8b", ROW.cell_type,
        ROW.row, ROW.col, ROW.digit_index,
    )
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `.venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py tests/test_apply_review_corrections.py -v`

Expected: FAIL on the missing cluster-review interfaces.

- [ ] **Step 3: Implement deterministic clustering and review rendering**

For each provisional digit, transform greyscale crops using the selected TypeScript input mode, extract production features through the bridge, reduce with seeded PCA, and fit `GaussianMixture(n_components=4, random_state=0, n_init=5)`. Render each cluster mean, nearest representatives, farthest outliers, given/cage composition, corpus composition, and full sample identifiers into a self-contained HTML review sheet plus `candidates.json`.

- [ ] **Step 4: Extend correction application with provenance validation**

Reject corrections whose evaluation identity is not `full-corpus-b708d8b`, whose prior label differs from the candidate, or whose sample key is absent. Store either `{ "label": 0..9, "reason": "mislabel" }` or `{ "exclude": true, "reason": nonempty-string }`; never update SQLite.

- [ ] **Step 5: Test deterministic output and invalid correction cases**

Run: `.venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py tests/test_apply_review_corrections.py -v`

Expected: PASS and identical assignments/artifact ordering for repeated seed-zero runs.

- [ ] **Step 6: Commit the tooling, not generated review output**

Commit: `feat: generate greyscale digit cluster review`

---

### Task 4: Freeze a provenance-rich, puzzle-split training dataset

**Files:**
- Modify: `scripts/_export_corpus_training_data.py`
- Modify: `tests/test_export_corpus_training_data.py`
- Modify: `web/train_recogniser.py`
- Modify: `tests/test_train_recogniser.py`

**Interfaces:**
- Produces canonical schema version 3 with per-sample `puzzleHash`, `sampleKey`, `digit`, `recognitionPixels`, `inputMode`, and `split`.
- Produces manifest fields `sourceEvaluation`, `sourceCommit`, `audit`, `selectionSeed`, `splitSeed`, `correctionsSha256`, `inputMode`, and per-digit/per-cell-type/per-split counts.
- Consumes only reviewed Task 3 corrections and exclusions.

- [ ] **Step 1: Write failing tests for deduplication and puzzle-level splitting**

```python
def test_split_never_places_one_puzzle_in_multiple_partitions() -> None:
    frozen = export.freeze_dataset(REVIEWED_ROWS, split_seed=0)
    by_puzzle: dict[str, set[str]] = defaultdict(set)
    for sample in frozen.samples:
        by_puzzle[sample.puzzle_hash].add(sample.split)
    assert all(len(splits) == 1 for splits in by_puzzle.values())


def test_freeze_deduplicates_identical_pixels_within_label() -> None:
    frozen = export.freeze_dataset([ROW_A, replace(ROW_A, puzzle_hash="other")], split_seed=0)
    assert len(frozen.samples) == 1
```

- [ ] **Step 2: Run the exporter and trainer loader tests and verify failure**

Run: `.venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py tests/test_train_recogniser.py -v`

Expected: FAIL because schema version 3 provenance and splits are unsupported.

- [ ] **Step 3: Implement deterministic correction, exclusion, deduplication, and split order**

Apply corrections first, exclude reviewed garbage second, deduplicate by `(final_label, sha256(recognition_pixels))`, then assign puzzles deterministically to train/validation/test with stratification diagnostics. Fail if any digit is absent from a split or if one puzzle crosses splits.

- [ ] **Step 4: Teach the trainer to load schema version 3 without discarding provenance**

Extend `TrainingSample` with `puzzle_hash`, `input_mode`, and `split`. Reject mixed input modes, mixed source evaluations, missing provenance, and any source evaluation other than `full-corpus-b708d8b` for this experiment.

- [ ] **Step 5: Run focused tests and commit**

Run: `.venv/Scripts/python -m pytest tests/test_export_corpus_training_data.py tests/test_train_recogniser.py -v`

Expected: PASS.

Commit: `feat: freeze puzzle-split greyscale training data`

---

### Task 5: Train and compare real-crop-only candidates without jitter

**Files:**
- Modify: `web/train_recogniser.py`
- Modify: `tests/test_train_recogniser.py`
- Modify: `web/scripts/validate-model.ts`
- Modify: `web/scripts/validate-model.test.ts`
- Generated, review before staging: model candidate directory outside `web/public/`

**Interfaces:**
- Produces: trainer flags `--respect-splits` and manifest fields `recognition_input_mode`, `augmentation.translate=false`, `augmentation.synthetic=false`, and split metrics.
- Consumes: schema-version-3 frozen dataset from Task 4.

- [ ] **Step 1: Write failing trainer-policy tests**

```python
def test_greyscale_experiment_disables_translation_and_synthetic_data() -> None:
    policy = trainer.training_policy(input_mode="gray-normalized", dither=0, no_synthetic=True)
    assert policy.translate is False
    assert policy.synthetic is False
    assert policy.binary_morphology is False
```

Add a test that training rejects `dither > 0` for the initial greyscale experiment unless a later explicit augmentation mode is introduced.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `.venv/Scripts/python -m pytest tests/test_train_recogniser.py -v`

Expected: FAIL because the explicit greyscale policy and split-aware metrics are absent.

- [ ] **Step 3: Implement split-aware fitting and reporting**

Fit on `split == "train"` only. Select preprocessing/model parameters using validation puzzles only. Report final untouched test accuracy, confusion matrix, per-digit accuracy, given-versus-cage accuracy, confidence calibration, and puzzle-level error counts. Do not merge validation/test crops into the fit.

- [ ] **Step 4: Add manifest validation for the input contract**

Extend `validate-model.ts` to reject absent/unknown `recognition_input_mode`, greyscale models claiming binary augmentation, and model/data input-mode mismatches.

- [ ] **Step 5: Run the three preprocessing candidates**

For each of `gray-inverted-contrast`, `gray-adaptive`, and `gray-normalized`, generate a frozen dataset after cluster review and run:

```bash
.venv/Scripts/python web/train_recogniser.py \
  --browser-file artifacts/greyscale-recogniser/gray-normalized/dataset.json \
  --no-overrides-file --no-synthetic --dither 0 --respect-splits \
  --out artifacts/greyscale-recogniser/gray-normalized/model
```

Choose a candidate using validation results; report the untouched test result exactly once after selection. Do not copy any candidate into `web/public/` yet.

- [ ] **Step 6: Run focused checks and commit tooling**

Run: `.venv/Scripts/python -m pytest tests/test_train_recogniser.py -v`

Run: `cd web && npm test -- --run scripts/validate-model.test.ts`

Commit: `feat: train split-aware greyscale recogniser candidates`

---

### Task 6: Switch production recognition to same-box greyscale crops

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

### Task 7: Full-corpus comparison and deployment decision

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

1. Review Task 3 cluster means, representatives, and outliers before applying corrections.
2. Review post-correction clusters before freezing Task 4 data.
3. Review Task 5 validation comparison before revealing the selected candidate's test result.
4. Review the Task 7 full-corpus comparison before deploying or merging.
