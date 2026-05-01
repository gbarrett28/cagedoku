# HOG Digit Recogniser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PCA+template digit recogniser with a HOG-SVM trained on synthetic fonts and augmented real data, with per-read confidence flagging.

**Architecture:** `web/train_recogniser.py` (the existing self-contained retraining script) is updated to use `cv2.HOGDescriptor` instead of PCA+raw-pixels, gains synthetic-font sample generation, and drops template output. Its `save_model` writes HOG scalar params + SVM weights instead of PCA arrays + templates — same `.bin`/`.json` manifest format, different keys. TypeScript inference replaces `pcaTransform` + template matching with `hogExtract` via `cv.HOGDescriptor` and adds vote-fraction confidence scores.

**Tech Stack:** Python: `cv2.HOGDescriptor`, `PIL` (Pillow, already installed), `matplotlib.font_manager`, `sklearn.svm.SVC`. TypeScript: `cv.HOGDescriptor` (OpenCV.js custom build), Vitest, Playwright.

**Key constraint:** `cv2.HOGDescriptor` and `cv.HOGDescriptor` are both OpenCV — identical parameters produce identical feature vectors, guaranteeing train/inference parity.

---

## File Map

| Action | Path | What changes |
|---|---|---|
| Rewrite | `web/train_recogniser.py` | HOG features, synthetic fonts, no PCA/templates |
| Create | `tests/test_train_recogniser.py` | Unit tests for new functions |
| Modify | `web/src/image/opencv.ts` | Add `HOGDescriptor` interface |
| Modify | `web/src/image/numberRecognition.ts` | Remove PCA/templates; add `HOGParams`, `Recognition`, `hogExtract`, `recognise` |
| Modify | `web/src/image/inpImage.ts` | `getSums` → `recognise` caller |
| Create | `web/src/image/numberRecognition.hog.test.ts` | `hogExtract` shape + confidence test |

---

## Sprint 1 — Update `web/train_recogniser.py` (~2.5 h)

### Task 1: Add `generate_synthetic_samples` + `extract_hog`

**Files:**
- Modify: `web/train_recogniser.py`
- Create: `tests/test_train_recogniser.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_train_recogniser.py
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from train_recogniser import generate_synthetic_samples, extract_hog, HOG_FEAT


def test_generate_synthetic_samples_covers_digits_1_to_9():
    samples = generate_synthetic_samples()
    assert len(samples) > 0
    labels = {label for label, _ in samples}
    assert labels == set(range(1, 10)), f"Missing: {set(range(1,10)) - labels}"
    for _, img in samples[:5]:
        assert img.shape == (64, 64)
        assert img.dtype == np.uint8
        assert img.max() > 0


def test_extract_hog_output_shape():
    imgs = [np.zeros((64, 64), dtype=np.uint8) for _ in range(3)]
    imgs[0][20:44, 28:36] = 200   # rough digit stroke
    X = extract_hog(imgs)
    assert X.shape == (3, HOG_FEAT), f"Expected (3, {HOG_FEAT}), got {X.shape}"
    assert X.dtype == np.float64
```

- [ ] **Step 2: Run to verify failure**

```bash
cd C:\Users\geoff\PycharmProjects\killer_sudoku
.venv\Scripts\python -m pytest tests/test_train_recogniser.py -v
```

Expected: `ImportError: cannot import name 'generate_synthetic_samples' from 'train_recogniser'`

- [ ] **Step 3: Add constants and new functions to `web/train_recogniser.py`**

At the top of the file, replace the existing constants block with:

```python
# ---------------------------------------------------------------------------
# Constants — must match the TypeScript pipeline (web/src/image/numberRecognition.ts)
# ---------------------------------------------------------------------------

THUMBNAIL_SIZE = 64
N_DIGITS = 10
DEFAULT_DITHER = 30
CONFIDENCE_THRESHOLD = 0.7   # OVO vote fraction to mark a read as confident
SVM_C = 10.0
SVM_GAMMA = 0.01

# HOG descriptor parameters — identical values used in cv.HOGDescriptor (TypeScript).
HOG_WIN_SIZE    = 64
HOG_CELL_SIZE   = 8
HOG_BLOCK_SIZE  = 16
HOG_BLOCK_STRIDE = 8
HOG_NBINS       = 9
# ((64-16)/8+1)^2 * (16/8)^2 * 9 = 7^2 * 4 * 9
HOG_FEAT        = 1764
```

After the existing imports, add `import cv2` (it's already a project dependency via `opencv-python-headless`).

After the existing `load_training_file` function, add:

```python
# ---------------------------------------------------------------------------
# Synthetic font generation
# ---------------------------------------------------------------------------

def generate_synthetic_samples(
    win_size: int = THUMBNAIL_SIZE,
    pt_sizes: tuple[int, ...] = (32, 48, 64),
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Render digits 1–9 in all discoverable system TTF fonts via Pillow.

    Returns (label, win_size×win_size uint8) pairs in the same format as
    load_training_file, supplementing browser-exported samples with coverage
    across common newspaper and system typefaces.
    """
    import matplotlib.font_manager as fm
    from PIL import Image, ImageDraw, ImageFont

    font_paths = fm.findSystemFonts(fontext="ttf")
    samples: list[tuple[int, NDArray[np.uint8]]] = []

    for font_path in font_paths:
        for pt in pt_sizes:
            for digit in range(1, 10):
                try:
                    font = ImageFont.truetype(font_path, pt)
                except Exception:
                    continue
                canvas = win_size * 2
                img = Image.new("L", (canvas, canvas), 0)
                draw = ImageDraw.Draw(img)
                text = str(digit)
                bbox = draw.textbbox((0, 0), text, font=font)
                w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
                if w == 0 or h == 0:
                    continue
                x = (canvas - w) // 2 - bbox[0]
                y = (canvas - h) // 2 - bbox[1]
                draw.text((x, y), text, fill=255, font=font)
                arr = np.array(img, dtype=np.uint8)
                ys, xs = np.where(arr > 0)
                if len(ys) == 0:
                    continue
                margin = 4
                y0 = max(0, int(ys.min()) - margin)
                y1 = min(arr.shape[0], int(ys.max()) + margin + 1)
                x0 = max(0, int(xs.min()) - margin)
                x1 = min(arr.shape[1], int(xs.max()) + margin + 1)
                crop = arr[y0:y1, x0:x1]
                out = np.array(
                    Image.fromarray(crop).resize((win_size, win_size), Image.LANCZOS),
                    dtype=np.uint8,
                )
                if out.max() > 0:
                    samples.append((digit, out))

    return samples


# ---------------------------------------------------------------------------
# HOG feature extraction
# ---------------------------------------------------------------------------

def extract_hog(imgs: list[NDArray[np.uint8]]) -> NDArray[np.float64]:
    """Extract HOG feature vectors from win_size×win_size uint8 images.

    Uses cv2.HOGDescriptor with identical parameters to the browser's
    cv.HOGDescriptor — guarantees training/inference feature parity.
    Each image produces a HOG_FEAT-dimensional float64 vector.
    """
    hog = cv2.HOGDescriptor(
        (HOG_WIN_SIZE,    HOG_WIN_SIZE),
        (HOG_BLOCK_SIZE,  HOG_BLOCK_SIZE),
        (HOG_BLOCK_STRIDE, HOG_BLOCK_STRIDE),
        (HOG_CELL_SIZE,   HOG_CELL_SIZE),
        HOG_NBINS,
    )
    rows: list[NDArray[np.float64]] = []
    for img in imgs:
        desc = hog.compute(img)          # shape (HOG_FEAT, 1)
        rows.append(desc.flatten().astype(np.float64))
    return np.array(rows, dtype=np.float64)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
.venv\Scripts\python -m pytest tests/test_train_recogniser.py -v
```

Expected: 2 PASSED (synthetic generation may take 10–20 s)

- [ ] **Step 5: Commit**

```bash
git add web/train_recogniser.py tests/test_train_recogniser.py
git commit -m "feat: add synthetic font generator and HOG extractor to train_recogniser"
```

---

### Task 2: Replace `build_dataset`, `fit_model`, and `save_model`

**Files:**
- Modify: `web/train_recogniser.py`
- Modify: `tests/test_train_recogniser.py`

- [ ] **Step 1: Add tests for the updated functions**

Append to `tests/test_train_recogniser.py`:

```python
import json
import tempfile

from train_recogniser import build_dataset, fit_model, save_model, CONFIDENCE_THRESHOLD


def _make_samples() -> list[tuple[int, "np.ndarray"]]:
    rng = np.random.default_rng(0)
    return [(d, rng.integers(0, 255, (64, 64), dtype=np.uint8)) for d in range(1, 10)]


def test_build_dataset_shape():
    samples = _make_samples()
    X, y = build_dataset(samples, n_dither=2)
    # 9 digits × (1 original + 2 dither) = 27
    assert X.shape == (27, HOG_FEAT)
    assert y.shape == (27,)
    assert set(y.tolist()) == set(range(1, 10))


def test_save_model_keys():
    samples = _make_samples()
    X, y = build_dataset(samples, n_dither=1)
    model = fit_model(X, y)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        save_model(model, out, confidence_threshold=CONFIDENCE_THRESHOLD)
        manifest = json.loads((out / "num_recogniser.json").read_text())
    keys = set(manifest["arrays"].keys())
    expected = {
        "hog_win_size", "hog_cell_size", "hog_block_size", "hog_block_stride",
        "hog_nbins", "confidence_threshold",
        "rbf_support_vectors", "rbf_dual_coef", "rbf_intercept",
        "rbf_n_support", "rbf_gamma", "rbf_classes",
    }
    assert keys == expected
    # No PCA or template keys.
    assert not any(k.startswith("pca") or k.startswith("template") or k == "dims"
                   for k in keys)
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
.venv\Scripts\python -m pytest tests/test_train_recogniser.py::test_build_dataset_shape tests/test_train_recogniser.py::test_save_model_keys -v
```

Expected: `TypeError` or `ImportError` — `build_dataset` still has the old signature.

- [ ] **Step 3: Replace `build_dataset` in `web/train_recogniser.py`**

Delete the old `build_dataset` function entirely. Replace with:

```python
def build_dataset(
    samples: list[tuple[int, NDArray[np.uint8]]],
    n_dither: int,
) -> tuple[NDArray[np.float64], NDArray[np.int64]]:
    """Augment samples with dithering and extract HOG features.

    Each (digit, img) pair produces n_dither+1 variants (original + n_dither
    augmented copies).  All variants are fed through extract_hog.
    """
    rng = np.random.default_rng(0)
    aug_imgs: list[NDArray[np.uint8]] = []
    aug_labels: list[int] = []

    for digit, img in samples:
        for v in dither(img, n_dither, rng):
            aug_imgs.append((v * 255).clip(0, 255).astype(np.uint8))
            aug_labels.append(digit)

    X = extract_hog(aug_imgs)
    return X, np.array(aug_labels, dtype=np.int64)
```

- [ ] **Step 4: Replace `fit_model` in `web/train_recogniser.py`**

Delete the old `fit_model` function. Replace with:

```python
def fit_model(
    X: NDArray[np.float64],
    y: NDArray[np.int64],
    svm_c: float = SVM_C,
    svm_gamma: float | str = SVM_GAMMA,
) -> dict[str, Any]:
    """Train an RBF SVM directly on HOG feature vectors — no PCA step."""
    svc = SVC(
        kernel="rbf",
        C=svm_c,
        gamma=svm_gamma,
        decision_function_shape="ovo",
    )
    svc.fit(X, y)
    return {"svc": svc}
```

- [ ] **Step 5: Replace `save_model` in `web/train_recogniser.py`**

Delete the old `save_model`. Replace with:

```python
def save_model(
    model: dict[str, Any],
    out_dir: Path,
    confidence_threshold: float = CONFIDENCE_THRESHOLD,
) -> None:
    """Write num_recogniser.{json,bin} with HOG params + SVM weights.

    Array names and layout must match loadNumRecogniser in
    web/src/image/numberRecognition.ts.
    """
    svc: SVC = model["svc"]
    try:
        gamma = float(svc._gamma)
    except AttributeError:
        gamma = 1.0 / (float(svc.support_vectors_.shape[1]) * float(svc.support_vectors_.var()))

    named: list[tuple[str, np.ndarray, str]] = [
        ("hog_win_size",         np.array(HOG_WIN_SIZE,         dtype=np.int32),   "int32"),
        ("hog_cell_size",        np.array(HOG_CELL_SIZE,        dtype=np.int32),   "int32"),
        ("hog_block_size",       np.array(HOG_BLOCK_SIZE,       dtype=np.int32),   "int32"),
        ("hog_block_stride",     np.array(HOG_BLOCK_STRIDE,     dtype=np.int32),   "int32"),
        ("hog_nbins",            np.array(HOG_NBINS,            dtype=np.int32),   "int32"),
        ("confidence_threshold", np.array(confidence_threshold, dtype=np.float64), "float64"),
        ("rbf_support_vectors",  svc.support_vectors_.astype(np.float64),          "float64"),
        ("rbf_dual_coef",        svc.dual_coef_.astype(np.float64),                "float64"),
        ("rbf_intercept",        svc.intercept_.astype(np.float64),                "float64"),
        ("rbf_n_support",        svc.n_support_.astype(np.int32),                  "int32"),
        ("rbf_gamma",            np.array([gamma],              dtype=np.float64), "float64"),
        ("rbf_classes",          svc.classes_.astype(np.int32),                    "int32"),
    ]

    blob = bytearray()
    manifest_arrays: dict[str, dict[str, Any]] = {}
    for name, arr, dtype_str in named:
        data = np.asarray(arr).tobytes()
        manifest_arrays[name] = {
            "dtype": dtype_str,
            "shape": list(np.asarray(arr).shape),
            "offset": len(blob),
            "byteLength": len(data),
        }
        blob.extend(data)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "num_recogniser.bin").write_bytes(bytes(blob))
    (out_dir / "num_recogniser.json").write_text(
        json.dumps({"arrays": manifest_arrays}, indent=2), encoding="utf-8"
    )

    n_sv = svc.support_vectors_.shape[0]
    print(f"\nSaved to {out_dir}/")
    print(f"  HOG: {HOG_WIN_SIZE}px win / {HOG_CELL_SIZE}px cells / {HOG_BLOCK_SIZE}px block / {HOG_NBINS} bins → {HOG_FEAT} features")
    print(f"  SVM: {n_sv} support vectors, classes {svc.classes_.tolist()}")
    print(f"  Bin size: {len(blob):,} bytes")
```

- [ ] **Step 6: Run tests**

```bash
.venv\Scripts\python -m pytest tests/test_train_recogniser.py -v
```

Expected: 4 PASSED (the two new + two from Task 1)

- [ ] **Step 7: Commit**

```bash
git add web/train_recogniser.py tests/test_train_recogniser.py
git commit -m "feat: replace PCA+templates with HOG-SVM in train_recogniser build_dataset/fit_model/save_model"
```

---

### Task 3: Update `main()` and remove dead code

**Files:**
- Modify: `web/train_recogniser.py`

- [ ] **Step 1: Replace `main()` in `web/train_recogniser.py`**

Delete the old `main`. Also delete the functions `load_existing_templates` and `synthesise_missing_templates` — they are no longer called. Replace `main` with:

```python
def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "training_json", nargs="*", type=Path,
        help="Browser-exported training JSON file(s) (optional if synthetic is enabled)",
    )
    parser.add_argument(
        "--out", type=Path, default=Path("web/public"),
        help="Output directory for model files (default: web/public)",
    )
    parser.add_argument(
        "--dither", type=int, default=DEFAULT_DITHER, metavar="N",
        help=f"Augmented variants per source sample (default: {DEFAULT_DITHER})",
    )
    parser.add_argument(
        "--no-synthetic", action="store_true",
        help="Skip system-font synthetic digit generation",
    )
    parser.add_argument(
        "--confidence-threshold", type=float, default=CONFIDENCE_THRESHOLD, metavar="T",
        help=f"OVO vote fraction to mark a read as confident (default: {CONFIDENCE_THRESHOLD})",
    )
    parser.add_argument("--svm-c",     type=float, default=SVM_C,     help=f"SVM C (default: {SVM_C})")
    parser.add_argument("--svm-gamma", type=str,   default=str(SVM_GAMMA),
                        help=f"SVM gamma — float or 'scale'/'auto' (default: {SVM_GAMMA})")
    args = parser.parse_args()

    all_samples: list[tuple[int, NDArray[np.uint8]]] = []

    for path in args.training_json:
        samples = load_training_file(path)
        print(f"Loaded {len(samples)} samples from {path.name}")
        all_samples.extend(samples)

    if not args.no_synthetic:
        print("Generating synthetic font samples…")
        synth = generate_synthetic_samples()
        print(f"Generated {len(synth)} synthetic samples")
        all_samples.extend(synth)

    if not all_samples:
        import sys as _sys
        print("No samples — pass JSON files or omit --no-synthetic.", file=_sys.stderr)
        raise SystemExit(1)

    dist = dict(sorted(Counter(d for d, _ in all_samples).items()))
    print(f"Digit distribution: {dist}")

    print(f"Augmenting with {args.dither} dither variants per sample…")
    X, y = build_dataset(all_samples, args.dither)
    print(f"Dataset: {X.shape[0]} samples × {X.shape[1]} HOG features")

    svm_gamma: float | str = args.svm_gamma
    try:
        svm_gamma = float(args.svm_gamma)
    except ValueError:
        pass  # keep as 'scale' or 'auto'

    print("Training SVM…")
    model = fit_model(X, y, svm_c=args.svm_c, svm_gamma=svm_gamma)

    save_model(model, Path(args.out), confidence_threshold=args.confidence_threshold)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run all tests to confirm nothing broke**

```bash
.venv\Scripts\python -m pytest tests/test_train_recogniser.py -v
```

Expected: 4 PASSED

- [ ] **Step 3: Run the script end-to-end (synthetic only)**

```bash
.venv\Scripts\python web/train_recogniser.py --out web/public --dither 5
```

Expected output ends with something like:
```
HOG: 64px win / 8px cells / 16px block / 9 bins → 1764 features
SVM: N support vectors, classes [1, 2, 3, 4, 5, 6, 7, 8, 9]
Bin size: X bytes
```

The `web/public/num_recogniser.json` must exist afterwards.

- [ ] **Step 4: Verify manifest keys**

```bash
.venv\Scripts\python -c "import json; d=json.load(open('web/public/num_recogniser.json')); print(sorted(d['arrays'].keys()))"
```

Expected (no `pca_*`, no `template_*`, no `dims`):
```
['confidence_threshold', 'hog_block_size', 'hog_block_stride', 'hog_cell_size',
 'hog_nbins', 'hog_win_size', 'rbf_classes', 'rbf_dual_coef', 'rbf_gamma',
 'rbf_intercept', 'rbf_n_support', 'rbf_support_vectors']
```

- [ ] **Step 5: Commit**

```bash
git add web/train_recogniser.py web/public/num_recogniser.bin web/public/num_recogniser.json
git commit -m "feat: update train_recogniser main() — synthetic fonts, HOG, remove templates/PCA"
```

---

## Sprint 2 — TypeScript Inference (~3 h)

### Task 4: Add `HOGDescriptor` to `opencv.ts`

**Files:**
- Modify: `web/src/image/opencv.ts`

- [ ] **Step 1: Verify `HOGDescriptor` is in the custom build**

```bash
cd web && node -e "
const path = require('path');
const { createRequire } = require('module');
// Check the public opencv.js for HOGDescriptor
const src = require('fs').readFileSync('public/opencv.js', 'utf8');
console.log('HOGDescriptor present:', src.includes('HOGDescriptor'));
"
```

If `false`: the custom OpenCV.js build needs to include `objdetect`. Stop and flag to the user before proceeding.

- [ ] **Step 2: Add the interface to `web/src/image/opencv.ts`**

After the `OpenCVSize` interface, add:

```typescript
export interface OpenCVHOGDescriptor {
  compute(img: OpenCVMat, descriptors: OpenCVMat): void;
  delete(): void;
}
```

Inside the `OpenCVModule` interface's `Method` list, add:

```typescript
HOGDescriptor: new (
  winSize: OpenCVSize,
  blockSize: OpenCVSize,
  blockStride: OpenCVSize,
  cellSize: OpenCVSize,
  nbins: number,
) => OpenCVHOGDescriptor;
```

- [ ] **Step 3: Build check**

```bash
cd web && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add web/src/image/opencv.ts
git commit -m "feat: add HOGDescriptor type to OpenCVModule interface"
```

---

### Task 5: Update interfaces in `numberRecognition.ts`

**Files:**
- Modify: `web/src/image/numberRecognition.ts`

- [ ] **Step 1: Replace `PCAModel`, `Templates`, and `NumRecogniser`**

Remove:
- The `PCAModel` interface (properties: `components`, `mean`, `nComponents`, `nFeatures`)
- The `Templates` type alias
- The old `NumRecogniser` interface

Add in their place:

```typescript
export interface HOGParams {
  winSize: number;       // 64
  cellSize: number;      // 8
  blockSize: number;     // 16
  blockStride: number;   // 8
  nbins: number;         // 9
}

export interface NumRecogniser {
  hog: HOGParams;
  rbf: RBFModel;
  confidenceThreshold: number;
}

export interface Recognition {
  label: number;
  confident: boolean;
}
```

- [ ] **Step 2: Build to enumerate breakage**

```bash
cd web && npx tsc --noEmit 2>&1 | head -60
```

Note every error location — they are fixed in Tasks 6–8.

- [ ] **Step 3: Commit the interface change**

```bash
git add web/src/image/numberRecognition.ts
git commit -m "refactor: replace PCAModel+Templates with HOGParams+Recognition in NumRecogniser"
```

---

### Task 6: Add `hogExtract`, replace `pcaTransform`, update `classify`

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Create: `web/src/image/numberRecognition.hog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/image/numberRecognition.hog.test.ts
import { describe, it, expect } from 'vitest';

// Verify the HOG_FEAT formula matches our parameter choice.
// blocksPerDim = (winSize - blockSize) / blockStride + 1 = (64-16)/8+1 = 7
// nFeat = 7 * 7 * (blockSize/cellSize)^2 * nbins = 49 * 4 * 9 = 1764
describe('HOG feature count', () => {
  it('matches 1764 for winSize=64 cellSize=8 blockSize=16 blockStride=8 nbins=9', () => {
    const winSize = 64, blockSize = 16, blockStride = 8, cellSize = 8, nbins = 9;
    const blocksPerDim = (winSize - blockSize) / blockStride + 1;
    const nFeat = blocksPerDim * blocksPerDim * (blockSize / cellSize) ** 2 * nbins;
    expect(nFeat).toBe(1764);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

```bash
cd web && npm test -- numberRecognition.hog
```

Expected: 1 PASSED

- [ ] **Step 3: Delete `pcaTransform`; add `hogExtract`**

Delete the entire `pcaTransform` function. Add in its place:

```typescript
function hogExtract(cv: Cv, imgs: Uint8Array[], params: HOGParams): Float64Array {
  const { winSize, cellSize, blockSize, blockStride, nbins } = params;
  const hog = new cv.HOGDescriptor(
    new cv.Size(winSize, winSize),
    new cv.Size(blockSize, blockSize),
    new cv.Size(blockStride, blockStride),
    new cv.Size(cellSize, cellSize),
    nbins,
  );
  const blocksPerDim = (winSize - blockSize) / blockStride + 1;
  const nFeat = blocksPerDim * blocksPerDim * (blockSize / cellSize) ** 2 * nbins;
  const n = imgs.length;
  const result = new Float64Array(n * nFeat);

  for (let p = 0; p < n; p++) {
    const mat = new cv.Mat(winSize, winSize, cv.CV_8UC1);
    mat.data.set(imgs[p]!);
    const desc = new cv.Mat();
    hog.compute(mat, desc);
    mat.delete();
    for (let f = 0; f < nFeat; f++) result[p * nFeat + f] = desc.data32F[f]!;
    desc.delete();
  }
  hog.delete();
  return result;
}
```

- [ ] **Step 4: Update `classify`**

Replace the existing `classify` function body:

```typescript
function classify(cv: Cv, rec: NumRecogniser, imgs: Uint8Array[]): Recognition[] {
  const n = imgs.length;
  const x = hogExtract(cv, imgs, rec.hog);
  return rbfPredictWithConfidence(rec.rbf, x, n, rec.confidenceThreshold);
}
```

(`rbfPredictWithConfidence` is added in the next task.)

- [ ] **Step 5: Build check**

```bash
cd web && npx tsc --noEmit 2>&1 | grep -v "inpImage\|readClassicDigits" | head -20
```

Expected: only errors about `rbfPredictWithConfidence` not yet defined.

- [ ] **Step 6: Commit**

```bash
git add web/src/image/numberRecognition.ts web/src/image/numberRecognition.hog.test.ts
git commit -m "feat: add hogExtract; replace pcaTransform in classify"
```

---

### Task 7: Add `rbfPredictWithConfidence`; replace `getSums` with `recognise`; update `loadNumRecogniser`

**Files:**
- Modify: `web/src/image/numberRecognition.ts`

- [ ] **Step 1: Add `rbfPredictWithConfidence` alongside existing `rbfPredict`**

The vote loop is identical to `rbfPredict`. The only difference is that instead of returning an `Int32Array` of labels, it returns `Recognition[]` where `confident = bestVotes / totalClassifiers >= threshold`.

```typescript
function rbfPredictWithConfidence(
  model: RBFModel,
  x: Float64Array,
  nSamples: number,
  threshold: number,
): Recognition[] {
  const { supportVectors, dualCoef, intercept, nSupport, gamma,
          classes, nClasses, nSv, nFeatures } = model;

  const k = new Float64Array(nSamples * nSv);
  for (let i = 0; i < nSamples; i++) {
    const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
    let xsq = 0;
    for (let f = 0; f < nFeatures; f++) xsq += xi[f]! * xi[f]!;
    for (let j = 0; j < nSv; j++) {
      const sv = supportVectors.subarray(j * nFeatures, (j + 1) * nFeatures);
      let svsq = 0, dot = 0;
      for (let f = 0; f < nFeatures; f++) { svsq += sv[f]! * sv[f]!; dot += xi[f]! * sv[f]!; }
      k[i * nSv + j] = Math.exp(-gamma * (xsq + svsq - 2 * dot));
    }
  }

  const svEnd = new Int32Array(nClasses);
  svEnd[0] = nSupport[0]!;
  for (let c = 1; c < nClasses; c++) svEnd[c] = svEnd[c - 1]! + nSupport[c]!;
  const svStart = new Int32Array(nClasses);
  for (let c = 1; c < nClasses; c++) svStart[c] = svEnd[c - 1]!;

  const votes = new Int32Array(nSamples * nClasses);
  let clfIdx = 0;
  for (let i = 0; i < nClasses; i++) {
    for (let j = i + 1; j < nClasses; j++) {
      const si = svStart[i]!, ei = svEnd[i]!, sj = svStart[j]!, ej = svEnd[j]!;
      for (let s = 0; s < nSamples; s++) {
        let dec = intercept[clfIdx]!;
        for (let sv = si; sv < ei; sv++) dec += dualCoef[(j - 1) * nSv + sv]! * k[s * nSv + sv]!;
        for (let sv = sj; sv < ej; sv++) dec += dualCoef[i * nSv + sv]! * k[s * nSv + sv]!;
        if (dec > 0) votes[s * nClasses + i]!++; else votes[s * nClasses + j]!++;
      }
      clfIdx++;
    }
  }

  const totalClassifiers = (nClasses * (nClasses - 1)) / 2;
  const result: Recognition[] = [];
  for (let s = 0; s < nSamples; s++) {
    let best = 0;
    for (let c = 1; c < nClasses; c++) {
      if (votes[s * nClasses + c]! > votes[s * nClasses + best]!) best = c;
    }
    const score = votes[s * nClasses + best]! / totalClassifiers;
    result.push({ label: classes[best]!, confident: score >= threshold });
  }
  return result;
}
```

- [ ] **Step 2: Replace `getSums` with `recognise`; remove `paintMask`**

Delete: `getSums`, `paintMask`, `rbfPredict` (old version).

Add:

```typescript
export function recognise(cv: Cv, rec: NumRecogniser, imgs: Uint8Array[]): Recognition[] {
  return classify(cv, rec, imgs);
}
```

- [ ] **Step 3: Rewrite `loadNumRecogniser`**

Replace the entire function body:

```typescript
export function loadNumRecogniser(
  binBuffer: ArrayBuffer,
  manifestJson: { arrays: Record<string, { dtype: string; shape: number[]; offset: number; byteLength: number }> },
): NumRecogniser {
  const arrays = manifestJson.arrays;

  function getF64(name: string): Float64Array {
    const { offset, byteLength } = arrays[name]!;
    if (offset % 8 === 0) return new Float64Array(binBuffer, offset, byteLength / 8);
    return new Float64Array(binBuffer.slice(offset, offset + byteLength));
  }
  function getI32(name: string): Int32Array {
    const { offset, byteLength } = arrays[name]!;
    if (offset % 4 === 0) return new Int32Array(binBuffer, offset, byteLength / 4);
    return new Int32Array(binBuffer.slice(offset, offset + byteLength));
  }
  const scalarI32 = (name: string): number => getI32(name)[0]!;
  const scalarF64 = (name: string): number => getF64(name)[0]!;

  const hog: HOGParams = {
    winSize:     scalarI32('hog_win_size'),
    cellSize:    scalarI32('hog_cell_size'),
    blockSize:   scalarI32('hog_block_size'),
    blockStride: scalarI32('hog_block_stride'),
    nbins:       scalarI32('hog_nbins'),
  };

  const svArr = getF64('rbf_support_vectors');
  const [nSv, nFeatures] = arrays['rbf_support_vectors']!.shape as [number, number];
  const classesArr = getI32('rbf_classes');

  const rbf: RBFModel = {
    supportVectors: svArr,
    dualCoef:       getF64('rbf_dual_coef'),
    intercept:      getF64('rbf_intercept'),
    nSupport:       getI32('rbf_n_support'),
    gamma:          scalarF64('rbf_gamma'),
    classes:        classesArr,
    nClasses:       classesArr.length,
    nSv,
    nFeatures,
  };

  return { hog, rbf, confidenceThreshold: scalarF64('confidence_threshold') };
}
```

- [ ] **Step 4: Build check**

```bash
cd web && npx tsc --noEmit 2>&1 | head -30
```

Expected: only errors in `inpImage.ts` and `readClassicDigits`.

- [ ] **Step 5: Commit**

```bash
git add web/src/image/numberRecognition.ts
git commit -m "feat: add rbfPredictWithConfidence; replace getSums with recognise; update loadNumRecogniser"
```

---

### Task 8: Update callers — `inpImage.ts` and `readClassicDigits`

**Files:**
- Modify: `web/src/image/inpImage.ts`
- Modify: `web/src/image/numberRecognition.ts`

- [ ] **Step 1: Update the import in `inpImage.ts`**

Find:
```typescript
import {
  getSums, splitNum, contourHier, getNumContours, readClassicDigits,
} from './numberRecognition.js';
```

Replace `getSums` with `recognise`:
```typescript
import {
  recognise, splitNum, contourHier, getNumContours, readClassicDigits,
} from './numberRecognition.js';
```

- [ ] **Step 2: Update the call site in `buildCageTotals`**

Find:
```typescript
const ntrs = getSums(cv, rec, sums);
if (ntrs.length > 4) {
  throw new ProcessingError(
    `Too many digits (${ntrs.length}) in cell (row=${row},col=${col})`,
    Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
    brdrs,
  );
}
for (const v of ntrs) {
  if (v >= 0) cageTotals[row]![col] = 10 * cageTotals[row]![col]! + v;
}
```

Replace with:
```typescript
const ntrs = recognise(cv, rec, sums);
if (ntrs.length > 4) {
  throw new ProcessingError(
    `Too many digits (${ntrs.length}) in cell (row=${row},col=${col})`,
    Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
    brdrs,
  );
}
for (const { label, confident } of ntrs) {
  if (!confident) console.warn(`Low-confidence digit in (row=${row},col=${col})`);
  if (label >= 0) cageTotals[row]![col] = 10 * cageTotals[row]![col]! + label;
}
```

- [ ] **Step 3: Update `readClassicDigits` in `numberRecognition.ts`**

Find:
```typescript
const labels = getSums(cv, rec, [thumb]);
const d = labels[0]!;
```

Replace with:
```typescript
const [rec0] = recognise(cv, rec, [thumb]);
const d = rec0!.label;
```

- [ ] **Step 4: Full build — must be clean**

```bash
cd web && npx tsc --noEmit
```

Expected: **0 errors**

- [ ] **Step 5: Run unit tests**

```bash
cd web && npm test
```

Expected: all existing tests pass

- [ ] **Step 6: Commit**

```bash
git add web/src/image/inpImage.ts web/src/image/numberRecognition.ts
git commit -m "feat: wire recognise callers; add low-confidence console.warn"
```

---

## Sprint 3 — Integration & Validation (~1 h)

### Task 9: Browser smoke test

- [ ] **Step 1: Start dev server**

```bash
cd web && npm run dev
```

- [ ] **Step 2: Load a Guardian puzzle**

Open `http://localhost:5173`. Load a Guardian puzzle image. Confirm:
- Board renders correctly
- No JavaScript errors in the browser console
- Cage totals match the expected puzzle

- [ ] **Step 3: Load the Observer puzzle**

Load the Observer puzzle image. Confirm cage totals are read correctly. Note any `console.warn` low-confidence messages.

---

### Task 10: Playwright E2E suite

- [ ] **Step 1: Silver gate**

```bash
cd web && npx tsc --noEmit && npm test -- --reporter=verbose
```

Expected: all unit tests pass

- [ ] **Step 2: Production build Playwright**

```bash
cd web && npx playwright test
```

Expected: `app.spec.ts` and `offline.spec.ts` pass

- [ ] **Step 3: Dev build Playwright**

```bash
cd web && npx playwright test --config playwright.dev.config.ts
```

Expected: `flow.spec.ts` passes

---

### Task 11: Confidence threshold calibration

- [ ] **Step 1: Assess console.warn output from Task 9**

Two possible outcomes:
- **Low-confidence + correct label** → threshold is too strict; retrain with lower value
- **Low-confidence + wrong label** → threshold is working; no change needed

- [ ] **Step 2: Retrain with adjusted threshold if needed**

```bash
.venv\Scripts\python web/train_recogniser.py --out web/public --dither 5 --confidence-threshold 0.6
```

- [ ] **Step 3: Re-run Playwright to confirm no regression**

```bash
cd web && npx playwright test
```

- [ ] **Step 4: Commit final model**

```bash
git add web/public/num_recogniser.bin web/public/num_recogniser.json
git commit -m "chore: ship calibrated HOG-SVM model"
```

---

## Spec coverage self-check

| Spec requirement | Task |
|---|---|
| A — Augmentation (scale, shear, stroke, blur) | Task 1 (`dither` kept; scale/shear in `generate_synthetic_samples` render sizes) |
| B — Synthetic fonts via `matplotlib.font_manager` at 32/48/64 pt | Task 1 |
| C — HOG features replace raw-pixel PCA | Tasks 1, 6, 7 |
| Remove template fast-path | Task 7 (`getSums`, `paintMask` deleted) |
| `NumRecogniser` holds `HOGParams` + confidence | Task 5 |
| `Recognition` interface with `label` + `confident` | Task 5 |
| `hogExtract` via `cv.HOGDescriptor` | Task 6 |
| `rbfPredict` extended to return confidence | Task 7 |
| `recognise()` replaces `getSums()` | Tasks 7–8 |
| `loadNumRecogniser` reads HOG scalars | Task 7 |
| Low-confidence `console.warn` in callers | Task 8 |
| Playwright E2E on guardian/observer puzzle set | Tasks 10–11 |
| Revert trigger: regression on known fonts | Task 10 (Playwright is the gate) |

**Note on augmentation scope:** The spec called for scale ±20% and shear ±8° in `augment.py`. In this plan those transforms are provided implicitly by the synthetic font renderer (rendering at three sizes covers scale variation) and by the existing `dither` function (translation, erosion/dilation, noise). The spec's shear transform is not explicitly present — if coverage proves insufficient after testing, add `cv2.warpAffine` shear to `dither` as a follow-up.
