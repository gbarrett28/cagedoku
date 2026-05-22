# Unified digit recogniser — design spec

**Date:** 2026-05-22
**Status:** Approved, pending implementation

## Goal

Unify killer and classic digit thumbnail extraction to square-padded, produce a large
verified training corpus from the 889 guardian/observer puzzle images, and add a fast
Vitest regression benchmark that proves the retrained model is at least as good as the
current one.

## Context

After PR #114, classic digits use square-padded extraction.  The killer path
(`splitNum`) still uses tight-crop for individual digit thumbnails.  `guardian_train.json`
(20 k tight-crop samples at the repo root) was the original base training dataset but
is no longer used by the automated retrain workflow and is now superseded.

---

## Part 1 — `web/extract_guardian_samples.py`

A standalone Python script (cv2 + numpy only, no deleted `killer_sudoku.image` module)
that re-extracts all guardian and observer cage-total digits with square-padded
thumbnails, using the stored perspective transforms in the `.jpk` cache files as ground
truth.

### Inputs

| Source | Content |
|---|---|
| `guardian/*.jpg`, `observer/*.jpg` | Original puzzle photographs |
| `guardian/*.jpk`, `observer/*.jpk` | Cached `PicInfo` objects: `grid` (4×2 float32 source corners), `cage_totals[col][row]` (9×9 int64, column-major) |

`PicInfo` is deserialized via a two-line stub so the deleted Python module is not needed:
```python
sys.modules['killer_sudoku.image'] = types.ModuleType('killer_sudoku.image')
sys.modules['killer_sudoku.image.inp_image'] = types.ModuleType('killer_sudoku.image.inp_image')
class PicInfo: pass
sys.modules['killer_sudoku.image.inp_image'].PicInfo = PicInfo
```

### Pipeline (per puzzle)

1. **Load and binarize** — `cv2.imread` → grayscale → `cv2.adaptiveThreshold`
   (ADAPTIVE_THRESH_MEAN_C, THRESH_BINARY_INV, block 51, C 7) → `blk`
2. **Warp** — `cv2.getPerspectiveTransform(pic.grid, dst)` where `dst` maps to a
   `1152×1152` canvas (9 × `subres=128`); `cv2.warpPerspective` → `warped_blk`
3. **Find contours** — `cv2.findContours(warped_blk, RETR_TREE, CHAIN_APPROX_SIMPLE)`
4. **Filter to cage-total contours** — keep bounding rects where:
   - `subres/16 ≤ width ≤ subres/2` (8–64 px)
   - `subres/8 ≤ height ≤ subres/2` (16–64 px)
   - `y < subres/2` within its cell (cage totals are in the upper half)
5. **Assign to cell** — `col = x // subres`, `row = y // subres`; group contours per cell
6. **Match to cage total** — `cage_totals[col][row]`; skip cells where total is 0
7. **Pair contours to digits** — sort contours in cell left-to-right; if
   `len(contours) == len(str(total))`, pair by index; otherwise skip (ambiguous split)
8. **Square-pad and warp** — for each contour `(ax, ay, bw, bh)`:
   ```python
   side = max(bw, bh)
   cx, cy = ax + bw/2, ay + bh/2
   src = np.float32([[cx-side/2, cy-side/2], [cx+side/2, cy-side/2],
                     [cx+side/2, cy+side/2], [cx-side/2, cy+side/2]])
   dst64 = np.float32([[0,0],[63,0],[63,63],[0,63]])
   M = cv2.getPerspectiveTransform(src, dst64)
   thumb = cv2.warpPerspective(warped_blk, M, (64, 64))
   ```

### Outputs

`guardian/guardian_train_sq.json` and `observer/observer_train_sq.json` in the same
format as `web/browser_train.json`:

```json
{
  "version": 1,
  "puzzleType": "killer",
  "subres": 128,
  "thumbnailSize": 64,
  "exportedAt": "<ISO date>",
  "sampleCount": <n>,
  "samples": [{"digit": <1-9>, "pixels": [<4096 uint8 values>]}]
}
```

### Error handling

- Puzzle missing `.jpk`: skip with a warning (no ground-truth labels available)
- Contour count ≠ digit count for a cell: skip that cell (ambiguous; log at DEBUG)
- All other exceptions per puzzle: log and continue; report summary at end

### CLI

```
python web/extract_guardian_samples.py
python web/extract_guardian_samples.py --puzzle-dirs guardian observer
python web/extract_guardian_samples.py --subres 128
```

Default: processes both `guardian/` and `observer/` relative to repo root.

### One-off base retrain (local, after running this script)

```bash
python web/train_recogniser.py \
  --browser-weight 1000 --svm-c 100 \
  guardian/guardian_train_sq.json \
  observer/observer_train_sq.json \
  web/browser_train.json
```

Commit the updated `web/public/num_recogniser.{bin,json}`.  The 8-hour GitHub
Actions retrain continues unchanged — it uses only `web/browser_train.json` and new
R2 uploads.

### Cleanup

Delete root `guardian_train.json` (20 k tight-crop samples, superseded).

---

## Part 2 — `numberRecognition.test.ts` extension

Add a second `describe` block to the existing accuracy test that loads
`guardian_train_sq.json` and asserts 100% accuracy.  The block skips gracefully if
the file does not yet exist (before the extraction script is run).

```typescript
describe('digit recogniser — guardian square-padded samples', () => {
  let guardianSamples: TrainingSample[];
  let guardianRec: NumRecogniser;

  beforeAll(() => {
    const path = join(process.cwd(), '..', 'guardian', 'guardian_train_sq.json');
    if (!existsSync(path)) return;           // skip if not yet generated
    const trainFile: TrainingFile = JSON.parse(readFileSync(path, 'utf-8'));
    guardianSamples = trainFile.samples;
    // reuse rec loaded in outer beforeAll
    guardianRec = rec;
  });

  it('achieves 100% accuracy on guardian square-padded samples', () => {
    if (!guardianSamples?.length) return;  // skip if file absent
    const { correct, total, errors } = runOnSamples(guardianSamples);
    // ... same assertions as existing test
  });
});
```

This test becomes the fast regression benchmark for the base model.  If 100% accuracy
cannot be achieved, the model is not ready to commit.

---

## Part 3 — `splitNum` square-padding

Replace tight-crop individual-digit thumbnails with square-padded equivalents.
`mergedThumb` (tight-crop full bounding rect) is **unchanged** — it is fed to the
split-recogniser (a separate model) and exported for split-recogniser retraining.

### Single-digit path

```typescript
// before
return [[mergedThumb], mergedThumb, x, y];

// after
const sqThumb = getWarpFromRect(cv, squarePadSrc(x, y, w, h), warpedBlk);
return [[sqThumb], mergedThumb, x, y];
```

### Two-digit confidence candidates (split-point search)

```typescript
// before
allThumbs.push(getWarpFromRect(cv, lSrc, warpedBlk));
allThumbs.push(getWarpFromRect(cv, rSrc, warpedBlk));

// after
allThumbs.push(getWarpFromRect(cv, squarePadSrc(x,      y, sp,     h), warpedBlk));
allThumbs.push(getWarpFromRect(cv, squarePadSrc(x + sp, y, w - sp, h), warpedBlk));
```

### Two-digit final thumbnails

```typescript
// before
return [[getWarpFromRect(cv, lSrc, warpedBlk), getWarpFromRect(cv, rSrc, warpedBlk)],
        mergedThumb, x, y];

// after
return [[getWarpFromRect(cv, squarePadSrc(x, y, bestSplit, h), warpedBlk),
         getWarpFromRect(cv, squarePadSrc(x + bestSplit, y, w - bestSplit, h), warpedBlk)],
        mergedThumb, x, y];
```

Same pattern applies in the ink-projection fallback path.

---

## Files changed

| File | Change |
|---|---|
| `web/extract_guardian_samples.py` | New — square-padded guardian/observer extraction |
| `web/src/image/numberRecognition.test.ts` | Add guardian accuracy describe block |
| `web/src/image/numberRecognition.ts` | `splitNum`: square-pad individual digit thumbnails |
| `guardian_train.json` | Delete (superseded) |

**Not changed:** `.github/workflows/retrain.yml`, `web/train_recogniser.py`,
`web/browser_train.json`.

---

## Testing

1. Run `python web/extract_guardian_samples.py` → check sample counts reported
2. Run `python web/train_recogniser.py ... guardian/guardian_train_sq.json ...` locally
3. `npm test` from `web/` → guardian accuracy describe block reports 100%
4. `tsc --noEmit` → clean
5. Manual: scan a killer puzzle, confirm all cage totals still read correctly
