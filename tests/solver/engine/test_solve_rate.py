"""Non-regression solve-rate tests for the SolverEngine against real puzzle data.

These tests read the cached eval_report.json produced by:
    python -m killer_sudoku.training.evaluate --puzzle-dir <dir>

They are skipped if the puzzle directories or eval reports are not present
(they are gitignored). Run the evaluation first, then run the silver gate.

Set PUZZLE_DIR_1 / PUZZLE_DIR_2 environment variables to point at your puzzle
directories before running (defaults: "puzzles_1", "puzzles_2").

Baseline numbers (propagation-only, as of 2026-03-23):
  Puzzle dir 1 : >= 463 SOLVED out of 465 total
  Puzzle dir 2 : >= 423 SOLVED out of 424 total

Note: Puzzle dir 2 dropped from 412 after fixing the cage HiddenSingle bug (the rule
was incorrectly firing on cage units without checking all feasible solutions). The
39 previously-"solved" puzzles were solved by an incorrect shortcut that happened to
give the right answer. Dynamic RREF propagation (substitute_live_rows) and
SimpleColouring recovered some (373→378). LockedCandidates (Box-Line Reduction +
Unit→Cage) added 2 more (378→380). Non-burb virtual cages via reduce_equns-style
subset subtraction (with solution propagation) added 1 more (380→381), eliminating
the 8 dir-1 and 33 dir-2 AssertionErrors that plagued the previous RREF-only
non-burb approach. Sliding-window burb equation generation (add_equns-style along
rows/cols) added 14 dir-1 (446→460) and 35 dir-2 (381→416) by surfacing cage-aware
sub-sum equations that RREF cannot derive when cages span multiple units.
Box-spanning DFS equation generation (add_equns_r-style over adjacent 3x3 boxes)
added 1 dir-1 (460→461) and 1 dir-2 (416→417). UnitPartitionFilter added 2 dir-2
(417→419). Cell-level expansion in UnitPartitionFilter added 1 more dir-2 (419→420).
Overlapping-equation delta pair derivation added 3 dir-2 (420→423).
Complementary RREF row sum pairs added 2 dir-1 (461→463).

To update baselines after a genuine improvement: edit PUZZLE_DIR_1_BASELINE and
PUZZLE_DIR_2_BASELINE below, commit the change, and record the new numbers in the
commit message.
"""

import json
import os
from pathlib import Path

import pytest

PUZZLE_DIR_1 = Path(os.environ.get("PUZZLE_DIR_1", "puzzles_1"))
PUZZLE_DIR_2 = Path(os.environ.get("PUZZLE_DIR_2", "puzzles_2"))
PUZZLE_DIR_1_REPORT = PUZZLE_DIR_1 / "eval_report.json"
PUZZLE_DIR_2_REPORT = PUZZLE_DIR_2 / "eval_report.json"

PUZZLE_DIR_1_BASELINE = 463
PUZZLE_DIR_2_BASELINE = 423

_PUZZLE_DIR_1_SKIP = (
    "Puzzle dir 1 eval report not present — run evaluate --puzzle-dir <dir>"
)
_PUZZLE_DIR_2_SKIP = (
    "Puzzle dir 2 eval report not present — run evaluate --puzzle-dir <dir>"
)


@pytest.mark.skipif(not PUZZLE_DIR_1_REPORT.exists(), reason=_PUZZLE_DIR_1_SKIP)
def test_puzzle_dir_1_engine_solve_rate_no_regression() -> None:
    """Solve count must not drop below the committed baseline for puzzle dir 1.

    Reads the cached eval_report.json produced by the evaluate script.
    Fails if the reported SOLVED count is less than PUZZLE_DIR_1_BASELINE.
    """
    report = json.loads(PUZZLE_DIR_1_REPORT.read_text())
    solved = report["solved"]
    assert solved >= PUZZLE_DIR_1_BASELINE, (
        f"Solve-rate regression in {PUZZLE_DIR_1}: "
        f"{solved} < baseline {PUZZLE_DIR_1_BASELINE}. "
        f"Run 'python -m killer_sudoku.training.evaluate --puzzle-dir {PUZZLE_DIR_1}'"
        f" to regenerate."
    )


@pytest.mark.skipif(not PUZZLE_DIR_2_REPORT.exists(), reason=_PUZZLE_DIR_2_SKIP)
def test_puzzle_dir_2_engine_solve_rate_no_regression() -> None:
    """Solve count must not drop below the committed baseline for puzzle dir 2.

    Reads the cached eval_report.json produced by the evaluate script.
    Fails if the reported SOLVED count is less than PUZZLE_DIR_2_BASELINE.
    """
    report = json.loads(PUZZLE_DIR_2_REPORT.read_text())
    solved = report["solved"]
    assert solved >= PUZZLE_DIR_2_BASELINE, (
        f"Solve-rate regression in {PUZZLE_DIR_2}: "
        f"{solved} < baseline {PUZZLE_DIR_2_BASELINE}. "
        f"Run 'python -m killer_sudoku.training.evaluate --puzzle-dir {PUZZLE_DIR_2}'"
        f" to regenerate."
    )
