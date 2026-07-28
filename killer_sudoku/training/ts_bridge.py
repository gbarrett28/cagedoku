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

from killer_sudoku.solver.puzzle_spec import PuzzleSpec

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BRIDGE_SCRIPT = _REPO_ROOT / "web" / "scripts" / "ts-bridge.ts"

# Node's fs.readFileSync has a hard ~536MB (0x1fffffe8 char) string-length
# ceiling. A flattened 64x64 uint8 crop as JSON is ~4 bytes/pixel worst case
# (values 0-255 plus separators), so one crop is ~16KB -- this keeps a batch's
# JSON payload comfortably under that ceiling (~80MB) with headroom, while
# still batching (never one bridge call per crop).
_BATCH_SIZE = 5000


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
    hog_chunks: list[npt.NDArray[np.float64]] = []
    hole_chunks: list[npt.NDArray[np.float64]] = []
    for i in range(0, len(crops), _BATCH_SIZE):
        batch = crops[i : i + _BATCH_SIZE]
        payload = {"crops": [c.flatten().tolist() for c in batch]}
        out = _run_bridge("extract-features", payload)
        hog_chunks.append(np.array(out["hog"], dtype=np.float64))
        hole_chunks.append(np.array(out["hole"], dtype=np.float64))
    if not hog_chunks:
        return np.zeros((0, 0), dtype=np.float64), np.zeros((0, 0), dtype=np.float64)
    return np.concatenate(hog_chunks), np.concatenate(hole_chunks)


def solve(spec: PuzzleSpec, given_digits: npt.NDArray[np.intp] | None = None) -> dict[str, Any]:
    """Solves a spec by calling into the real TS engine instead of any Python solver.

    spec.regions/spec.cage_totals are col-major ([col, row]) -- confirmed by
    reading validate_cage_layout's union-find loop directly, not its (stale)
    Args docstring -- so they're transposed here to the row-major shape
    ts-bridge.ts's solve() expects (see ts-bridge.test.ts's own trivial-spec
    test for the empirical proof of that expectation). border_x/border_y are
    already col-first in both TS and Python by convention (see this repo's
    CLAUDE.md "Exception -- border arrays") and pass through unchanged.
    """
    payload: dict[str, Any] = {
        "regions": spec.regions.T.tolist(),
        "cageTotals": spec.cage_totals.T.tolist(),
        "borderX": spec.border_x.tolist(),
        "borderY": spec.border_y.tolist(),
    }
    if given_digits is not None:
        payload["givenDigits"] = given_digits.tolist()
    return _run_bridge("solve", payload)


def predict(
    crops: Sequence[npt.NDArray[np.uint8]], model_bin: Path, model_json: Path,
) -> list[dict[str, Any]]:
    # Resolve relative to the repo root (not cwd) -- _run_bridge invokes the
    # subprocess with cwd=web/, so a bare relative path like
    # "web/public/num_recogniser.bin" would otherwise double up.
    model_bin_abs = model_bin if model_bin.is_absolute() else (_REPO_ROOT / model_bin)
    model_json_abs = model_json if model_json.is_absolute() else (_REPO_ROOT / model_json)
    predictions: list[dict[str, Any]] = []
    for i in range(0, len(crops), _BATCH_SIZE):
        batch = crops[i : i + _BATCH_SIZE]
        payload = {"crops": [c.flatten().tolist() for c in batch]}
        out = _run_bridge(
            "predict", payload,
            extra_args=["--model-bin", str(model_bin_abs), "--model-json", str(model_json_abs)],
        )
        predictions.extend(out["predictions"])
    return predictions
