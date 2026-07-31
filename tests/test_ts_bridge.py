from typing import Any

import numpy as np
import pytest

from killer_sudoku.training import ts_bridge
from killer_sudoku.training.ts_bridge import (
    RawDigitCrop,
    extract_features,
    warp_crops,
)


def test_extract_features_returns_correct_shapes() -> None:
    crops = [np.zeros((64, 64), dtype=np.uint8), np.zeros((64, 64), dtype=np.uint8)]
    hog, hole, aspect = extract_features(crops)
    assert hog.shape == (2, 1764)
    assert hole.shape == (2, 5)
    assert aspect.shape == (2,)


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
            "aspect": [float(i) * 100 for i in range(n)],
        }

    monkeypatch.setattr(ts_bridge, "_run_bridge", fake_run_bridge)
    crops = [np.full((64, 64), i, dtype=np.uint8) for i in range(5)]

    hog, hole, aspect = extract_features(crops)

    assert calls == [2, 2, 1]
    assert hog[:, 0].tolist() == [0.0, 1.0, 0.0, 1.0, 0.0]
    assert hole[:, 0].tolist() == [0.0, 10.0, 0.0, 10.0, 0.0]
    assert aspect.tolist() == [0.0, 100.0, 0.0, 100.0, 0.0]


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


