# Master-vs-Branch Digit Recogniser Comparison — Design

## Objective

Build a single digit recogniser (cage totals + classic givens) that is at least as
good as the recogniser currently deployed on `master`. Before any retraining or
architecture work, establish a reliable, repeatable comparison flow so we can
measure master's actual accuracy against the branch's current accuracy on the same
held-out data, and see where the two disagree.

This spec covers **Phase 1 only**: killer cage-total comparison, using the existing
guardian/observer bulk datasets as a held-out test set. Classic-digit comparison is
explicitly deferred (Phase 2) because no solver-gated ground truth exists yet for
`classic_guardian`/`classic_observer` — building that bootstrap is a separate
sub-project.

## Background

- Killer ground truth (`guardian_train_sq.json` / `observer_train_sq.json`, built by
  `extract_guardian_samples.py`) is **solver-gated**: cached `cage_totals` come from
  `killer_sudoku/training/evaluate.py:collect_status()`, which only trusts a puzzle's
  OCR output if the independent rule-based killer solver could actually solve the
  grid using it (`status.py`'s `TRAINING_STATUSES = {SOLVED, CHEAT}`). This makes it
  a meaningful test set, not circular.
- `origin/master`'s training recipe (`git show origin/master:web/train_recogniser.py`)
  only trains on `browser_train.json` + synthetic rendered fonts — it never saw the
  guardian/observer bulk data. So bulk accuracy is a genuine held-out comparison for
  master specifically.
- Master's `numberRecognition.ts` splits cleanly into two halves:
  - **Classifier inference** (lines 1–373 of `origin/master:web/src/image/numberRecognition.ts`):
    types (`HOGParams`, `LinearClassifier`, `RBFModel`, `RBFClassifier`, `Classifier`,
    `Recognition`, `NumRecogniser`), `hogExtract`, `classify`, `recognise`,
    `loadNumRecogniser`. Confirmed to have **zero runtime OpenCV dependency** — the
    file's only OpenCV import (`OpenCVModule`/`OpenCVMat`/`OpenCVMatVector` types) is
    never referenced in this range. Safe to copy verbatim into a frozen baseline file.
  - **Crop extraction** (lines 374–675): `contourIsNumber`, `contourHier`,
    `getNumContours`, `getWarpFromRect`, `splitNum`, `squarePadSrc`,
    `readClassicDigits` — all operate on real `cv.Mat`/`cv.MatVector` objects. This
    repo's test suite has no OpenCV.js-in-Node harness (`web/package.json` has no
    `opencv-js`/`techstark` dependency; existing tests only import OpenCV *types*),
    so this half cannot be run offline in Node as-is.
- The branch's own bulk-extraction pipeline (`web/extract_guardian_samples.py`) is a
  hand-written Python/`cv2` mirror of the TS `splitNum()` logic — there is precedent
  for mirroring cropping logic in Python rather than running the TS version.

## Design

### 1. Import master's classifier as a frozen baseline

- Create `web/src/image/_baselineMasterRecognition.ts`: verbatim copy of master's
  classifier-only code (the OpenCV-independent range described above), with the
  unused OpenCV type import dropped. Underscore-prefixed, matching the existing
  `_diag_*.test.ts` convention for non-shipped diagnostic files — not imported by
  `main.ts`, not part of the production bundle.
- Copy master's actual deployed model artifacts to `web/_baseline_master/num_recogniser.bin`
  and `web/_baseline_master/num_recogniser.json` (from `origin/master:web/public/`).
  Kept outside `web/public/` so they are never fetched by the live app or included in
  the Vite build.

### 2. Mirror master's crop geometry in Python

- Create `web/extract_guardian_samples_master.py`, a sibling to the existing
  `extract_guardian_samples.py`. Same cage-parsing and contour-finding logic, same
  already-fixed orthogonal bugs (`cage_totals` `[row][col]` indexing, aspect-preserving
  `pyrUp` upscale, trailing-flag-aware split), but the final crop step reverts to
  master's actual non-square `splitNum()` geometry (direct warp of the raw bounding
  rect, no `squarePadSrc()` centering step) so the crops fed to master's classifier
  match what master would have produced in-browser.
- Output format matches the branch's existing `*_train_sq.json` bulk files
  (`{digit, pixels}` samples) so both pipelines' outputs are interchangeable inputs
  to the same diagnostic test.

### 3. Diagnostic comparison test

- Create `web/src/image/_diag_master_vs_branch.test.ts` (non-shipped, same pattern as
  `_diag_bulk_accuracy.test.ts` — `describe`/`it` block that only logs, no assertions).
- Loads both recognisers: the branch's current model (`public/num_recogniser.bin`/`.json`)
  via the branch's `loadNumRecogniser`/`recognise`, and master's frozen baseline via
  `_baselineMasterRecognition.ts`.
- Primary comparison (apples-to-apples, what end users actually experienced/experience):
  - master-crops → master-model (master's true historical accuracy)
  - branch-crops → branch-model (branch's current accuracy, already measured: 99.69%
    guardian / 92.12% observer)
- Secondary, optional cross-combinations to isolate the source of any gap:
  - master-crops → branch-model
  - branch-crops → master-model
- Reports per-dataset accuracy and a list of mispredictions (sample index, expected,
  got, confidence) for both guardian and observer files, mirroring the existing
  `_diag_bulk_accuracy.test.ts` output format.

### Out of scope (Phase 2, separate future sub-project)

- Building classic ground truth (OCR + solver-gate bootstrap for
  `classic_guardian`/`classic_observer`) so a classic comparison can run.
- Fixing the `.github/workflows/retrain.yml` merge script's dropping of
  `puzzleType`/`splitSamples` on every cycle (confirmed defect, not a blocker here).
- Retraining a unified recogniser — that only happens after this comparison tells us
  where the branch and master actually differ and who is right.

## Testing

The diagnostic test is the deliverable for this phase — it has no assertions (matching
the existing `_diag_bulk_accuracy.test.ts` pattern) because its purpose is to produce
comparison numbers for human judgement, not to gate CI. It will be deleted once its
diagnostic purpose is served, same lifecycle as `_diag_bulk_accuracy.test.ts`.

## Risks / Open Questions

- Master's crop geometry mirror is hand-written Python, not the real TS code, so it
  is itself an approximation — same caveat that already applies to the branch's
  existing `extract_guardian_samples.py`. If master's measured accuracy looks
  surprisingly low, the cross-combination tests (master-crops→branch-model etc.) will
  help distinguish "master's classifier is worse" from "this Python mirror of
  master's cropping is imperfect."
