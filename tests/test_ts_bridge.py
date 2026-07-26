from pathlib import Path

import numpy as np

from killer_sudoku.training.ts_bridge import extract_features, predict


def test_extract_features_returns_correct_shapes() -> None:
    crops = [np.zeros((64, 64), dtype=np.uint8), np.zeros((64, 64), dtype=np.uint8)]
    hog, hole = extract_features(crops)
    assert hog.shape == (2, 1764)
    assert hole.shape == (2, 5)


def test_predict_returns_one_result_per_crop() -> None:
    crops = [np.zeros((64, 64), dtype=np.uint8)]
    results = predict(
        crops,
        Path("web/public/num_recogniser.bin"),
        Path("web/public/num_recogniser.json"),
    )
    assert len(results) == 1
    assert isinstance(results[0]["label"], int)
    assert isinstance(results[0]["confident"], bool)


def test_predict_surfaces_bridge_failure_as_an_error() -> None:
    crops = [np.zeros((64, 64), dtype=np.uint8)]
    try:
        predict(crops, Path("does/not/exist.bin"), Path("does/not/exist.json"))
        raised = False
    except RuntimeError:
        raised = True
    assert raised, "predict() must raise, never silently fall back"
