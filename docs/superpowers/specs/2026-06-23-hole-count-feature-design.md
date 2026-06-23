# Hole-count feature for the digit recogniser — design spec

**Date:** 2026-06-23
**Status:** Approved, pending implementation

## Goal

Fix a confirmed 3-vs-8 confusion in the digit recogniser by adding a topological
"hole count" feature alongside the existing HOG features, without resorting to
extreme `--browser-weight` values that distort the linear SVM boundary and
collapse bulk-dataset generalisation.

## Background

At `--browser-weight 1000`, `browser_train.json` has 17 failures; **16 of the 17
are exactly the 3↔8 pair**, tracing back to only **3 unique source images**
(visually confirmed genuine, unambiguous digits with the expected hole
structure — not a labelling or image-quality problem). Forcing these onto the
correct side via `--browser-weight 20000` fixed all 17 but collapsed bulk
accuracy (guardian 99.2%→93.64%, observer 87.6%→72.37%), confirmed via a
confusion-matrix diagnostic showing the regression is diffuse (8/9 acting as
attractor classes for many unrelated digits) — a global boundary distortion,
not a sharpened 3-vs-8 distinction.

HOG features encode local gradient orientation, not global topology — a "3"
and "8" can produce similar per-cell gradient histograms despite one having
zero enclosed regions and the other two. Adding an explicit hole-count feature
gives the linear classifier the missing signal directly, so the 3 ambiguous
images can be resolved without bending the boundary for everything else.

## Algorithm

Operates on the same 64×64 binarized digit thumbnails used for HOG (ink=255,
background=0 — matches the existing `adaptiveThreshold` + `THRESH_BINARY_INV`
convention). Pure arithmetic, no OpenCV/cv2 dependency — mirrors the existing
`hogExtract` (TS) / `extract_hog` (Python) convention so the function runs in
both the browser and the Vitest/Node test environment without a WASM module.

1. **Outside flood-fill**: BFS from every border background pixel (ink=0),
   4-connectivity. 4-connectivity (not 8) avoids false leaks through diagonal
   single-pixel stroke pinches, which would otherwise erroneously merge a real
   hole with the outside region.
2. **Hole labelling**: any background pixel not reached by step 1 is enclosed.
   A second 4-connectivity flood-fill pass labels these into distinct regions,
   recording each region's pixel area.
3. **Noise filtering**: discard any hole region with area `< MIN_HOLE_AREA`
   (default **6px**, tunable constant). Anti-aliasing/binarization artifacts
   and the dither augmentation's 1% random pixel flips can create 1–3px
   spurious holes; real digit holes run tens to hundreds of pixels, so this
   threshold has wide margin. Validate against real samples during
   implementation; adjust if needed.
4. **Feature vector** (5 dims), built from the surviving hole areas sorted
   descending:
   - One-hot bucket of hole count, clipped to `{0, 1, 2+}` (3 dims) — lets the
     linear model assign an independent weight per bucket rather than
     assuming a linear relationship between count and class.
   - The two largest hole areas, each expressed as a **fraction of the
     digit's own ink-pixel count** (2 dims, zero-padded if fewer than 2 holes
     survive filtering). Using the digit's own ink-pixel count as the
     denominator (not a fixed image area) keeps the fraction meaningful
     regardless of how the square-pad warp scaled the digit. This distinguishes
     e.g. one big loop from two medium loops even when total hole area
     coincides.

Known limitation: a digit whose stroke is clipped exactly at the 64×64 thumbnail
border could have an enclosed loop falsely read as touching the outside through
the clipped edge. Accepted as a rare edge case of any bounding-box-based hole
test; not specifically mitigated.

## Module placement

**TypeScript** — new files, isolated from the already-substantial
`numberRecognition.ts` (676 lines):
- `web/src/image/holeFeatures.ts` — exports `extractHoleFeatures(imgs: Uint8Array[], winSize: number): Float64Array`
  (shape `[n, 5]`, flattened row-major).
- `web/src/image/holeFeatures.test.ts` — hand-built synthetic test images: a
  ring (1 hole), a figure-8 double-ring (2 holes), an open arc (0 holes), and a
  case with a sub-threshold noise speck (verifies the area filter). Mirrors the
  existing `squarePadSrc` pure-geometry test pattern in
  `numberRecognition.test.ts`.

**Python** — `extract_hole_features(imgs: list[NDArray[np.uint8]], n_jobs: int = -1) -> NDArray[np.float64]`
added directly to `train_recogniser.py` next to `extract_hog`, mirroring its
joblib chunking pattern (`_extract_hole_chunk` analogous to
`_extract_hog_chunk`) as a **fully separate, independent dispatch** — the
existing, working HOG extraction code is not touched. The extra
image-pickling cost to a second worker pool is negligible against the ~10
minute total training run. No automated Python test is added (the project has
no Python test infrastructure); correctness is validated manually during
implementation (rendered test cases) and empirically via the retrain/accuracy
check below.

## Integration points

- **TS `classify()`** (`numberRecognition.ts`): concatenate `hogExtract(...)`
  output with `extractHoleFeatures(...)` per row before calling the
  classifier. No manifest/loader changes needed — `nFeatures` is already read
  from the trained `linear_coef` array shape, not a hardcoded constant.
- **Python `main()`**: at both existing `extract_hog(aug_imgs)` call sites
  (`build_dataset()` and the asymmetric-dither branch), `np.hstack` the HOG
  matrix with the new hole-feature matrix before fitting.

## Validation plan

1. Implement both sides; run the hand-built TS unit tests.
2. Retrain at `--browser-weight 1000` (away from the destructive 20000).
3. Check `browser_train.json` accuracy:
   - **100%** → the hole feature genuinely separates the 3 ambiguous images
     without extreme reweighting. Proceed.
   - **Still failing** → stop and reassess design rather than reaching for
     `--browser-weight` again (per `superpowers:systematic-debugging`'s
     "3+ fixes failed → question the architecture" guidance — this would be
     fix attempt #2 on this exact failure mode, weight-cranking having
     already been tried and rejected).
4. Re-run the guardian/observer bulk-accuracy diagnostic (training-only data,
   not a committed test — see existing note in `numberRecognition.test.ts`)
   and confirm it recovers toward the pre-regression 99.2%/87.6%, confirming
   the fix is real generalisation rather than memorisation.
5. Commit the retrained `web/public/num_recogniser.{bin,json}` only once both
   checks pass.

## Files changed

| File | Change |
|---|---|
| `web/src/image/holeFeatures.ts` | New — pure hole-counting feature extraction |
| `web/src/image/holeFeatures.test.ts` | New — synthetic-image unit tests |
| `web/src/image/numberRecognition.ts` | `classify()`: concatenate hole features with HOG features |
| `web/train_recogniser.py` | New `extract_hole_features`/`_extract_hole_chunk`; `main()`/`build_dataset()` call sites updated to `hstack` |
| `web/public/num_recogniser.{bin,json}` | Retrained once validation passes |

**Not changed:** `.github/workflows/retrain.yml`, model manifest format,
`web/browser_train.json`, `guardian_train_sq.json`/`observer_train_sq.json`
extraction (`extract_guardian_samples.py`).
