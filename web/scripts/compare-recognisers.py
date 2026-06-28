#!/usr/bin/env python3
"""Compare two num_recogniser models on harvested training samples.

Usage (from repo root):
  python3 web/scripts/compare-recognisers.py \
    --model-a web/public/num_recogniser      \
    --model-b /tmp/master_recogniser         \
    --label-a current --label-b master       \
    web/scripts/harvested_samples.json       \
    web/scripts/harvested_samples_guardian.json \
    web/scripts/harvested_samples_guardian2.json

Each --model-* argument is a path prefix; the script appends .json and .bin.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

# Import feature extractors from the training script.
sys.path.insert(0, str(Path(__file__).parent.parent))
import train_recogniser as tr


def load_model(prefix: str) -> dict[str, Any]:
    manifest: dict[str, Any] = json.loads(Path(prefix + ".json").read_text())
    blob = Path(prefix + ".bin").read_bytes()
    arrays: dict[str, Any] = {}
    for name, meta in manifest["arrays"].items():
        dtype = np.dtype(meta["dtype"])
        shape = tuple(meta["shape"])
        offset = meta["offset"]
        length = meta["byteLength"]
        arrays[name] = np.frombuffer(blob[offset:offset + length], dtype=dtype).reshape(shape)
    return {"kind": manifest["classifier_type"], **arrays}


def ovo_predict(features: np.ndarray[Any, Any], model: dict[str, Any]) -> np.ndarray[Any, Any]:
    """One-vs-one majority vote prediction."""
    classes = model["classes"]          # shape (n_classes,)
    coef = model["linear_coef"]         # shape (n_pairs, n_features)
    intercept = model["linear_intercept"]  # shape (n_pairs,)
    n = len(features)
    k = len(classes)
    votes = np.zeros((n, k), dtype=np.int32)

    pair = 0
    for i in range(k):
        for j in range(i + 1, k):
            scores = features @ coef[pair] + intercept[pair]
            votes[:, i] += (scores > 0).astype(np.int32)
            votes[:, j] += (scores <= 0).astype(np.int32)
            pair += 1

    result: np.ndarray[Any, Any] = classes[np.argmax(votes, axis=1)]
    return result


def load_samples(paths: list[str]) -> tuple[list[int], np.ndarray[Any, Any]]:
    labels, pixels = [], []
    for p in paths:
        data = json.loads(Path(p).read_text())
        for s in data["samples"]:
            labels.append(s["digit"])
            pixels.append(s["pixels"])
    imgs = np.array(pixels, dtype=np.uint8).reshape(-1, 64, 64)
    return labels, imgs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-a", required=True)
    ap.add_argument("--model-b", required=True)
    ap.add_argument("--label-a", default="model-a")
    ap.add_argument("--label-b", default="model-b")
    ap.add_argument("sample_files", nargs="+")
    args = ap.parse_args()

    print("Loading models…")
    model_a = load_model(args.model_a)
    model_b = load_model(args.model_b)

    print("Loading samples…")
    labels, imgs = load_samples(args.sample_files)
    n = len(labels)
    print(f"  {n} samples loaded")

    print("Extracting HOG features…")
    hog = tr.extract_hog(imgs, n_jobs=-1)
    hole = tr.extract_hole_features(imgs)
    features = np.hstack([hog, hole])

    print("Running predictions…")
    pred_a = ovo_predict(features, model_a)
    pred_b = ovo_predict(features, model_b)

    correct = np.array(labels)
    acc_a = np.mean(pred_a == correct)
    acc_b = np.mean(pred_b == correct)

    print(f"\n{'='*60}")
    print("Accuracy on harvested misread samples:")
    print(f"  {args.label_a}: {acc_a:.1%} ({np.sum(pred_a == correct)}/{n})")
    print(f"  {args.label_b}: {acc_b:.1%} ({np.sum(pred_b == correct)}/{n})")

    disagree = pred_a != pred_b
    print(f"\nDisagreements between models: {disagree.sum()}/{n}")

    if disagree.any():
        print(f"\n{'correct':>8}  {'label-a':>8}  {'label-b':>8}  {'a-ok':>5}  {'b-ok':>5}")
        print("-" * 45)
        for i in np.where(disagree)[0]:
            c = correct[i]
            a = pred_a[i]
            b = pred_b[i]
            print(f"{c:>8}  {a:>8}  {b:>8}  {'ok' if a==c else '--':>5}  {'ok' if b==c else '--':>5}")

    print("\nPer-digit accuracy:")
    print(f"  {'digit':>6}  {args.label_a:>10}  {args.label_b:>10}  {'count':>6}")
    for d in sorted(set(labels)):
        mask = correct == d
        cnt = mask.sum()
        ok_a = (pred_a[mask] == d).sum()
        ok_b = (pred_b[mask] == d).sum()
        print(f"  {d:>6}  {ok_a}/{cnt:>{len(str(cnt))+2}}  {ok_b}/{cnt:>{len(str(cnt))+2}}")


if __name__ == "__main__":
    main()
