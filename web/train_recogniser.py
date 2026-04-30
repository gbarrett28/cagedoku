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

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import binary_dilation, binary_erosion, shift
from sklearn.decomposition import PCA
from sklearn.svm import SVC

# ---------------------------------------------------------------------------
# Constants — must match the TypeScript pipeline (web/src/image/config.ts)
# ---------------------------------------------------------------------------

THUMBNAIL_SIZE = 64        # splitNum output: 64×64 binary image per digit
N_DIGITS = 10              # digits 0–9
DEFAULT_DITHER = 30        # augmented variants per source sample
VARIANCE_THRESHOLD = 0.99  # minimum cumulative PCA variance to retain
TEMPLATE_THRESHOLD = 0.7   # matchTemplate score above which template wins
SVM_C = 5.0
SVM_GAMMA = "scale"


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
    new_samples: list[tuple[int, NDArray[np.uint8]]],
    templates: dict[int, NDArray[np.float32]],
    n_dither: int,
) -> tuple[NDArray[np.float64], NDArray[np.int64]]:
    """Build an augmented (X, y) dataset from new samples and existing templates.

    For each digit class:
    - New labelled samples are each dithered to produce n_dither+1 variants.
    - The existing model template (mean image) is dithered to produce a further
      n_dither+1 variants — this fills in digit classes absent from new_samples
      and adds prior knowledge from the historical training set.

    The result is class-balanced in the sense that every digit has at least
    n_dither+1 examples (from the template), even if it never appeared in the
    new training file.
    """
    rng = np.random.default_rng(0)

    X_parts: list[NDArray[np.float64]] = []
    y_parts: list[NDArray[np.int64]] = []

    new_by_digit: dict[int, list[NDArray[np.uint8]]] = {}
    for digit, img in new_samples:
        new_by_digit.setdefault(digit, []).append(img)

    for d in range(N_DIGITS):
        variants: list[NDArray[np.float64]] = []

        for img in new_by_digit.get(d, []):
            variants.extend(dither(img, n_dither, rng))

        if d in templates:
            tmpl_u8 = (templates[d] * 255).clip(0, 255).astype(np.uint8)
            variants.extend(dither(tmpl_u8, n_dither, rng))

        if not variants:
            continue

        X_parts.append(np.stack([v.flatten() for v in variants]))
        y_parts.append(np.full(len(variants), d, dtype=np.int64))

    return np.concatenate(X_parts), np.concatenate(y_parts)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def fit_model(
    X: NDArray[np.float64], y: NDArray[np.int64]
) -> dict[str, Any]:
    """Fit PCA + RBF SVM and collect template images.

    PCA is fitted on the per-class mean images (T2 pipeline convention from
    docs/image-pipeline.md).  The number of components kept is the minimum
    that explains VARIANCE_THRESHOLD of cumulative variance.
    """
    classes = sorted(set(y.tolist()))
    n_classes = len(classes)

    means = np.array([X[y == c].mean(axis=0) for c in classes])
    pca = PCA(n_components=n_classes)
    pca.fit(means)

    cumvar = np.cumsum(pca.explained_variance_ratio_)
    dims = int(np.searchsorted(cumvar, VARIANCE_THRESHOLD) + 1)
    dims = max(2, min(dims, n_classes))

    X_pca = pca.transform(X)[:, :dims]

    svc = SVC(
        kernel="rbf",
        C=SVM_C,
        gamma=SVM_GAMMA,
        decision_function_shape="ovo",
    )
    svc.fit(X_pca, y)

    # Per-digit mean templates for fast template-matching at inference.
    templates_out: dict[int, NDArray[np.float32]] = {}
    for c in range(N_DIGITS):
        mask = y == c
        if mask.any():
            tmpl = X[mask].mean(axis=0).reshape(THUMBNAIL_SIZE, THUMBNAIL_SIZE)
        else:
            tmpl = np.zeros((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
        templates_out[c] = tmpl.astype(np.float32)

    return {
        "pca": pca,
        "dims": dims,
        "svc": svc,
        "X_pca": X_pca,
        "classes": classes,
        "templates": templates_out,
    }


# ---------------------------------------------------------------------------
# I/O — saving
# ---------------------------------------------------------------------------

def save_model(model: dict[str, Any], out_dir: Path) -> None:
    """Write num_recogniser.json (manifest) and num_recogniser.bin (arrays).

    The binary layout must match the array names and dtypes expected by
    loadNumRecogniser in web/src/image/numberRecognition.ts.
    """
    pca: PCA = model["pca"]
    svc: SVC = model["svc"]
    dims: int = model["dims"]
    X_pca: NDArray[np.float64] = model["X_pca"]

    # Compute the effective gamma that sklearn used (gamma='scale').
    try:
        gamma = float(svc._gamma)  # available after fit(); sklearn >= 0.22
    except AttributeError:
        gamma = 1.0 / (float(X_pca.shape[1]) * float(X_pca.var()))

    # Arrays in the order they appear in the binary file.
    named: list[tuple[str, np.ndarray, str]] = [
        ("pca_components",      pca.components_.astype(np.float64), "float64"),
        ("pca_mean",            pca.mean_.astype(np.float64),       "float64"),
        ("dims",                np.array([dims], dtype=np.int32),   "int32"),
        ("rbf_support_vectors", svc.support_vectors_.astype(np.float64), "float64"),
        ("rbf_dual_coef",       svc.dual_coef_.astype(np.float64),  "float64"),
        ("rbf_intercept",       svc.intercept_.astype(np.float64),  "float64"),
        ("rbf_n_support",       svc.n_support_.astype(np.int32),    "int32"),
        ("rbf_gamma",           np.array([gamma], dtype=np.float64),"float64"),
        ("rbf_classes",         svc.classes_.astype(np.int32),      "int32"),
        ("template_threshold",
         np.array([TEMPLATE_THRESHOLD], dtype=np.float64),          "float64"),
    ]
    for d, tmpl in sorted(model["templates"].items()):
        named.append((f"template_{d}", tmpl, "float32"))

    blob = bytearray()
    manifest_arrays: dict[str, dict[str, Any]] = {}

    for name, arr, dtype_str in named:
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
    print(f"  PCA:       {pca.components_.shape[0]} components, {dims} active dims")
    print(f"  SVM:       {n_sv} support vectors, classes {svc.classes_.tolist()}")
    print(f"  Templates: digits 0–9 ({THUMBNAIL_SIZE}×{THUMBNAIL_SIZE} float32)")
    print(f"  Bin size:  {len(blob):,} bytes")


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
