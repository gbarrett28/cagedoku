#!/usr/bin/env python3
"""
Retrain the web digit recogniser from browser-exported training JSON files.

Merges new labelled samples (exported by the "Export training data" button
in the web app) with per-digit mean templates from the existing model, applies
dithering to augment both sources, fits PCA + RBF-SVM, and writes the updated
model to web/dist/num_recogniser.{json,bin}.

Usage
-----
    python web/train_recogniser.py TRAINING_JSON [...]

    # Specify a different output directory:
    python web/train_recogniser.py --out web/dist training-*.json

    # Skip loading existing templates (retrain from new data only):
    python web/train_recogniser.py --no-templates training.json

    # More augmentation (default 30 variants per source sample):
    python web/train_recogniser.py --dither 50 training.json

Examples
--------
    python web/train_recogniser.py ~/Downloads/training-2026-04-29T19-46-44.json

Workflow
--------
After running this script, the updated model is live immediately (no rebuild
needed): reload the web app in the browser and the new model is fetched.

Model format
------------
The binary format is documented in web/src/image/numberRecognition.ts
(loadNumRecogniser).  Arrays are written in the order listed in pack_arrays()
below; the JSON manifest records each array's name, dtype, shape, byte offset,
and byte length.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import cv2  # type: ignore[import-untyped]
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
    """Extract HOG feature vectors from win_size×win_size uint8 images.

    Uses cv2.HOGDescriptor with identical parameters to the browser's
    cv.HOGDescriptor — guarantees training/inference feature parity.
    Each image produces a HOG_FEAT-dimensional float64 vector.
    """
    hog = cv2.HOGDescriptor(
        (HOG_WIN_SIZE,     HOG_WIN_SIZE),
        (HOG_BLOCK_SIZE,   HOG_BLOCK_SIZE),
        (HOG_BLOCK_STRIDE, HOG_BLOCK_STRIDE),
        (HOG_CELL_SIZE,    HOG_CELL_SIZE),
        HOG_NBINS,
    )
    rows: list[NDArray[np.float64]] = []
    for img in imgs:
        desc = hog.compute(img)          # shape (HOG_FEAT, 1)
        rows.append(desc.flatten().astype(np.float64))
    return np.array(rows, dtype=np.float64)


def load_existing_templates(
    json_path: Path, bin_path: Path
) -> dict[int, NDArray[np.float32]]:
    """Read per-digit mean template images from the existing model files.

    These are the float32 64×64 arrays stored as template_0…template_9 in
    the binary model.  They are used as anchor training examples for any
    digit class absent from the new labelled samples.

    Templates with near-uniform ink (> 95% filled) are rejected as corrupted
    — this prevents a bad template from self-reinforcing across retraining
    rounds via dithering.
    """
    if not json_path.exists() or not bin_path.exists():
        return {}

    manifest: dict[str, Any] = json.loads(
        json_path.read_text(encoding="utf-8")
    )["arrays"]
    blob = bin_path.read_bytes()

    templates: dict[int, NDArray[np.float32]] = {}
    for d in range(N_DIGITS):
        key = f"template_{d}"
        if key not in manifest:
            continue
        info = manifest[key]
        raw = blob[info["offset"] : info["offset"] + info["byteLength"]]
        arr = np.frombuffer(raw, dtype=np.float32).reshape(info["shape"]).copy()
        ink = float((arr > 0.3).mean())
        if ink > 0.95:
            print(f"  Rejecting template_{d}: ink={ink:.1%} (corrupted — all white)")
            continue
        templates[d] = arr
    return templates


def synthesise_missing_templates(
    templates: dict[int, NDArray[np.float32]],
    new_sample_digits: set[int],
) -> dict[int, NDArray[np.float32]]:
    """Fill in templates for digits that have neither real samples nor a usable
    template, using simple geometric relationships between digits:

    - 6 ≈ 180° rotation of 9 (loop at bottom instead of top)

    Only applied when the digit is completely absent from new training data.
    """
    result = dict(templates)

    if 6 not in new_sample_digits and 6 not in result:
        if 9 in result:
            result[6] = np.rot90(result[9], k=2).copy()
            print("  Synthesised template_6 from template_9 (180° rotation)")
        else:
            print("  Warning: no template or samples for digit 6 and no template_9 to derive from")

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


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# I/O — saving
# ---------------------------------------------------------------------------

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
        gamma = float(svc._gamma)  # computed value; available after fit()
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
        json.dumps({"arrays": manifest_arrays}, indent=2), encoding="utf-8"
    )

    n_sv = svc.support_vectors_.shape[0]
    print(f"\nSaved to {out_dir}/")
    print(f"  HOG: {HOG_WIN_SIZE}px win / {HOG_CELL_SIZE}px cells / {HOG_BLOCK_SIZE}px block / {HOG_NBINS} bins → {HOG_FEAT} features")
    print(f"  SVM: {n_sv} support vectors, classes {svc.classes_.tolist()}")
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
        "training_json", nargs="+", type=Path,
        help="Browser-exported training JSON file(s)",
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
        "--no-templates", action="store_true",
        help="Skip loading existing model templates (retrain from new data only)",
    )
    args = parser.parse_args()

    # ── Load new training samples ──────────────────────────────────────────
    all_samples: list[tuple[int, NDArray[np.uint8]]] = []
    for path in args.training_json:
        samples = load_training_file(path)
        print(f"Loaded {len(samples)} samples from {path.name}")
        all_samples.extend(samples)

    if not all_samples:
        print("No samples found — nothing to do.", file=__import__("sys").stderr)
        raise SystemExit(1)

    dist = dict(sorted(Counter(d for d, _ in all_samples).items()))
    print(f"Digit distribution in new data: {dist}")

    # ── Load existing templates ────────────────────────────────────────────
    templates: dict[int, NDArray[np.float32]] = {}
    if not args.no_templates:
        tmpl_json = args.out / "num_recogniser.json"
        tmpl_bin = args.out / "num_recogniser.bin"
        templates = load_existing_templates(tmpl_json, tmpl_bin)
        covered_by_new = {d for d, _ in all_samples}
        templates = synthesise_missing_templates(templates, covered_by_new)
        if templates:
            template_only = sorted(set(range(N_DIGITS)) - covered_by_new)
            print(f"Loaded/synthesised templates: {sorted(templates.keys())}")
            print(f"Template-only coverage (absent from new data): {template_only}")

    # ── Build augmented dataset and train ─────────────────────────────────
    print(f"\nAugmenting with {args.dither} variants per source sample…")
    X, y = build_dataset(all_samples, templates, args.dither)
    aug_dist = dict(sorted(Counter(y.tolist()).items()))
    print(f"Augmented dataset: {len(X)} total samples")
    print(f"Per-class counts:  {aug_dist}")

    print("\nFitting PCA + RBF SVM…")
    model = fit_model(X, y)

    save_model(model, args.out)


if __name__ == "__main__":
    main()
