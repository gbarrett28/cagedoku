import json as _json
from pathlib import Path

import numpy as np
import numpy.typing as npt

from killer_sudoku.training.hog_model_loader import (
    HogNumber,
    LinearOvOClassifier,
    load_hog_classifier,
)


def test_linear_ovo_classifier_two_class_separable() -> None:
    # 3 classes, 2 features. sklearn's SVC(decision_function_shape='ovo')
    # convention: classifier k separates class i (positive) from class j
    # (negative) for pair (i, j) with i < j, in row-major pair order.
    classifier = LinearOvOClassifier(
        coef=np.array([
            [1.0, 0.0],  # pair (0, 1)
            [1.0, 0.0],  # pair (0, 2)
            [1.0, 0.0],  # pair (1, 2)
        ]),
        intercept=np.array([0.0, 0.0, 0.0]),
        classes=np.array([0, 1, 2]),
        n_classifiers=3,
        n_features=2,
    )
    x = np.array([[10.0, 0.0], [-10.0, 0.0], [0.1, 0.0]])
    labels = classifier.predict(x)
    assert labels.shape == (3,)
    assert labels[0] == 0


def _stretch_warp(img: npt.NDArray[np.uint8]) -> npt.NDArray[np.uint8]:
    # browser_train.json's samples are pre-warped 64x64 thumbnails already.
    return img


def test_recovered_hog_model_matches_documented_accuracy() -> None:
    hog_params, classifier, _threshold = load_hog_classifier(
        Path("killer_sudoku/data/hog_recogniser_99cbb70.bin"),
        Path("killer_sudoku/data/hog_recogniser_99cbb70.json"),
    )
    recogniser = HogNumber(hog_params, classifier, _stretch_warp)

    data = _json.loads(Path("web/browser_train.json").read_text(encoding="utf-8"))
    samples = data["samples"] if isinstance(data, dict) else data
    labels = np.array([s["digit"] for s in samples], dtype=np.intp)
    imgs: list[npt.NDArray[np.uint8]] = [
        np.array(s["pixels"], dtype=np.uint8).reshape(64, 64) for s in samples
    ]

    predictions = recogniser.get_sums(imgs)
    correct = int((predictions == labels).sum())
    total = len(labels)
    accuracy = correct / total
    assert accuracy >= 0.95, f"Recovered model only {accuracy:.4f} ({correct}/{total}) — loader or port is wrong"
