# Letterbox Digit Crop — Design

## Objective

Eliminate boundary-bleed artifacts in digit crops — cage border lines, grid lines, or
adjacent-digit fragments leaking into a digit's 64×64 thumbnail — which cause the HOG
classifier to misread otherwise-legible digits as "1". Confirmed via direct HOG
gradient analysis on two `browser_train.json` failures (samples 8045, 7959): both show
a near-constant-magnitude vertical edge spanning the full crop height in several
rightmost HOG cell-columns, far outside where the real digit ink lives.

## Background

- `squarePadSrc(ax, ay, bw, bh)` (`web/src/image/numberRecognition.ts`) centers a
  digit's tight contour bounding rect inside a **square** source region with
  `side = max(bw, bh)`. For narrow digits (width << height — true of "1", often "7"),
  this stretches the source sampling window outward on the narrow axis.
  `getWarpFromRect` then perspective-warps whatever real image content falls inside
  that stretched region into the destination thumbnail — typically a cage border or
  grid line — producing a strong, uniform vertical edge that closely mimics digit
  "1"'s own defining HOG signature.
- This mechanism only triggers when `bw != bh` (non-square tight rects). Square-ish
  digits ("8", "0") see no/minimal stretch and no bleed — consistent with the observed
  failure pattern (narrow digits only).
- `getWarpFromRect` (`web/src/image/numberRecognition.ts:471-493`) currently hardcodes
  a destination quad that covers the **entire** output canvas (4 corners → 4 corners,
  full coverage), so there is never an "uncovered" region in the destination needing a
  border fill under the current design.
- `cv.warpPerspective`'s declared signature in this codebase
  (`web/src/image/opencv.ts:133`) is `(src, dst, M, dsize, flags?)` — no explicit
  `borderMode`/`borderValue` params. OpenCV's (and OpenCV.js's) compiled default for
  omitted border params is `BORDER_CONSTANT` with `Scalar(0)` (black), which matches
  this codebase's BINARY_INV convention (ink = 255, background = 0). A destination
  region not covered by the mapped source quad is therefore automatically filled with
  the correct background value, with no new parameters required.
- `web/extract_guardian_samples.py` is a hand-written Python/`cv2` mirror of the TS
  crop logic (no OpenCV.js-in-Node harness exists in this repo), already explicitly
  commented as matching `squarePadSrc` "exactly." It has its own `square_pad_src` +
  `warp_thumb` pairing with 2 call sites (`web/extract_guardian_samples.py:274,296`),
  both passing a tight bounding rect derived from connected-component pixel extents.
- `browser_train.json` samples are **frozen, already-cropped 64×64 pixel arrays**
  captured historically through whatever crop logic was live in-browser at capture
  time — there is no raw image to re-crop. This fix cannot retroactively repair
  already-bled samples in that file; it only prevents bleed in future captures and in
  freshly regenerated bulk datasets.

## Design

### 1. Generalize `getWarpFromRect` to accept an explicit destination quad

Currently `getWarpFromRect` hardcodes a full-canvas-coverage destination quad
internally. Add a `dst` parameter (4-corner array, same `[[x,y], ...]` shape as `rect`)
so callers can specify either full coverage (existing behavior, for `mergedThumb`) or a
centered sub-region (new letterbox behavior). This is the only change to
`getWarpFromRect` itself — its OpenCV call (`cv.getPerspectiveTransform` +
`cv.warpPerspective`) is unchanged.

### 2. New `letterboxWarp` helper, replacing `squarePadSrc`

```ts
function letterboxWarp(
  cv: Cv, ax: number, ay: number, bw: number, bh: number,
  gry: OpenCVMat, resH: number = 64, resW: number = 64,
): Uint8Array {
  const scale = Math.min((resW - 1) / bw, (resH - 1) / bh);
  const destW = bw * scale, destH = bh * scale;
  const offX = ((resW - 1) - destW) / 2, offY = ((resH - 1) - destH) / 2;
  const src = [[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]];
  const dst = [[offX, offY], [offX + destW, offY], [offX + destW, offY + destH], [offX, offY + destH]];
  return getWarpFromRect(cv, src, gry, resH, resW, dst);
}
```

Maps the digit's tight bounding rect (no square stretch) directly into a centered,
aspect-preserving sub-region of the destination canvas. The remaining canvas area
(the "letterbox bars") is filled with the warp's default border value (0 = background),
requiring no extra masking step.

`squarePadSrc` is deleted once all call sites are migrated.

### 3. Call sites to update (TypeScript)

Confirmed via `find_referencing_symbols` on `squarePadSrc` — exactly 8 references:

- `splitNum` (`web/src/image/numberRecognition.ts:515-595`) — 7 of its 8
  `squarePadSrc`-paired warps become `letterboxWarp` calls (the no-split `sqThumb`,
  two in the per-candidate split-search loop, two in the final confident-split result,
  two in the ink-projection-fallback result). The 8th, `mergedThumb`, already warps the
  raw bounding rect with full-canvas coverage and has no square-stretch bleed risk — it
  is left unchanged (its separate, lower-priority issue is non-uniform aspect
  distortion, out of scope here).
- `readClassicDigits` (`web/src/image/numberRecognition.ts:673`) — 1 call site, using a
  non-default `half` destination size: `squarePadSrc(ax, ay, br.width, br.height)` +
  `getWarpFromRect(cv, src, warpedBlk, half, half)` becomes
  `letterboxWarp(cv, ax, ay, br.width, br.height, warpedBlk, half, half)`. This means
  classic sudoku given-digit recognition gets the same bleed fix as killer cage totals,
  not just the latter.

### 4. Call sites to update (Python mirror)

`web/extract_guardian_samples.py`: replace `square_pad_src` + `warp_thumb`
(lines 85-121) with an equivalent `letterbox_warp(ax, ay, bw, bh, warped)` mirroring the
TS implementation exactly (same comment convention already used: "Matches the
TypeScript ... helper exactly"). Update both call sites (lines 274, 296), which already
pass a tight bounding rect derived from connected-component pixel extents — no upstream
changes needed beyond the function call itself.

### 5. Regenerate bulk training data, retrain, and verify

1. Re-run `extract_guardian_samples.py` against the existing raw guardian/observer jpg
   folders to regenerate `guardian_train_sq.json` / `observer_train_sq.json` with the
   new crop.
2. Retrain via `train_recogniser.py` using the same recipe as the most recent run
   (`--browser-weight 1000`; hole-count feature included, since that work is in
   progress on this branch independently of this fix).
3. Compare bulk accuracy before/after on guardian/observer. Baseline from the most
   recent retrain log: 99.69% guardian / 92.12% observer. Observer (more cramped/lower-
   quality scans, more likely to trigger bleed) is expected to show the larger
   improvement.
4. Check `browser_train.json` accuracy: expected to remain at 8355/8362 (same 7 known
   failures — see Out of Scope). This fix cannot change `browser_train.json`'s
   composition since its samples are frozen pre-cropped pixel arrays, not raw images.

## Out of Scope

- The 5-of-7 `browser_train.json` failures caused by a duplicated typeset glyph
  rendering — confirmed via pixel comparison to be a separate HOG/linear-SVM
  expressiveness limitation, not a crop issue.
- `mergedThumb`'s non-uniform aspect distortion in `splitNum` (different mechanism,
  no bleed risk, not diagnosed as causing any current failure).
- Retroactively fixing the 2 already-bled `browser_train.json` samples (8045, 7959) —
  not possible without recapturing those specific puzzles through the live browser
  flow, which is a manual data-collection task, not a code fix.

## Testing

- Existing `holeFeatures.test.ts`-style unit tests are not directly applicable here
  (`letterboxWarp` depends on real `cv.Mat`/perspective-warp behavior, same OpenCV
  dependency constraint that applies to all of `splitNum`/`getWarpFromRect`). Verification
  is via the bulk-accuracy regeneration/retrain/compare flow in Design §5, using the
  existing `_diag_bulk_accuracy.test.ts` diagnostic pattern (non-shipped, no assertions,
  logs accuracy + mispredictions) — same pattern already used for prior accuracy checks
  this session.
- Manual confirmation: re-render the previously-diagnosed bleed samples (8045, 7959
  equivalents from the regenerated bulk sets, if present) and visually confirm the
  letterboxed crop no longer includes the border/grid-line artifact.
