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

### `find_digit_blobs` — via a Node CLI bridge, not a Python/cv2 mirror

Rather than re-implementing contour detection a third time in Python/cv2 (the same class
of cross-language drift that caused the original bug), `find_digit_blobs` calls the
*literal* production TypeScript primitives through a small Node bridge process. This is
possible because `web/public/opencv.js` is a standard dual-environment Emscripten build
(`ENVIRONMENT_IS_NODE` and `ENVIRONMENT_IS_WEB` both present, WASM binary embedded inline)
— it runs under plain Node, not just in a browser.

**Architecture:**

- `web/scripts/find-digit-blobs-server.ts` — a small persistent Node process, run via
  `vite-node` (already available transitively through vitest, no new dependency). On
  startup it loads `web/public/opencv.js` once, awaits its ready signal, then reads
  newline-delimited JSON requests from stdin and writes newline-delimited JSON responses
  to stdout, one line per request:
  - Request: `{"id": <int>, "w": <int>, "h": <int>, "subres": <int>, "pixels": "<base64>"}`
    — `pixels` is the raw row-major uint8 ROI buffer (length `w*h`).
  - Response: `{"id": <int>, "blobs": [[x,y,w,h], ...]}` — found via the real
    `cv.findContours(mat, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)` +
    `cv.boundingRect`, filtered through `contourIsNumber` **imported directly** from
    `web/src/image/numberRecognition.ts` (not copied, not reimplemented), sorted
    left-to-right by x.
  - `RETR_EXTERNAL` (not `RETR_TREE`): the caller has already scoped `roi` to the
    cage-total's top-left quadrant, so production's recursive hole-walk — needed there to
    disambiguate cage-totals from centred solution digits across the whole board — has no
    equivalent ambiguity to resolve here.
- Python's `find_digit_blobs(roi, subres)` becomes a thin client: starts the bridge
  process lazily on first call (`subprocess.Popen` with piped stdin/stdout), keeps it
  alive for the whole extraction run (one `extract_directory`/`main()` call), writes one
  request line, reads one response line, decodes the blob list, and terminates the
  process at the end. The function's signature and contract are unchanged from a pure-Python
  implementation, so the rest of Part 1's design (the case 3/4/5 assignment logic below)
  does not change at all — only `find_digit_blobs`'s internals move from a cv2
  reimplementation to a Node RPC call.
- Scope boundary: only the contour-finding primitive crosses the bridge. `letterbox_warp`
  (pure perspective-transform math, already verified correct via the prior "mirror
  letterbox crop fix" commit) and the merged-blob ink-projection fallback split stay in
  Python — they're not the part that's been buggy, and round-tripping them through Node
  would add latency and complexity for no correctness benefit.

**De-risking step (do this first, before wiring up the full bridge):** write a minimal
standalone smoke test that loads `opencv.js` under plain Node and runs `cv.findContours`
on a synthetic buffer, confirming it produces sane output. This repo has never loaded
opencv.js outside a browser before (existing `probe-cv*.mjs` scripts drive a real browser
via Playwright to debug WASM-loading flakiness — they don't establish that Node-native
loading works). If this smoke test doesn't work cleanly within a short time-box, fall back
to Part 1's original plan (a direct Python/cv2 reimplementation of `find_digit_blobs`,
accepting the cross-language-drift risk but covered by the regression tests already
planned below) rather than letting infrastructure risk block the sprint.

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

- Standalone Node smoke test (the de-risking step above) — not a permanent test, just a
  go/no-go check, deleted once the bridge is confirmed working.
- Bridge protocol tests, sending synthetic ROI buffers through the real
  request/response protocol and asserting on the actual Node-side output: single
  digit-sized blob found; trailing thin decoration line correctly excluded;
  border-bleed-shaped blob correctly excluded; two separate digit blobs both found and
  ordered left-to-right. These exercise the literal production `contourIsNumber` —
  proving production's real logic handles the exact failure cases found tonight, with no
  Python-side reimplementation to keep in sync or drift from.
- Python-side tests for the client function (`find_digit_blobs`) mock the subprocess
  boundary (request in, decoded blob list out) rather than re-asserting contour behaviour
  already covered by the bridge protocol tests above.
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
