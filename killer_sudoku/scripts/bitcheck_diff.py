"""Compares a Python-side and TS-side bitcheck dump stage-by-stage.

Reports only the first stage that diverges. Temporary tooling — see
docs/superpowers/specs/2026-07-21-python-bitexact-port-design.md.

Usage:
    python -m killer_sudoku.scripts.bitcheck_diff <py_dump.json> <ts_dump.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

_TOLERANCE = 1e-6

# (label, python_key, ts_key), checked in pipeline order.
_STAGES: list[tuple[str, str, str]] = [
    ("Stage 1: grayscale image", "gray", "gray"),
    ("Stage 2: grid corners", "grid_corners", "gridCorners"),
    ("Stage 3/4: puzzle type", "puzzle_type", "puzzleType"),
    ("Stage 4: border_x", "border_x", "borderX"),
    ("Stage 4: border_y", "border_y", "borderY"),
    ("Stage 5: cage totals", "cage_totals", "cageTotals"),
    ("Stage 5: given digits", "given_digits", "givenDigits"),
    ("Stage 6: regions", "regions", "regions"),
    ("Stage 6: spec_error", "spec_error", "specError"),
]


def _compare_arrays(py_arr: np.ndarray[Any, Any], ts_arr: np.ndarray[Any, Any]) -> str | None:
    if py_arr.shape != ts_arr.shape:
        return f"shape mismatch: python={py_arr.shape} ts={ts_arr.shape}"

    if py_arr.dtype == bool or np.issubdtype(py_arr.dtype, np.integer):
        diff = np.abs(py_arr.astype(np.int64) - ts_arr.astype(np.int64))
        if diff.max() == 0:
            return None
        idx = np.argwhere(diff != 0)
        return f"{len(idx)} elements differ (max abs diff {int(diff.max())}), sample indices {idx[:5].tolist()}"

    diff = np.abs(py_arr.astype(np.float64) - ts_arr.astype(np.float64))
    if diff.max() <= _TOLERANCE:
        return None
    idx = np.argwhere(diff > _TOLERANCE)
    return f"{len(idx)} elements differ beyond {_TOLERANCE} (max abs diff {diff.max()}), sample indices {idx[:5].tolist()}"


def _compare(py_val: Any, ts_val: Any) -> str | None:
    if py_val is None and ts_val is None:
        return None
    if (py_val is None) != (ts_val is None):
        return f"one side is null (python is None: {py_val is None}, ts is None: {ts_val is None})"
    if isinstance(py_val, str) or isinstance(ts_val, str):
        return None if py_val == ts_val else f"{py_val!r} != {ts_val!r}"
    return _compare_arrays(np.asarray(py_val), np.asarray(ts_val))


def diff_dumps(py_dump: dict[str, Any], ts_dump: dict[str, Any]) -> str | None:
    """Returns None if all stages match, else '<label>: <detail>' for the first divergence."""
    for label, py_key, ts_key in _STAGES:
        py_val = py_dump.get(py_key)
        ts_val = ts_dump.get(ts_key)
        # TS's gridCorners is flattened [x0,y0,x1,y1,...]; Python's grid_corners
        # is a (4,2) array. Reshape so the two are directly comparable.
        if py_key == "grid_corners" and ts_val is not None:
            ts_val = np.asarray(ts_val).reshape(4, 2).tolist()
        detail = _compare(py_val, ts_val)
        if detail is not None:
            return f"{label}: {detail}"
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("py_dump", type=Path)
    parser.add_argument("ts_dump", type=Path)
    args = parser.parse_args()

    py_dump = json.loads(args.py_dump.read_text())
    ts_dump = json.loads(args.ts_dump.read_text())

    result = diff_dumps(py_dump, ts_dump)
    if result is None:
        print("MATCH — all stages agree within tolerance.")
        sys.exit(0)
    print(f"DIVERGES at {result}")
    sys.exit(1)


if __name__ == "__main__":
    main()
