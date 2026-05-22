# Classic digit extraction — square-padded thumbnails

**Date:** 2026-05-22
**Status:** Approved, pending implementation

## Problem

`readClassicDigits` warps each digit's tight contour bounding rect to 64×64. For
thin digits (notably "1") the aspect ratio of the bounding rect is far from 1:1,
so the warp stretches the digit several times wider than its natural shape. The
resulting HOG gradient patterns are significantly distorted and can fall inside
another class's decision boundary (observed: "1" at r7c8 consistently read as "9"
across multiple NYT puzzles from the same device).

The same failure reproduces at the same cell position across different puzzles,
confirming it is a systematic extraction artefact rather than a training-data gap.

## Solution

Switch every point in the pipeline that produces a classic digit thumbnail from
**tight bounding rect → 64×64** to **square-padded → 64×64**:

- Centre the contour's bounding rect in a square canvas whose side equals
  `max(br.width, br.height)`.
- Warp that square region to 64×64.
- A thin "1" stays narrow in the middle of the canvas; digits with near-square
  bounding rects (0, 6, 8, 9) are unaffected.

Training and inference use the same extraction formula, so no dual-crop fallback
is needed.

## Scope

The killer cage-total path (`splitNum` + guardian/browser tight-crop samples) is
**not changed**. The 22 k existing tight-crop samples provide sufficient coverage
for killer inference.

## Changes

### 1 — `web/src/image/numberRecognition.ts` · `readClassicDigits`

Replace the `src` array construction after `cv.boundingRect`:

```typescript
// before
const src = [
  [ax, ay], [ax + br.width, ay],
  [ax + br.width, ay + br.height], [ax, ay + br.height],
];

// after
const side = Math.max(br.width, br.height);
const cx   = ax + br.width  / 2;
const cy   = ay + br.height / 2;
const src = [
  [cx - side / 2, cy - side / 2], [cx + side / 2, cy - side / 2],
  [cx + side / 2, cy + side / 2], [cx - side / 2, cy + side / 2],
];
```

### 2 — `web/src/image/numberRecognition.ts` · `readClassicDigits` return type

Change the return type from `number[][]` to
`{ digits: number[][]; thumbs: Map<string, Uint8Array[]> }`.

Capture each thumbnail alongside its digit reading and key it as `"${r},${c}"`
using **0-indexed** row and column, matching the convention used by
`extractTrainingData`. Each map value is a single-element array `[thumb]`
so the type is directly compatible with `extractTrainingData`'s
`ReadonlyMap<string, Uint8Array[]>` parameter without any wrapping at the
call site.

Callers in `inpImage.ts` that currently receive `number[][]` are updated to
destructure `{ digits, thumbs }`.

### 3 — `web/src/image/inpImage.ts`

Thread the `thumbs` map returned from `readClassicDigits` through to the
pipeline result so the review screen can pass it to `extractTrainingData`.

The pipeline result type gains an optional `classicThumbs` field
(`Map<string, Uint8Array> | undefined`), populated only on the classic path.

### 4 — `web/src/main.ts` · training export

On the classic path, pass `classicThumbs` and `givenDigits` to
`extractTrainingData` as the `cellThumbs` and `cageTotals` arguments
respectively. The function already supports `puzzleType: 'classic'`; it just
needs thumbnails supplied.

### 5 — `web/train_recogniser.py` · `generate_synthetic_samples`

Replace the current tight-crop → resize with square-pad → resize:

```python
# before
out = Image.fromarray(crop).resize((win_size, win_size), Image.LANCZOS)

# after
h_c, w_c = crop.shape
side = max(h_c, w_c)
square = np.zeros((side, side), dtype=np.uint8)
square[(side - h_c) // 2:(side - h_c) // 2 + h_c,
       (side - w_c) // 2:(side - w_c) // 2 + w_c] = crop
out = Image.fromarray(square).resize((win_size, win_size), Image.LANCZOS)
```

This replaces (does not supplement) the tight-crop synthetic samples.

## Re-training workflow

1. Implement all code changes above and merge to `master`.
2. User re-exports classic training samples from existing problem puzzles via the
   updated OCR review screen → samples upload to R2 automatically.
3. The 8-hour retrain workflow picks them up, merges into `web/browser_train.json`,
   and deploys an updated model.

No manual retrain step is required.

## Testing

**Automated (bronze + silver gates):**
- `tsc --noEmit` — type-check the changed return type and new pipeline field.
- `npm test` — existing unit tests cover `readClassicDigits`, `extractTrainingData`.
- Playwright `flow.spec.ts` — exercises the classic puzzle OCR review flow.

**Manual:**
- Scan both NYT screenshots provided (the "Easy" and "Hard" puzzles) and confirm
  r7c8 is read as "1" not "9".
- Confirm that other given digits in both puzzles are unaffected.
- Export training data from a classic puzzle and verify the exported `pixels` arrays
  represent the square-padded thumbnails (digit centred, whitespace on narrow sides).

## Files changed

| File | Change |
|---|---|
| `web/src/image/numberRecognition.ts` | Square-padded crop in `readClassicDigits`; widen return type |
| `web/src/image/inpImage.ts` | Thread `classicThumbs` through pipeline result |
| `web/src/main.ts` | Pass `classicThumbs` to `extractTrainingData` on classic path |
| `web/train_recogniser.py` | Square-pad synthetic generation |
