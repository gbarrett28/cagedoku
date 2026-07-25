"""Trains PCA/HOG x stretch/letterbox combinations.

Evaluates all four on same-distribution and cross-font holdouts.
"""

import argparse
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "web"))
from train_recogniser import DEFAULT_DITHER, HogRecogniser, PcaRbfRecogniser, dither_batch

from killer_sudoku.training.agreement_pool import AgreedSample, build_agreement_pool
from killer_sudoku.training.balanced_sample import balanced_split
from killer_sudoku.training.synthetic_holdout import generate_cross_font_holdout

_WIN_SIZE = 64


def _warp_all(crops: list[npt.NDArray[np.uint8]], warp_fn: Any) -> npt.NDArray[np.uint8]:
    return np.stack([warp_fn(0, 0, c.shape[1], c.shape[0], c, _WIN_SIZE) for c in crops])


def _predict(model: dict[str, Any], features: npt.NDArray[np.float64]) -> npt.NDArray[np.int64]:
    """Dispatch prediction on a fit() result.

    PcaRbfRecogniser.fit and HogRecogniser.fit return differently-shaped
    dicts (PCA does its own internal PCA-transform at predict time; HOG's
    SVC operates directly on the raw HOG+hole feature vector).
    """
    if "svc" in model:
        pca = model["pca"]
        dims = model["dims"]
        result: npt.NDArray[np.int64] = model["svc"].predict(pca.transform(features)[:, :dims])
        return result
    clf_result: npt.NDArray[np.int64] = model["clf"].predict(features)
    return clf_result


def _accuracy(
    crops: list[npt.NDArray[np.uint8]],
    labels: npt.NDArray[np.int64],
    warp_fn: Any,
    recogniser: Any,
    model: dict[str, Any],
) -> float:
    if not crops:
        return float("nan")
    warped = _warp_all(crops, warp_fn)
    preds = _predict(model, recogniser.extract_features(warped))
    return float((preds == labels).mean())


def train_and_evaluate(
    train: list[tuple[int, npt.NDArray[np.uint8]]],
    holdout: list[tuple[int, npt.NDArray[np.uint8]]],
    cross_font: list[tuple[int, npt.NDArray[np.uint8]]],
    dither_variants: int = DEFAULT_DITHER,
) -> dict[str, dict[str, float]]:
    train_labels = np.array([label for label, _ in train], dtype=np.int64)
    train_crops = [crop for _, crop in train]
    holdout_labels = np.array([label for label, _ in holdout], dtype=np.int64)
    holdout_crops = [crop for _, crop in holdout]
    cross_font_labels = np.array([label for label, _ in cross_font], dtype=np.int64)
    cross_font_crops = [crop for _, crop in cross_font]

    combinations = {
        "pca_stretch": (PcaRbfRecogniser(), PcaRbfRecogniser().warp_from_rect),
        "pca_letterbox": (PcaRbfRecogniser(), HogRecogniser().warp_from_rect),
        "hog_stretch": (HogRecogniser(), PcaRbfRecogniser().warp_from_rect),
        "hog_letterbox": (HogRecogniser(), HogRecogniser().warp_from_rect),
    }

    results: dict[str, dict[str, float]] = {}
    for name, (recogniser, warp_fn) in combinations.items():
        warped_train = _warp_all(train_crops, warp_fn)
        # Dither training data only -- never the holdouts, which must stay
        # unaugmented for the evaluation to mean anything. Matches the
        # historical training pipeline's use of dither_batch to multiply a
        # small set of real crops into a denser training distribution;
        # skipping this was found to be a major contributor to poor
        # same-distribution accuracy in the first (undithered) run.
        rng = np.random.default_rng(0)
        samples_with_weight = [(label, img, 1.0) for (label, _), img in zip(train, warped_train, strict=True)]
        dithered_imgs, dithered_labels, _weights = dither_batch(samples_with_weight, dither_variants, rng)
        dithered_labels_arr = np.array(dithered_labels, dtype=np.int64)

        features = recogniser.extract_features(dithered_imgs)
        model = recogniser.fit(features, dithered_labels_arr, None)

        # Train-set self-accuracy (predicting the exact real, un-dithered
        # crops the model was fit on) -- a low value here (much below ~90%)
        # is a strong signal of label noise in the training set itself, not
        # a generalization gap: a model that can't even fit its own training
        # labels well isn't going to be fixed by more data or augmentation.
        train_accuracy = _accuracy(train_crops, train_labels, warp_fn, recogniser, model)

        results[name] = {
            "train_accuracy": train_accuracy,
            "same_dist_accuracy": _accuracy(
                holdout_crops, holdout_labels, warp_fn, recogniser, model
            ),
            "cross_font_accuracy": _accuracy(
                cross_font_crops, cross_font_labels, warp_fn, recogniser, model
            ),
        }
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Only process the first N images per corpus (for a fast pilot run)",
    )
    args = parser.parse_args()

    all_samples: list[AgreedSample] = []
    with tempfile.TemporaryDirectory(prefix="pca_hog_scratch_") as scratch:
        # build_agreement_pool requires rework=True, which re-writes
        # .jpk/status.pkl in whatever directory it's pointed at -- never point
        # it at guardian/observer/classic_guardian/classic_observer directly,
        # always a scratch copy.
        #
        # classic_guardian/easy only: its other difficulty subdirectories
        # (medium/hard/expert/other) reuse the same filenames, which would
        # collide when flattened into scratch_dir.
        for corpus_name, corpus_dir in [
            ("guardian", Path("guardian")),
            ("observer", Path("observer")),
            ("classic_guardian", Path("classic_guardian/easy")),
            ("classic_observer", Path("classic_observer")),
        ]:
            scratch_dir = Path(scratch) / corpus_name
            scratch_dir.mkdir()
            images = sorted(corpus_dir.glob("*.jpg"))
            if args.limit is not None:
                images = images[: args.limit]
            for img in images:
                shutil.copy(img, scratch_dir / img.name)
            all_samples.extend(build_agreement_pool(scratch_dir, corpus_name))

        split = balanced_split(all_samples, per_digit=100, holdout_fraction=0.2, seed=0)
        train = [(s.label, s.crop) for s in split.train]
        holdout = [(s.label, s.crop) for s in split.holdout]

    cross_font = generate_cross_font_holdout()

    results = train_and_evaluate(train, holdout, cross_font)

    lines = ["# PCA/HOG Combination Results\n"]
    lines.append(
        f"Training set: {len(train)} samples. Same-distribution holdout: {len(holdout)}. "
        f"Cross-font holdout: {len(cross_font)}.\n"
    )
    lines.append("| Combination | Train accuracy | Same-distribution accuracy | Cross-font accuracy |")
    lines.append("|---|---|---|---|")
    for name, r in results.items():
        lines.append(
            f"| {name} | {r['train_accuracy']:.4f} | {r['same_dist_accuracy']:.4f} "
            f"| {r['cross_font_accuracy']:.4f} |"
        )
    Path("docs/pca-hog-combination-results.md").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
