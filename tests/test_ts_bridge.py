from pathlib import Path
from typing import Any

import numpy as np
import pytest

from killer_sudoku.training import ts_bridge
from killer_sudoku.training.ts_bridge import RawDigitCrop, extract_features, predict, solve, warp_crops

KNOWN_SOLUTION = [
    [5, 3, 4, 6, 7, 8, 9, 1, 2],
    [6, 7, 2, 1, 9, 5, 3, 4, 8],
    [1, 9, 8, 3, 4, 2, 5, 6, 7],
    [8, 5, 9, 7, 6, 1, 4, 2, 3],
    [4, 2, 6, 8, 5, 3, 7, 9, 1],
    [7, 1, 3, 9, 2, 4, 8, 5, 6],
    [9, 6, 1, 5, 3, 7, 2, 8, 4],
    [2, 8, 7, 4, 1, 9, 6, 3, 5],
    [3, 4, 5, 2, 8, 6, 1, 7, 9],
]


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


def test_extract_features_chunks_large_inputs_across_multiple_bridge_calls(monkeypatch: Any) -> None:
    # Node's fs.readFileSync has a hard ~536MB string-length ceiling -- a full
    # training run's worth of crops (tens of thousands of 64x64 images) blows
    # right through it in a single JSON payload. Regression test for that:
    # force a tiny batch size and confirm large inputs get split into multiple
    # bridge calls, with results concatenated back in the original order.
    monkeypatch.setattr(ts_bridge, "_BATCH_SIZE", 2)
    calls: list[int] = []

    def fake_run_bridge(_op: str, payload: dict[str, Any], _extra_args: list[str] | None = None) -> dict[str, Any]:
        n = len(payload["crops"])
        calls.append(n)
        return {
            "hog": [[float(i)] for i in range(n)],
            "hole": [[float(i) * 10] for i in range(n)],
        }

    monkeypatch.setattr(ts_bridge, "_run_bridge", fake_run_bridge)
    crops = [np.full((64, 64), i, dtype=np.uint8) for i in range(5)]

    hog, hole = extract_features(crops)

    assert calls == [2, 2, 1]
    assert hog[:, 0].tolist() == [0.0, 1.0, 0.0, 1.0, 0.0]
    assert hole[:, 0].tolist() == [0.0, 10.0, 0.0, 10.0, 0.0]


def test_warp_crops_chunks_large_inputs_and_preserves_order(monkeypatch: Any) -> None:
    monkeypatch.setattr(ts_bridge, "_BATCH_SIZE", 2)
    calls: list[int] = []

    def fake_run_bridge(_op: str, payload: dict[str, Any], _extra_args: list[str] | None = None) -> dict[str, Any]:
        assert payload["strategy"] == "letterbox"
        assert payload["size"] == 2
        batch = payload["crops"]
        calls.append(len(batch))
        return {"crops": [[crop["pixels"][0]] * 4 for crop in batch]}

    monkeypatch.setattr(ts_bridge, "_run_bridge", fake_run_bridge)
    crops = [RawDigitCrop(np.full((2, 3), i, dtype=np.uint8)) for i in range(5)]

    warped = warp_crops(crops, "letterbox", size=2)

    assert calls == [2, 2, 1]
    assert warped.shape == (5, 2, 2)
    assert warped[:, 0, 0].tolist() == [0, 1, 2, 3, 4]


def test_warp_crops_rejects_invalid_crop_shapes() -> None:
    with pytest.raises(ValueError, match="two-dimensional"):
        warp_crops([RawDigitCrop(np.zeros((2, 3, 1), dtype=np.uint8))], "stretch")
    with pytest.raises(ValueError, match="positive"):
        warp_crops([RawDigitCrop(np.zeros((0, 3), dtype=np.uint8))], "stretch")


def test_warp_crops_surfaces_bridge_failure(monkeypatch: Any) -> None:
    def fail_bridge(_op: str, _payload: dict[str, Any], _extra_args: list[str] | None = None) -> dict[str, Any]:
        raise RuntimeError("bridge failed")

    monkeypatch.setattr(ts_bridge, "_run_bridge", fail_bridge)

    with pytest.raises(RuntimeError, match="bridge failed"):
        warp_crops([RawDigitCrop(np.zeros((2, 3), dtype=np.uint8))], "stretch")


def test_predict_chunks_large_inputs_across_multiple_bridge_calls(monkeypatch: Any) -> None:
    monkeypatch.setattr(ts_bridge, "_BATCH_SIZE", 2)
    calls: list[int] = []

    def fake_run_bridge(_op: str, payload: dict[str, Any], extra_args: list[str] | None = None) -> dict[str, Any]:
        del extra_args
        n = len(payload["crops"])
        calls.append(n)
        return {"predictions": [{"label": i, "confident": True, "runnerUp": None} for i in range(n)]}

    monkeypatch.setattr(ts_bridge, "_run_bridge", fake_run_bridge)
    crops = [np.full((64, 64), i, dtype=np.uint8) for i in range(5)]

    results = predict(crops, Path("model.bin"), Path("model.json"))

    assert calls == [2, 2, 1]
    assert [r["label"] for r in results] == [0, 1, 0, 1, 0]


def test_solve_matches_known_solution_for_a_trivial_one_cell_per_cage_spec() -> None:
    payload = {
        "regions": np.arange(1, 82, dtype=np.intp).reshape(9, 9).tolist(),
        "cageTotals": KNOWN_SOLUTION,
        "borderX": np.ones((9, 8), dtype=np.bool_).tolist(),
        "borderY": np.ones((8, 9), dtype=np.bool_).tolist(),
    }

    result = solve(payload)

    assert result["solved"] is True
    assert result["board"] == KNOWN_SOLUTION
