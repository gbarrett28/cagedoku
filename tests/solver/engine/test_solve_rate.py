"""Non-regression solve-rate tests for the SolverEngine against real puzzle data.

Processes every .jpg in guardian/ and observer/ using the standard image
pipeline (with .jpk cache for speed), runs Grid.engine_solve(), and asserts
that the number of fully-solved puzzles meets the committed baseline.

Directories are configured via environment variables:
    GUARDIAN_DIR  (default: "guardian")
    OBSERVER_DIR  (default: "observer")

Tests skip automatically if the relevant directory is absent (e.g. CI without
the training image corpus).  On a development machine with the images present
they always run.

Baseline numbers (engine_solve, as of 2026-04-14):
  Guardian : >= 463 SOLVED out of 465 total
  Observer : >= 424 SOLVED out of 424 total

Two guardian puzzles (247, 275) have pre-existing OCR errors in cage totals that
produce impossible values (e.g. total=50 for a 2-cell cage); they are excluded
from the baseline.

To update baselines after a genuine improvement: edit GUARDIAN_BASELINE and
OBSERVER_BASELINE below, commit the change, and record the new numbers in the
commit message.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.solver.grid import Grid, ProcessingError

GUARDIAN_DIR = Path(os.environ.get("GUARDIAN_DIR", "guardian"))
OBSERVER_DIR = Path(os.environ.get("OBSERVER_DIR", "observer"))

GUARDIAN_BASELINE = 463
OBSERVER_BASELINE = 424


def _sorted_jpgs(directory: Path) -> list[Path]:
    return sorted(
        directory.glob("*.jpg"),
        key=lambda p: int(p.stem.split("_")[-1]),
    )


def _solve_directory(directory: Path) -> tuple[int, int]:
    """Run engine_solve on every .jpg in directory; return (solved, total)."""
    config = ImagePipelineConfig()
    num_rec = InpImage.make_num_recogniser()
    solved = 0
    total = 0
    for jpg in _sorted_jpgs(directory):
        total += 1
        try:
            inp = InpImage(jpg, config, num_rec)
            assert inp.spec is not None, inp.spec_error
            grd = Grid()
            grd.set_up(inp.spec)
            alts_sum, _ = grd.engine_solve()
            if alts_sum == 81:
                solved += 1
        except (ProcessingError, AssertionError, ValueError):
            pass
    return solved, total


@pytest.mark.skipif(not GUARDIAN_DIR.exists(), reason="guardian/ directory not present")
def test_guardian_engine_solve_rate_no_regression() -> None:
    """Guardian solve count must not drop below the committed baseline."""
    solved, total = _solve_directory(GUARDIAN_DIR)
    assert solved >= GUARDIAN_BASELINE, (
        f"Solve-rate regression in {GUARDIAN_DIR}: "
        f"{solved}/{total} < baseline {GUARDIAN_BASELINE}"
    )


@pytest.mark.skipif(not OBSERVER_DIR.exists(), reason="observer/ directory not present")
def test_observer_engine_solve_rate_no_regression() -> None:
    """Observer solve count must not drop below the committed baseline."""
    solved, total = _solve_directory(OBSERVER_DIR)
    assert solved >= OBSERVER_BASELINE, (
        f"Solve-rate regression in {OBSERVER_DIR}: "
        f"{solved}/{total} < baseline {OBSERVER_BASELINE}"
    )
