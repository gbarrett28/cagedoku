#!/usr/bin/env python3
"""
Train the web digit recogniser using HOG features + LinearSVC.

Generates synthetic digit images from system fonts, optionally merges
browser-exported labelled samples, augments all sources with dithering,
extracts HOG features (identical to hogExtract in numberRecognition.ts),
and writes the trained model to web/public/.

Usage
-----
    # Standard retrain from accumulated browser training data:
    python web/train_recogniser.py --out web/public --browser-weight 1000 --svm-c 100 web/browser_train.json

    # Train from synthetic fonts only (no puzzle data needed):
    python web/train_recogniser.py --out web/public

    # Skip synthetic font generation:
    python web/train_recogniser.py --no-synthetic web/browser_train.json

    # Asymmetric dithering (more browser variants, fewer synthetic):
    python web/train_recogniser.py --dither 200 --synth-dither 5 web/browser_train.json

Workflow
--------
1. Export training data from the browser (OCR review screen → Export Training).
2. Run the merge step to add it to web/browser_train.json (or provide the
   exported JSON directly as an additional positional argument).
3. Run this script with --browser-weight 1000 --svm-c 100.
4. The updated model is live immediately: reload the web app.

Model format
------------
The binary layout is documented in web/src/image/numberRecognition.ts
(loadNumRecogniser).  The JSON manifest records each array's name, dtype,
shape, byte offset, and byte length.

Sample weights
--------------
--browser-weight upweights browser-exported samples relative to synthetic
font samples.  With ~9k synthetic samples and ~66 browser samples, auto-
balance (weight=0) sets weight≈137; weight=1000 gives browser samples
strong priority without causing SVM convergence problems (unlike weight>2000).
--svm-c 100 (vs default 10) enforces a harder margin, ensuring all browser
samples are correctly classified even when they fall near the boundary.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import binary_dilation, binary_erosion, shift
from sklearn.svm import SVC

# ---------------------------------------------------------------------------
# Constants — must match the TypeScript pipeline (web/src/image/numberRecognition.ts)
# ---------------------------------------------------------------------------

THUMBNAIL_SIZE = 64        # splitNum output: 64×64 binary image per digit
N_DIGITS = 10              # digits 0–9
DEFAULT_DITHER = 30        # augmented variants per source sample
CONFIDENCE_THRESHOLD = 0.7 # OVO vote fraction to mark a read as confident
SVM_C = 10.0
SVM_GAMMA = 0.01

# HOG descriptor parameters — identical values used in cv.HOGDescriptor (TypeScript).
HOG_WIN_SIZE     = 64
HOG_CELL_SIZE    = 8
HOG_BLOCK_SIZE   = 16
HOG_BLOCK_STRIDE = 8
HOG_NBINS        = 9
# ((64-16)/8+1)^2 * (16/8)^2 * 9 = 7^2 * 4 * 9
HOG_FEAT         = 1764


# ---------------------------------------------------------------------------
# I/O — loading
# ---------------------------------------------------------------------------

def load_training_file(path: Path) -> list[tuple[int, NDArray[np.uint8]]]:
    """Load (digit, 64×64 uint8) samples from one browser-exported JSON.

    The JSON is produced by web/src/image/trainingExport.ts and contains
    one sample per extracted digit contour, labelled with the user-verified
    cage total.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    samples: list[tuple[int, NDArray[np.uint8]]] = []
    for s in data["samples"]:
        digit = int(s["digit"])
        img = np.array(s["pixels"], dtype=np.uint8).reshape(
            THUMBNAIL_SIZE, THUMBNAIL_SIZE
        )
        samples.append((digit, img))
    return samples


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
    import matplotlib.font_manager as fm  # type: ignore[import-untyped]
    from PIL import Image, ImageDraw, ImageFont  # type: ignore[import-untyped]

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
    """Extract HOG feature vectors matching the TypeScript hogExtract implementation.

    Uses: centered differences (clamped at borders), unsigned gradients via
    atan2(|Gy|, Gx) mod 180, nearest-bin voting, L2 block normalisation.
    Both this function and hogExtract in numberRecognition.ts perform identical
    floating-point operations, guaranteeing training/inference feature parity.
    """
    n = len(imgs)
    n_cells = HOG_WIN_SIZE // HOG_CELL_SIZE                             # 8
    cpb = HOG_BLOCK_SIZE // HOG_CELL_SIZE                               # cells per block side = 2
    n_blocks = (HOG_WIN_SIZE - HOG_BLOCK_SIZE) // HOG_BLOCK_STRIDE + 1 # 7
    bin_width = 180.0 / HOG_NBINS                                       # 20.0°
    eps = 1e-6
    result = np.zeros((n, HOG_FEAT), dtype=np.float64)

    for idx, img in enumerate(imgs):
        f = img.astype(np.float32)

        # Centered differences with clamped borders.
        Gx = np.empty_like(f)
        Gy = np.empty_like(f)
        Gx[:, 1:-1] = f[:, 2:] - f[:, :-2]
        Gx[:, 0]    = f[:, 1]  - f[:, 0]
        Gx[:, -1]   = f[:, -1] - f[:, -2]
        Gy[1:-1, :] = f[2:, :] - f[:-2, :]
        Gy[0, :]    = f[1, :]  - f[0, :]
        Gy[-1, :]   = f[-1, :] - f[-2, :]

        mag = np.sqrt(Gx ** 2 + Gy ** 2)
        # Unsigned angle in [0, 180): atan2(|Gy|, Gx) → degrees → mod 180.
        ang = np.degrees(np.arctan2(np.abs(Gy), Gx)) % 180.0
        bins = (ang / bin_width).astype(np.int32) % HOG_NBINS

        # Cell histograms — vectorised over cells.
        cell_hists = np.zeros((n_cells, n_cells, HOG_NBINS), dtype=np.float32)
        for cy in range(n_cells):
            for cx in range(n_cells):
                y0, x0 = cy * HOG_CELL_SIZE, cx * HOG_CELL_SIZE
                np.add.at(
                    cell_hists[cy, cx],
                    bins[y0:y0 + HOG_CELL_SIZE, x0:x0 + HOG_CELL_SIZE].ravel(),
                    mag [y0:y0 + HOG_CELL_SIZE, x0:x0 + HOG_CELL_SIZE].ravel(),
                )

        # Block descriptors with L2 normalisation.
        feat_idx = 0
        for by in range(n_blocks):
            for bx in range(n_blocks):
                block = cell_hists[by:by + cpb, bx:bx + cpb].ravel().astype(np.float64)
                norm = np.sqrt(np.dot(block, block) + eps * eps)
                result[idx, feat_idx:feat_idx + len(block)] = block / norm
                feat_idx += len(block)

    return result


# ---------------------------------------------------------------------------
# Augmentation
# ---------------------------------------------------------------------------

def dither(
    img: NDArray[np.uint8],
    n_variants: int,
    rng: np.random.Generator,
) -> list[NDArray[np.float64]]:
    """Return n_variants augmented copies of a binary 64×64 digit image.

    Each variant applies a random combination of:
    - Translation: ±2 px in x and y
    - Morphological step: erosion, dilation, or none (thin / thicken stroke)
    - Pixel noise: ~1% random flips

    The original image is included as variant 0.
    """
    base = (img > 0).astype(float)
    variants: list[NDArray[np.float64]] = [base]

    for _ in range(n_variants):
        dx = int(rng.integers(-2, 3))
        dy = int(rng.integers(-2, 3))
        v = shift(base, (dy, dx), mode="constant", cval=0.0)

        op = int(rng.integers(3))  # 0=none 1=erode 2=dilate
        if op == 1:
            v = binary_erosion(v > 0.5).astype(float)
        elif op == 2:
            v = binary_dilation(v > 0.5).astype(float)

        noise_mask = rng.random(v.shape) < 0.01
        v = np.where(noise_mask, 1.0 - v, v)
        variants.append(v)

    return variants


# ---------------------------------------------------------------------------
# Dataset construction
# ---------------------------------------------------------------------------

def build_dataset(
    samples: list[tuple[int, NDArray[np.uint8]]],
    n_dither: int,
    sample_weights: list[float] | None = None,
) -> tuple[NDArray[np.float64], NDArray[np.int64], NDArray[np.float64]]:
    """Augment samples with dithering and extract HOG features.

    Each (digit, img) pair produces n_dither+1 variants (original + n_dither
    augmented copies).  All variants are fed through extract_hog.

    sample_weights assigns a per-source weight (before augmentation); all
    augmented variants from a source share the same weight.  None means 1.0
    for all samples.  Returns (X, y, weights).
    """
    rng = np.random.default_rng(0)
    aug_imgs: list[NDArray[np.uint8]] = []
    aug_labels: list[int] = []
    aug_weights: list[float] = []

    for i, (digit, img) in enumerate(samples):
        w = sample_weights[i] if sample_weights is not None else 1.0
        for v in dither(img, n_dither, rng):
            aug_imgs.append((v * 255).clip(0, 255).astype(np.uint8))
            aug_labels.append(digit)
            aug_weights.append(w)

    X = extract_hog(aug_imgs)
    return X, np.array(aug_labels, dtype=np.int64), np.array(aug_weights, dtype=np.float64)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def fit_model(
    X: NDArray[np.float64],
    y: NDArray[np.int64],
    classifier: str = "linear",
    svm_c: float = SVM_C,
    svm_gamma: float | str = SVM_GAMMA,
    sample_weights: NDArray[np.float64] | None = None,
) -> dict[str, Any]:
    """Train a digit classifier on HOG feature vectors.

    classifier='linear': OneVsOneClassifier(LinearSVC) — small model (~500 KB),
        fast inference, vote-fraction confidence identical to RBF OVO.
    classifier='rbf': SVC(kernel='rbf') OVO — more expressive but large model.

    sample_weights, if provided, is passed to clf.fit() to upweight specific
    samples (e.g. browser-exported samples vs synthetic font samples).
    """
    if classifier == "linear":
        import sklearn  # type: ignore[import-untyped]
        from sklearn.multiclass import OneVsOneClassifier  # type: ignore[import-untyped]
        from sklearn.svm import LinearSVC  # type: ignore[import-untyped]
        sklearn.set_config(enable_metadata_routing=True)
        base = LinearSVC(C=svm_c, max_iter=10000).set_fit_request(sample_weight=True)
        clf = OneVsOneClassifier(base, n_jobs=-1)
        clf.fit(X, y, sample_weight=sample_weights)
        # Negate: LinearSVC uses score>0→classes_[1] (higher class), but the
        # TypeScript ovoVote loop uses score>0→class at lower index (i).
        # Negating here makes both conventions consistent.
        coefs = np.vstack([-est.coef_[0] for est in clf.estimators_])
        intercepts = np.array([-est.intercept_[0] for est in clf.estimators_])
        return {"kind": "linear", "clf": clf, "coefs": coefs, "intercepts": intercepts}
    else:
        svc = SVC(kernel="rbf", C=svm_c, gamma=svm_gamma, decision_function_shape="ovo")
        svc.fit(X, y, sample_weight=sample_weights)
        return {"kind": "rbf", "clf": svc}


# ---------------------------------------------------------------------------
# I/O — saving
# ---------------------------------------------------------------------------

def save_model(
    model: dict[str, Any],
    out_dir: Path,
    confidence_threshold: float = CONFIDENCE_THRESHOLD,
) -> None:
    """Write num_recogniser.{json,bin} with HOG params + classifier weights.

    The manifest top-level includes 'classifier_type' so loadNumRecogniser in
    web/src/image/numberRecognition.ts can select the right inference path.
    Common arrays (hog_*, confidence_threshold, classes) are always present.
    Classifier-specific arrays (linear_coef/intercept or rbf_*) follow.
    """
    kind: str = model["kind"]
    clf = model["clf"]

    common: list[tuple[str, np.ndarray, str]] = [
        ("hog_win_size",         np.array(HOG_WIN_SIZE,         dtype=np.int32),   "int32"),
        ("hog_cell_size",        np.array(HOG_CELL_SIZE,        dtype=np.int32),   "int32"),
        ("hog_block_size",       np.array(HOG_BLOCK_SIZE,       dtype=np.int32),   "int32"),
        ("hog_block_stride",     np.array(HOG_BLOCK_STRIDE,     dtype=np.int32),   "int32"),
        ("hog_nbins",            np.array(HOG_NBINS,            dtype=np.int32),   "int32"),
        ("confidence_threshold", np.array(confidence_threshold, dtype=np.float64), "float64"),
        ("classes",              clf.classes_.astype(np.int32),                    "int32"),
    ]

    if kind == "linear":
        coefs: NDArray[np.float64] = model["coefs"]
        intercepts: NDArray[np.float64] = model["intercepts"]
        classifier_arrays: list[tuple[str, np.ndarray, str]] = [
            ("linear_coef",      coefs.astype(np.float64),       "float64"),
            ("linear_intercept", intercepts.astype(np.float64),   "float64"),
        ]
        size_info = f"  Linear OVO: {len(clf.estimators_)} classifiers x {coefs.shape[1]} features"
    else:
        svc: SVC = clf
        try:
            gamma = float(svc._gamma)
        except AttributeError:
            gamma = 1.0 / (float(svc.support_vectors_.shape[1]) * float(svc.support_vectors_.var()))
        classifier_arrays = [
            ("rbf_support_vectors", svc.support_vectors_.astype(np.float64), "float64"),
            ("rbf_dual_coef",       svc.dual_coef_.astype(np.float64),       "float64"),
            ("rbf_intercept",       svc.intercept_.astype(np.float64),       "float64"),
            ("rbf_n_support",       svc.n_support_.astype(np.int32),         "int32"),
            ("rbf_gamma",           np.array([gamma], dtype=np.float64),     "float64"),
        ]
        size_info = f"  RBF OVO: {svc.support_vectors_.shape[0]} support vectors"

    named = common + classifier_arrays
    blob = bytearray()
    manifest_arrays: dict[str, dict[str, Any]] = {}
    for name, arr, dtype_str in named:
        arr = np.asarray(arr)
        data = arr.tobytes()
        manifest_arrays[name] = {
            "dtype": dtype_str,
            "shape": list(arr.shape),
            "offset": len(blob),
            "byteLength": len(data),
        }
        blob.extend(data)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "num_recogniser.bin").write_bytes(bytes(blob))
    (out_dir / "num_recogniser.json").write_text(
        json.dumps({"classifier_type": kind, "arrays": manifest_arrays}, indent=2),
        encoding="utf-8",
    )

    print(f"\nSaved to {out_dir}/ [{kind}]")
    print(f"  HOG: {HOG_WIN_SIZE}px win / {HOG_CELL_SIZE}px cells / {HOG_BLOCK_SIZE}px block / {HOG_NBINS} bins = {HOG_FEAT} features")
    print(size_info)
    print(f"  Bin size: {len(blob):,} bytes")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

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
    parser.add_argument(
        "--classifier", choices=["linear", "rbf"], default="linear",
        help="Classifier type: 'linear' (OVO LinearSVC, default) or 'rbf' (OVO SVC)",
    )
    parser.add_argument("--svm-c",     type=float, default=SVM_C,
                        help=f"SVM regularisation C (default: {SVM_C})")
    parser.add_argument("--svm-gamma", type=str,   default=str(SVM_GAMMA),
                        help=f"SVM gamma — float or 'scale'/'auto'; rbf only (default: {SVM_GAMMA})")
    parser.add_argument(
        "--synth-dither", type=int, default=-1, metavar="N",
        help="Dither variants for synthetic samples; -1 = same as --dither (default: -1)",
    )
    parser.add_argument(
        "--browser-weight", type=float, default=0.0, metavar="W",
        help="Per-sample weight for browser-exported samples (uniform dither path only; 0 = auto-balance)",
    )
    args = parser.parse_args()

    all_samples: list[tuple[int, NDArray[np.uint8]]] = []

    for path in args.training_json:
        samples = load_training_file(path)
        print(f"Loaded {len(samples)} samples from {path.name}")
        all_samples.extend(samples)

    n_browser = len(all_samples)  # count before adding synthetic

    if not args.no_synthetic:
        print("Generating synthetic font samples…")
        synth = generate_synthetic_samples()
        print(f"Generated {len(synth)} synthetic samples")
        all_samples.extend(synth)

    if not all_samples:
        import sys as _sys
        print("No samples — pass JSON files or omit --no-synthetic.", file=_sys.stderr)
        raise SystemExit(1)

    n_synth = len(all_samples) - n_browser
    dist = dict(sorted(Counter(d for d, _ in all_samples).items()))
    print(f"Digit distribution: {dist}")

    # When --synth-dither is set, use different dither counts for browser vs
    # synthetic samples so browser samples dominate by count (not by extreme
    # weights that cause SVM convergence problems).
    synth_dither = args.synth_dither if args.synth_dither >= 0 else args.dither
    if n_browser > 0 and n_synth > 0 and synth_dither != args.dither:
        rng = np.random.default_rng(0)
        aug_imgs: list[NDArray[np.uint8]] = []
        aug_labels: list[int] = []
        for digit, img in all_samples[:n_browser]:
            for v in dither(img, args.dither, rng):
                aug_imgs.append((v * 255).clip(0, 255).astype(np.uint8))
                aug_labels.append(digit)
        for digit, img in all_samples[n_browser:]:
            for v in dither(img, synth_dither, rng):
                aug_imgs.append((v * 255).clip(0, 255).astype(np.uint8))
                aug_labels.append(digit)
        n_browser_aug = n_browser * (args.dither + 1)
        n_synth_aug   = n_synth   * (synth_dither + 1)
        print(f"Dither: browser {args.dither} variants ({n_browser_aug} aug), synth {synth_dither} variants ({n_synth_aug} aug)")
        X = extract_hog(aug_imgs)
        y = np.array(aug_labels, dtype=np.int64)
        weights: NDArray[np.float64] | None = None
    else:
        # Uniform dither; use sample_weight to balance browser vs synthetic.
        sample_weights: list[float] | None = None
        if n_browser > 0 and n_synth > 0:
            bw = args.browser_weight if args.browser_weight > 0 else float(n_synth) / n_browser
            sample_weights = [bw] * n_browser + [1.0] * n_synth
            print(f"Browser sample weight: {bw:.1f}× ({n_browser} browser, {n_synth} synthetic)")
        X, y, weights = build_dataset(all_samples, args.dither, sample_weights)

    print(f"Dataset: {X.shape[0]} samples × {X.shape[1]} HOG features")

    svm_gamma: float | str = args.svm_gamma
    try:
        svm_gamma = float(args.svm_gamma)
    except ValueError:
        pass  # keep as 'scale' or 'auto'

    print(f"Training {args.classifier} classifier…")
    model = fit_model(
        X, y,
        classifier=args.classifier,
        svm_c=args.svm_c,
        svm_gamma=svm_gamma,
        sample_weights=weights,
    )

    save_model(model, Path(args.out), confidence_threshold=args.confidence_threshold)


if __name__ == "__main__":
    main()
