"""Corpus evaluator for the Python image pipeline.

Runs InpImage against every puzzle in corpus.db and writes evaluation rows
keyed by the git HEAD SHA of the current branch. Running twice with the same
SHA produces identical rows (idempotent): all existing rows for that SHA are
deleted before evaluating.

Usage:
    python -m killer_sudoku.scripts.evaluate_corpus --db /path/to/corpus.db
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import numpy as np

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.image.number_recognition import CayenneNumber

_PY_COLUMNS: list[tuple[str, str]] = [
    ("py_ink_density", "REAL"),
    ("py_total_sum", "INTEGER"),
    ("py_fallback_used", "INTEGER"),
    ("py_connectivity_score", "INTEGER"),
    ("py_cage_head_count", "INTEGER"),
    ("py_grid_corners", "TEXT"),
]


@dataclass(frozen=True)
class EvalResult:
    """Structured outcome of evaluating one puzzle image."""

    bucket: str
    reason: str
    spec_error: str | None
    elapsed_ms: int
    ink_density: float
    total_sum: int
    fallback_used: bool
    connectivity_score: int
    cage_head_count: int
    grid_corners: str


def _classify(spec_error: str | None) -> tuple[str, str]:
    """Return (bucket, reason) from a spec_error value."""
    if spec_error is None:
        return "clean", "auto_confirmed"
    return "notSolved", "spec_error"


def _get_git_hash() -> str:
    """Return the full SHA of the current git HEAD."""
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _ensure_py_columns(con: sqlite3.Connection) -> None:
    """Add Python-specific diagnostic columns to evaluations if they do not exist."""
    existing = {row[1] for row in con.execute("PRAGMA table_info(evaluations)").fetchall()}
    for col_name, col_type in _PY_COLUMNS:
        if col_name not in existing:
            con.execute(f"ALTER TABLE evaluations ADD COLUMN {col_name} {col_type}")
    con.commit()


def evaluate_image(
    path: Path,
    config: ImagePipelineConfig,
    recogniser: CayenneNumber,
) -> EvalResult:
    """Run InpImage on one image and return a structured result.

    Catches all exceptions so a single corrupt or missing image does not
    abort the full corpus run. Pipeline crashes are recorded as notSolved
    with spec_error prefixed 'crash:'.

    Args:
        path: Path to the image file.
        config: Pipeline configuration (use ImagePipelineConfig() for defaults).
        recogniser: Loaded digit recogniser.

    Returns:
        EvalResult with bucket, reason, diagnostics, and elapsed_ms.
    """
    t0 = time.monotonic()
    spec_error: str | None
    ink_density: float = 0.0
    total_sum: int = 0
    fallback_used: bool = False
    connectivity_score: int = 0
    cage_head_count: int = 0
    grid_corners: str = "[]"

    try:
        inp = InpImage(path, config, recogniser)
        spec_error = inp.spec_error
        ink_density = inp.ink_density
        total_sum = inp.total_sum
        fallback_used = inp.fallback_used
        connectivity_score = inp.connectivity_score
        cage_head_count = int(np.count_nonzero(inp.info.cage_totals))
        grid_corners = json.dumps(inp.info.grid.tolist())
    except Exception as exc:
        spec_error = f"crash: {exc}"

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    bucket, reason = _classify(spec_error)
    return EvalResult(
        bucket=bucket,
        reason=reason,
        spec_error=spec_error,
        elapsed_ms=elapsed_ms,
        ink_density=ink_density,
        total_sum=total_sum,
        fallback_used=fallback_used,
        connectivity_score=connectivity_score,
        cage_head_count=cage_head_count,
        grid_corners=grid_corners,
    )


def main() -> None:
    """Run the Python corpus evaluator CLI."""
    parser = argparse.ArgumentParser(
        description="Evaluate the Python image pipeline against the full corpus.",
    )
    parser.add_argument("--db", required=True, type=Path, help="Path to corpus.db")
    args = parser.parse_args()
    db_path: Path = args.db
    corpus_root = db_path.parent

    git_hash = _get_git_hash()
    config = ImagePipelineConfig()
    recogniser = InpImage.make_num_recogniser()

    con = sqlite3.connect(db_path)
    try:
        _ensure_py_columns(con)

        rows = cast(
            list[tuple[str, str]],
            con.execute("SELECT content_hash, path FROM puzzles").fetchall(),
        )
        total = len(rows)
        print(f"Evaluating {total} puzzles — git_hash={git_hash[:12]}...")

        con.execute("DELETE FROM evaluations WHERE git_hash = ?", (git_hash,))
        con.commit()

        for i, (content_hash, rel_path) in enumerate(rows, 1):
            result = evaluate_image(corpus_root / rel_path, config, recogniser)
            con.execute(
                """
                INSERT INTO evaluations (
                    puzzle_hash, git_hash, status, bucket, reason,
                    spec_error, elapsed_ms, finished_at,
                    py_ink_density, py_total_sum, py_fallback_used,
                    py_connectivity_score, py_cage_head_count, py_grid_corners
                ) VALUES (?, ?, 'done', ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)
                """,
                (
                    content_hash, git_hash, result.bucket, result.reason,
                    result.spec_error, result.elapsed_ms,
                    result.ink_density, result.total_sum,
                    1 if result.fallback_used else 0,
                    result.connectivity_score, result.cage_head_count,
                    result.grid_corners,
                ),
            )
            if i % 100 == 0 or i == total:
                con.commit()
                print(f"  [{i}/{total}] {result.bucket}: {Path(rel_path).name}")
    finally:
        con.close()


if __name__ == "__main__":
    main()
