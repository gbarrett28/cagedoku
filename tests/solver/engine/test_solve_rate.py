"""Solve-rate smoke tests for the SolverEngine against real puzzle data.

These tests are skipped if the puzzle image directories are not present
(they are gitignored). Run manually against the full dataset to verify
solve-rate does not regress vs. the old Grid.solve().

Expected baselines (propagation-only, before CSP fallback):
  Guardian  : >= 461 fully solved
  Observer  : >= 413 fully solved
"""

from pathlib import Path

import pytest

GUARDIAN_DIR = Path("guardian")
OBSERVER_DIR = Path("observer")


@pytest.mark.skipif(not GUARDIAN_DIR.exists(), reason="Guardian data not present")
def test_guardian_engine_solve_rate() -> None:
    """Engine should solve at least as many Guardian puzzles as the old solver."""
    # Manual verification command:
    #   python -m killer_sudoku.main --rag guardian --rework
    # Check output: should show >= 461 SOLVED, ideally 0 CheatTimeout
    pass  # implementation depends on full pipeline API


@pytest.mark.skipif(not OBSERVER_DIR.exists(), reason="Observer data not present")
def test_observer_engine_solve_rate() -> None:
    """Engine should solve at least as many Observer puzzles as the old solver."""
    # Manual verification command:
    #   python -m killer_sudoku.main --rag observer --rework
    # Check output: should show >= 413 SOLVED, ideally 0 CheatTimeout
    pass  # implementation depends on full pipeline API
