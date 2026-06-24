# Contour-Based Digit Extraction + browser_train.json Dedup — Design

**Status:** Approved by user 2026-06-24. Ready for implementation planning.

## Background

The Sprint 2 retrain (`docs/superpowers/plans/2026-06-23-letterbox-crop-fix-sprint-2-retrain-verify.md`)
fixed a corrupted-sample bug in `web/extract_guardian_samples.py` by wiring the existing
`is_num_contour` shape gate into `extract_puzzle_samples`. That produced a large accuracy
win (guardian 99.76%, observer 95.13%, vs. 99.69%/92.12% baseline) but only *rejects* bad
crops after the fact — it doesn't fix why they were bad.

Investigating further surfaced the actual root cause: `extract_guardian_samples.py` re-implements
its own ROI/ink-projection heuristic (`digit_content_extent`, `split_bounding_rect`) to find
digit boundaries, instead of using real connected-component contour detection the way the
production TypeScript pipeline already does (`web/src/image/inpImage.ts`'s `buildCageTotals` →
`cv.findContours` → `contourHier`/`getNumContours`/`contourIsNumber`). The ink-projection
heuristic can mistake a cage-border line bleeding into the ROI's margin for real digit content,
truncating the crop before the actual glyph. Real contour detection doesn't have this failure
mode: a border line is normally a separate connected component (filtered out by the existing
size gate) rather than something a column-ink scan can be fooled by.

Separately, `browser_train.json` (real browser-exported samples, fed into training with
`--browser-weight 1000`) contains a small number of exact byte-identical duplicate crops of a
few hard "7" glyphs sitting near the SVM's fragile 1-vs-7 boundary. Because of the heavy
browser-weight, each duplicate copy multiplies that sample's pull on the trained boundary.

This spec covers fixing both, as two sprints.

## Part 1 — Contour-based extraction (Sprint 3)

### Goal

Replace the ROI-heuristic digit-boundary logic in `extract_puzzle_samples` with real
connected-component contour detection, mirroring production's approach, eliminating the
boundary-bleed failure mode at the root instead of catching its symptom.

### New function: `find_digit_blobs`

```python
def find_digit_blobs(roi: NDArray[np.uint8], subres: int) -> list[tuple[int, int, int, int]]:
    """Find digit-sized ink blobs in a cell ROI via connected-component contours.

    Mirrors web/src/image/numberRecognition.ts's contourIsNumber size filter, but
    uses RETR_EXTERNAL (not RETR_TREE) since the caller has already scoped `roi`
    to the cage-total's top-left quadrant -- the recursive hole-walk production
    needs to disambiguate cage-totals from centred solution digits across the
    whole board has no equivalent ambiguity here.
    """
```

Implementation: `cv2.findContours(roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)`,
bounding-rect each contour, keep those passing `is_num_contour(w, h, subres)`, return
sorted left-to-right by x.

### Changes to `extract_puzzle_samples`

Per cell with `total > 0`:

1. Crop `roi` exactly as today (unchanged ROI geometry).
2. `blobs = find_digit_blobs(roi, pipe_cell)`.
3. **`len(blobs) == ndigits`** — direct 1:1 left-to-right assignment to `total_str`'s
   digits. No split heuristic involved at all; this is the common case for both
   1-digit and (already-separated) 2-digit totals.
4. **`ndigits == 2 and len(blobs) == 1`** — genuine touching-digit fallback: split that
   single blob's own bounding rect via ink-projection-minimum (today's
   `split_bounding_rect` math, scoped to just the blob's rect rather than the full ROI
   window). Each resulting half is still gated by `is_num_contour` before being accepted
   — the existing safety net stays in place for this one remaining heuristic path.
5. **Anything else** (0 blobs, or a blob count that doesn't fit either case above) — log
   and skip, consistent with the existing noise-skip pattern (`len(ys) < 10`) and with
   `trainingExport.ts`'s digit-count mismatch warning in the production code.

### Removed

- `digit_content_extent` — deleted entirely. Its job (excluding trailing "flag" decoration
  and avoiding border-line bleed) is now handled implicitly: both are normally separate,
  thin connected components that fail the existing `is_num_contour` size gate on their own
  contour, with no need for a bespoke ink-scan to dodge them.
- `split_bounding_rect`'s ROI-window framing — kept as logic, but re-scoped to operate on a
  single merged blob's bounding rect (case 4 above) rather than a synthetic full-ROI window.

### Testing (TDD, written before the implementation change)

- Unit tests for `find_digit_blobs` on synthetic binary images: single digit-sized blob
  found; trailing thin decoration line correctly excluded; border-bleed-shaped blob
  correctly excluded; two separate digit blobs both found and ordered left-to-right.
- Keep the existing `is_num_contour` tests (still used by the merged-blob fallback path).
- Existing regression tests `test_is_num_contour_rejects_degenerate_split_sliver` /
  `_rejects_merged_two_digit_glyph` continue to document the original failure case, now
  via the new code path producing it.

### Verification

Regenerate guardian/observer bulk data, retrain with the established recipe
(`--browser-weight 1000 --svm-c 100 --max-per-class 1500 --no-synthetic --dither 18`),
confirm guardian/observer accuracy is at or above tonight's result (99.76%/95.13%) and
nowhere below baseline (99.69%/92.12%). If it regresses, root-cause via
`superpowers:systematic-debugging` before proceeding — do not silently accept a regression.

## Part 2 — browser_train.json dedup + floor re-baseline (Sprint 4)

### Goal

Remove exact-duplicate browser-exported samples (which are over-counted under
`--browser-weight 1000`), and re-baseline `numberRecognition.test.ts`'s regression floor
using content-identity tracking instead of index/percentage, so the test continues to mean
something precise after the underlying sample set changes.

### Procedure

1. Using the Part-1-retrained model, run inference on the **pre-dedup** `browser_train.json`.
   For every failing sample, compute `sha256(bytes(pixels))` and collect the set
   `preDedupFailureHashes`.
2. Dedup `browser_train.json`: drop exact pixel-duplicate samples, keeping first occurrence.
   Record old/new sample counts.
3. Retrain on the deduped file (same recipe as Part 1's verification).
4. Run the new model on the **deduped** `browser_train.json`, collect
   `postDedupFailureHashes`.
5. **Gate:** `postDedupFailureHashes ⊆ preDedupFailureHashes`. Any hash that fails post-dedup
   but wasn't already in the pre-dedup failure set indicates a new, unrelated regression —
   stop and root-cause via `superpowers:systematic-debugging`, do not proceed past this gate
   on a hand-wave. A same-size or smaller post-dedup set is the expected, accepted outcome.
6. New floor = `deduped_total - |postDedupFailureHashes|`.

### Test changes (`web/src/image/numberRecognition.test.ts`)

Replace the index-based `KNOWN_PERMANENT_FAILURES: number` /
`KNOWN_FAILURES_BY_DIGIT: ReadonlyMap<number, number>` with:

```ts
const KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string> = new Set([
  'sha256hex...', // digit 7 -> 1, <short description of confusion>
  // ...
]);
```

computed via Node's `crypto.createHash('sha256')` over each sample's pixel array. The test
asserts:

- Every failing sample's hash is a member of `KNOWN_FAILURE_SAMPLE_HASHES` (no unexpected
  new failures — fails loudly if one appears).
- `correct >= total - KNOWN_FAILURE_SAMPLE_HASHES.size` (the floor, expressed via known-failure
  count rather than a hardcoded total, so it stays correct even if the fixture's sample count
  changes again later).

This is a genuine training-data and test-specification change, not a relaxation to make a
failing test pass — documented here per CLAUDE.md's Test Specification Integrity rule, with
explicit user approval obtained during brainstorming (2026-06-24).

### Verification

Full bronze gate, plus re-run of the diagnostic guardian/observer accuracy test to confirm
no regression from the dedup + retrain.

## Sprint Breakdown

- **Sprint 3** — Part 1 (contour-based extraction). New spec-adjacent plan file
  `docs/superpowers/plans/2026-06-24-contour-based-extraction-sprint-1-implementation.md`.
- **Sprint 4** — Part 2 (dedup + floor re-baseline). Plan file
  `docs/superpowers/plans/2026-06-24-contour-based-extraction-sprint-2-dedup-floor.md`.

Each sprint ends with its own bronze-gate-clean commit. Sprint 4 is the one that also needs
Silver Gate doc-hygiene attention before any eventual merge (this spec deleted once both
sprints are folded into `docs/image-pipeline.md` or equivalent).
