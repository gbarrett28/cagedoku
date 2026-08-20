"""Thin Python wrapper around web/scripts/ts-bridge.ts.

Every function here shells out to the real TypeScript implementation rather
than reimplementing feature extraction or classification in Python -- see
docs/superpowers/specs/2026-07-26-ts-single-source-of-truth-design.md.
Failure (bad exit code, unparseable output) always raises; there is
deliberately no fallback path.
"""
import json
import os
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import numpy.typing as npt


@dataclass(frozen=True)
class RawDigitCrop:
    """Strategy-neutral bounding-box pixels copied from the warped grid."""

    pixels: npt.NDArray[np.uint8]


_REPO_ROOT = Path(__file__).resolve().parents[2]
_BRIDGE_SCRIPT = _REPO_ROOT / "web" / "scripts" / "ts-bridge.ts"

# Node's fs.readFileSync has a hard ~536MB (0x1fffffe8 char) string-length
# ceiling. A flattened 64x64 uint8 crop as JSON is ~4 bytes/pixel worst case
# (values 0-255 plus separators), so one crop is ~16KB -- this keeps a batch's
# JSON payload comfortably under that ceiling (~80MB) with headroom, while
# still batching (never one bridge call per crop).
_BATCH_SIZE = 5000

RecognitionInputMode = Literal["binary", "gray"]


def _run_bridge(op: str, payload: dict[str, Any]) -> dict[str, Any]:
    bridge_args = ["npx", "tsx", str(_BRIDGE_SCRIPT), "--op", op]
    args = (
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", *bridge_args]
        if os.name == "nt"
        else bridge_args
    )
    result = subprocess.run(
        args,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=_REPO_ROOT / "web",
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ts-bridge --op {op} failed (exit {result.returncode}): {result.stderr}"
        )
    try:
        parsed: dict[str, Any] = json.loads(result.stdout)
        return parsed
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"ts-bridge --op {op} produced unparseable output: {result.stdout!r}"
        ) from exc

def warp_crops(
    crops: Sequence[RawDigitCrop],
    strategy: Literal["stretch", "letterbox", "letterbox-centered"],
    size: int = 64,
    input_mode: RecognitionInputMode = "binary",
) -> npt.NDArray[np.uint8]:
    """Warp raw crops in batches using the production TypeScript implementation."""
    if strategy not in ("stretch", "letterbox", "letterbox-centered"):
        raise ValueError(f"unsupported warp strategy: {strategy}")
    if input_mode not in ("binary", "gray"):
        raise ValueError(f"unsupported recognition input mode: {input_mode}")
    if size <= 0:
        raise ValueError(f"warp size must be positive, got {size}")

    chunks: list[npt.NDArray[np.uint8]] = []
    for i in range(0, len(crops), _BATCH_SIZE):
        batch = crops[i : i + _BATCH_SIZE]
        encoded: list[dict[str, Any]] = []
        for crop in batch:
            pixels = crop.pixels
            if pixels.ndim != 2:
                raise ValueError(f"raw crop pixels must be two-dimensional, got shape {pixels.shape}")
            height, width = pixels.shape
            if width <= 0 or height <= 0:
                raise ValueError(f"raw crop dimensions must be positive, got {width}x{height}")
            if pixels.dtype != np.uint8:
                raise ValueError(f"raw crop pixels must have dtype uint8, got {pixels.dtype}")
            encoded.append({
                "width": width,
                "height": height,
                "pixels": pixels.ravel().tolist(),
            })

        out = _run_bridge(
            "warp-crops",
            {
                "crops": encoded,
                "strategy": strategy,
                "inputMode": input_mode,
                "size": size,
            },
        )
        rows = out.get("crops")
        if not isinstance(rows, list) or len(rows) != len(batch):
            raise RuntimeError("ts-bridge --op warp-crops returned an invalid crop count")
        if any(not isinstance(row, list) or len(row) != size * size for row in rows):
            raise RuntimeError("ts-bridge --op warp-crops returned a non-square crop")
        array = np.asarray(rows)
        if np.any(array < 0) or np.any(array > 255):
            raise RuntimeError("ts-bridge --op warp-crops returned pixels outside uint8 range")
        chunks.append(array.astype(np.uint8).reshape(len(batch), size, size))

    if not chunks:
        return np.zeros((0, size, size), dtype=np.uint8)
    return np.concatenate(chunks)


def extract_features(
    crops: Sequence[npt.NDArray[np.uint8]],
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    hog_chunks: list[npt.NDArray[np.float64]] = []
    hole_chunks: list[npt.NDArray[np.float64]] = []
    aspect_chunks: list[npt.NDArray[np.float64]] = []
    for i in range(0, len(crops), _BATCH_SIZE):
        batch = crops[i : i + _BATCH_SIZE]
        payload = {"crops": [c.flatten().tolist() for c in batch]}
        out = _run_bridge("extract-features", payload)
        hog_chunks.append(np.array(out["hog"], dtype=np.float64))
        hole_chunks.append(np.array(out["hole"], dtype=np.float64))
        aspect_chunks.append(np.array(out["aspect"], dtype=np.float64))
    if not hog_chunks:
        empty = np.zeros((0, 0), dtype=np.float64)
        return empty, empty, np.zeros((0,), dtype=np.float64)
    return np.concatenate(hog_chunks), np.concatenate(hole_chunks), np.concatenate(aspect_chunks)


