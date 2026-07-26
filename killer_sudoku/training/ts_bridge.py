"""Thin Python wrapper around web/scripts/ts-bridge.ts.

Every function here shells out to the real TypeScript implementation rather
than reimplementing feature extraction or classification in Python -- see
docs/superpowers/specs/2026-07-26-ts-single-source-of-truth-design.md.
Failure (bad exit code, unparseable output) always raises; there is
deliberately no fallback path.
"""
import json
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BRIDGE_SCRIPT = _REPO_ROOT / "web" / "scripts" / "ts-bridge.ts"


def _run_bridge(op: str, payload: dict[str, Any], extra_args: list[str] | None = None) -> dict[str, Any]:
    args = ["npx", "tsx", str(_BRIDGE_SCRIPT), "--op", op, *(extra_args or [])]
    result = subprocess.run(
        args,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=_REPO_ROOT / "web",
        shell=True,
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


def extract_features(
    crops: Sequence[npt.NDArray[np.uint8]],
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    payload = {"crops": [c.flatten().tolist() for c in crops]}
    out = _run_bridge("extract-features", payload)
    hog = np.array(out["hog"], dtype=np.float64)
    hole = np.array(out["hole"], dtype=np.float64)
    return hog, hole


def predict(
    crops: Sequence[npt.NDArray[np.uint8]], model_bin: Path, model_json: Path,
) -> list[dict[str, Any]]:
    # Resolve relative to the repo root (not cwd) -- _run_bridge invokes the
    # subprocess with cwd=web/, so a bare relative path like
    # "web/public/num_recogniser.bin" would otherwise double up.
    model_bin_abs = model_bin if model_bin.is_absolute() else (_REPO_ROOT / model_bin)
    model_json_abs = model_json if model_json.is_absolute() else (_REPO_ROOT / model_json)
    payload = {"crops": [c.flatten().tolist() for c in crops]}
    out = _run_bridge(
        "predict", payload,
        extra_args=["--model-bin", str(model_bin_abs), "--model-json", str(model_json_abs)],
    )
    predictions: list[dict[str, Any]] = out["predictions"]
    return predictions
