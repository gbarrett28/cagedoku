#!/usr/bin/env python3
"""Train a binary SVM: 1-digit vs 2-digits in a cage-total thumbnail.

Uses the same 64x64 HOG features as the digit recogniser.  Synthetic training
data is augmented by real-world splitSamples from browser-exported training
JSON files (produced by the app when the user confirms a corrected puzzle).

Usage (from project root):
    python web/train_split_recogniser.py --data-dirs guardian observer --out web/public
    python web/train_split_recogniser.py --data-dirs guardian observer --out web/public \
        --real-samples web/browser_train.json  --real-weight 100
"""
from __future__ import annotations
import argparse, json, pickle, sys
from pathlib import Path
import numpy as np
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).parent))
from train_recogniser import (
    HOG_BLOCK_SIZE, HOG_BLOCK_STRIDE, HOG_CELL_SIZE,
    HOG_NBINS, HOG_WIN_SIZE, THUMBNAIL_SIZE, extract_hog,
)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_singles(data_dirs):
    """Load (label, 64x64 uint8) pairs from numerals.pkl, digits 1-9 only."""
    samples = []
    for d in data_dirs:
        pkl = d / "numerals.pkl"
        if not pkl.exists():
            print(f"  Skipping {d}: numerals.pkl not found"); continue
        with open(pkl, "rb") as f:
            raw = pickle.load(f)
        kept = [(label, img) for label, img in raw if 1 <= label <= 9]
        print(f"  {d}: {len(raw)} total, {len(kept)} kept (digits 1-9)")
        samples.extend(kept)
    return samples


def load_real_split_samples(json_paths):
    """Load splitSamples from browser-exported training JSON files."""
    samples = []
    for path in json_paths:
        data = json.loads(path.read_text(encoding="utf-8"))
        for s in data.get("splitSamples", []):
            count = int(s["splitCount"])
            img = np.array(s["pixels"], dtype=np.uint8).reshape(THUMBNAIL_SIZE, THUMBNAIL_SIZE)
            samples.append((count, img))
        n = len(data.get("splitSamples", []))
        if n:
            print(f"  {path.name}: {n} real split samples")
    return samples


# ---------------------------------------------------------------------------
# Synthetic pair generation
# ---------------------------------------------------------------------------

def make_pair(img_a, img_b, split_w, size=THUMBNAIL_SIZE):
    from PIL import Image
    w2 = size - split_w
    a = np.array(Image.fromarray(img_a).resize((split_w, size), Image.LANCZOS), dtype=np.uint8)
    b = np.array(Image.fromarray(img_b).resize((w2,     size), Image.LANCZOS), dtype=np.uint8)
    canvas = np.zeros((size, size), dtype=np.uint8)
    canvas[:, :split_w] = a
    canvas[:, split_w:] = b
    return canvas


def build_pairs(samples, n_pairs, rng):
    imgs = [img for _, img in samples]
    n = len(imgs)
    out = []
    for _ in range(n_pairs):
        ia, ib = int(rng.integers(n)), int(rng.integers(n))
        sw = int(rng.integers(round(THUMBNAIL_SIZE * 0.30), round(THUMBNAIL_SIZE * 0.70) + 1))
        out.append(make_pair(imgs[ia], imgs[ib], sw))
    return out


# ---------------------------------------------------------------------------
# Model saving (same bin+json format as num_recogniser)
# ---------------------------------------------------------------------------

def save_model(coef, intercept, out_dir):
    named = [
        ("hog_win_size",         np.array(HOG_WIN_SIZE,     dtype=np.int32),  "int32"),
        ("hog_cell_size",        np.array(HOG_CELL_SIZE,    dtype=np.int32),  "int32"),
        ("hog_block_size",       np.array(HOG_BLOCK_SIZE,   dtype=np.int32),  "int32"),
        ("hog_block_stride",     np.array(HOG_BLOCK_STRIDE, dtype=np.int32),  "int32"),
        ("hog_nbins",            np.array(HOG_NBINS,        dtype=np.int32),  "int32"),
        ("confidence_threshold", np.array(0.5,              dtype=np.float64),"float64"),
        ("classes",              np.array([1, 2],           dtype=np.int32),  "int32"),
        # Negated vs sklearn: ovoVote score>0 -> classes[0]=1 (one digit).
        ("linear_coef",          coef.reshape(1, -1).astype(np.float64),     "float64"),
        ("linear_intercept",     intercept.reshape(1).astype(np.float64),    "float64"),
    ]
    blob, arrays = bytearray(), {}
    for name, arr, dtype in named:
        data = np.asarray(arr).tobytes()
        arrays[name] = {"dtype": dtype, "shape": list(np.asarray(arr).shape),
                        "offset": len(blob), "byteLength": len(data)}
        blob.extend(data)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "split_recogniser.bin").write_bytes(bytes(blob))
    (out_dir / "split_recogniser.json").write_text(
        json.dumps({"classifier_type": "linear", "arrays": arrays}, indent=2), encoding="utf-8")
    print(f"Saved {out_dir}/split_recogniser.{{json,bin}}  ({len(blob):,} bytes)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-dirs",    nargs="+", type=Path, default=[Path("guardian"), Path("observer")])
    p.add_argument("--out",          type=Path, default=Path("web/public"))
    p.add_argument("--n-pairs",      type=int,  default=20_000)
    p.add_argument("--n-single",     type=int,  default=20_000)
    p.add_argument("--svm-c",        type=float,default=1.0)
    p.add_argument("--seed",         type=int,  default=42)
    p.add_argument("--real-samples", nargs="*", type=Path, default=[],
                   help="Browser-exported training JSON files containing splitSamples")
    p.add_argument("--real-weight",  type=float, default=100.0,
                   help="Sample weight for real-world split samples (default: 100)")
    args = p.parse_args()

    rng = np.random.default_rng(args.seed)

    print("Loading single-digit samples…")
    singles = load_singles(args.data_dirs)
    if not singles:
        print("No data — check --data-dirs."); raise SystemExit(1)
    print(f"  Total: {len(singles)}")

    idx = rng.permutation(len(singles))[:args.n_single]
    neg_imgs = [singles[i][1] for i in idx]

    print(f"Generating {args.n_pairs} synthetic two-digit pairs…")
    pos_imgs = build_pairs(singles, args.n_pairs, rng)

    all_imgs    = neg_imgs + pos_imgs
    all_labels  = [1] * len(neg_imgs) + [2] * len(pos_imgs)
    all_weights = [1.0] * len(all_imgs)

    # Augment with real-world confirmed samples (heavily upweighted).
    real = load_real_split_samples(args.real_samples) if args.real_samples else []
    if real:
        real_imgs   = [img for _, img in real]
        real_labels = [cnt for cnt, _ in real]
        all_imgs    += real_imgs
        all_labels  += real_labels
        all_weights += [args.real_weight] * len(real)
        print(f"  Added {len(real)} real split samples (weight={args.real_weight}×)")

    print(f"Dataset: {all_labels.count(1)} neg + {all_labels.count(2)} pos"
          + (f" + {len(real)} real" if real else ""))

    print("Extracting HOG features…")
    X = extract_hog(all_imgs)
    y = np.array(all_labels, dtype=np.int32)
    w = np.array(all_weights, dtype=np.float64)
    print(f"  X: {X.shape}")

    print(f"Training LinearSVC (C={args.svm_c})…")
    from sklearn.svm import LinearSVC
    clf = LinearSVC(C=args.svm_c, max_iter=10_000)
    clf.fit(X, y, sample_weight=w)
    print(f"  Train accuracy: {(clf.predict(X)==y).mean():.4f}")

    save_model(-clf.coef_[0], np.array([-clf.intercept_[0]]), args.out)


if __name__ == "__main__":
    main()
