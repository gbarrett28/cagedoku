# HOG Digit Recogniser — Design Spec

**Date:** 2026-05-01
**Status:** Approved

## Problem

The current digit recogniser uses raw-pixel PCA → SVM with per-class mean templates as a
fast path. Both the templates and the SVM decision boundaries were fit on a narrow set of
newspaper puzzle fonts. A digit from an unfamiliar font (e.g. the Observer) is confidently
misclassified because the model encodes "what a 4 looks like in this font" rather than
"what a 4 looks like structurally."

## Approach

Replace the raw-pixel PCA + template pipeline with a HOG-SVM trained on a diverse,
augmented dataset. HOG (Histogram of Oriented Gradients) captures edge directions rather
than pixel values, making it structurally font-invariant. Training diversity is expanded
via synthetic font rendering and data augmentation. The template fast-path is removed
entirely — HOG is fast enough to be the sole classifier.

Three concerns addressed together:

- **A — Augmentation:** random scale, shear, stroke-width variation, blur applied to every sample
- **B — Synthetic fonts:** Pillow renders digits 1–9 in available system fonts at multiple sizes
- **C — HOG features:** replaces raw-pixel flattening; no PCA step

If the new model regresses on known-font puzzles after E2E testing, the branch is reverted.
No hybrid fallback is maintained.

---

## Training Pipeline

### New files

**`killer_sudoku/training/synthetic_fonts.py`**
Renders digits 1–9 using Pillow against system fonts discovered via
`matplotlib.font_manager.findSystemFonts()` at three point sizes (32 pt, 48 pt, 64 pt),
each rescaled to a white 64×64 background. Returns `list[tuple[int, np.ndarray]]` in the
same format as `numerals.pkl`. Skips fonts that fail to render (corrupt or symbol-only).

**`killer_sudoku/training/augment.py`**
Augmentation applied to every sample (real and synthetic) before feature extraction:
- Scale: ±20% (random uniform)
- Shear: ±8° (random uniform)
- Stroke width: morphological dilation or erosion, 1–2 px, chosen randomly
- Blur: Gaussian, σ ∈ [0, 1.0]
- No rotation >15° — 6/9 ambiguity makes larger rotations label-unsafe

### Modified files

**`killer_sudoku/training/train_number_recogniser.py`**
- Load real samples from `numerals.pkl`
- Generate and merge synthetic font samples
- Apply augmentation to all samples
- Extract HOG features via `skimage.feature.hog`:
  - `pixels_per_cell=(8, 8)`, `cells_per_block=(2, 2)`, `orientations=9`
  - Input: 64×64 uint8 → output: ~1764-dim float vector
- Train `SVC(kernel='rbf')` directly on HOG vectors — no PCA step
- Do not compute per-class mean templates

**`killer_sudoku/image/number_recognition.py`**
Update `CayenneNumber` dataclass and `save_number_recogniser` / `load_number_recogniser`
to store HOG parameters and drop PCA/template fields. `collect_numerals.py` uses this
module to label non-bootstrap samples, so it must remain loadable after the format change.

**`killer_sudoku/training/export_model_web.py`**
Writes the new `.npz` format (see Model Format below). Removes PCA and template arrays.

---

## Model Format

The `killer_sudoku/data/num_recogniser.npz` file changes as follows:

| Field | Old | New |
|---|---|---|
| `pca_components` | ✓ | removed |
| `pca_mean` | ✓ | removed |
| `pca_n_components` | ✓ | removed |
| `templates` | ✓ | removed |
| `template_threshold` | ✓ | removed |
| `rbf_*` (SVM weights) | ✓ | unchanged |
| `hog_win_size` | — | 64 |
| `hog_cell_size` | — | 8 |
| `hog_block_size` | — | 16 |
| `hog_block_stride` | — | 8 |
| `hog_nbins` | — | 9 |
| `confidence_threshold` | — | tunable scalar |

HOG parameters are stored in the model so training and inference cannot silently diverge.

---

## Inference (TypeScript)

### `web/src/image/opencv.ts`
Add `HOGDescriptor` to the `OpenCVModule` interface.

### `web/src/image/numberRecognition.ts`

**Removed:**
- `PCAModel` interface
- `Templates` type
- `pcaTransform` function
- `paintMask` function
- Template matching branch in `getSums`
- `loadNumRecogniser` PCA/template loading paths

**New interface:**
```typescript
export interface NumRecogniser {
  hog: HOGParams;
  rbf: RBFModel;          // unchanged
  confidenceThreshold: number;
}

interface HOGParams {
  winSize: number;        // 64
  cellSize: number;       // 8
  blockSize: number;      // 16
  blockStride: number;    // 8
  nbins: number;          // 9
}

export interface Recognition {
  label: number;
  confident: boolean;
}
```

**New function:** `hogExtract(cv, imgs, params): Float64Array[]`
Calls `cv.HOGDescriptor` on each 64×64 thumbnail, returns one descriptor per image.

**`classify`:** `hogExtract` → `rbfPredict`. No PCA step.

**`rbfPredict`:** Extended to return decision function scores alongside labels.
`confident` is `true` when the winning class score ≥ `confidenceThreshold`.

**`getSums` renamed to `recognise`:** Returns `Recognition[]` instead of `Int32Array`.
Callers receive `label` as before; the session layer surfaces `confident: false` entries
to the UI as uncertain cage totals (visual highlight, not a hard error).

---

## Test Validation

All validation is browser-based via Playwright E2E against the production build.

**Puzzle set:** all images in `guardian/` and `observer/` directories, plus `test.png`.

**Pass criteria:**
- Accuracy on the full puzzle set ≥ current baseline (no regression on known fonts)
- Observer puzzle reads cage totals correctly
- `app.spec.ts` and `offline.spec.ts` suites pass without modification
- Any low-confidence flag on a correctly-read digit → loosen `confidenceThreshold`
- Any low-confidence flag on a wrong digit → threshold is working correctly

**Revert trigger:** measurable accuracy regression on the guardian/observer set vs the
current model. No hybrid fallback is kept in the code.
