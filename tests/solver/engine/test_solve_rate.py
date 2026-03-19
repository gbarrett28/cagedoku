"""Non-regression solve-rate tests for the SolverEngine against real puzzle data.

These tests read the cached eval_report.json produced by:
    python -m killer_sudoku.training.evaluate --rag guardian|observer

They are skipped if the puzzle directories or eval reports are not present
(they are gitignored). Run the evaluation first, then run the silver gate.

Baseline numbers (propagation-only, no cheat, as of 2026-03-19):
  Guardian  : >= 461 SOLVED out of 465 total
  Observer  : >= 419 SOLVED out of 424 total

Note: Observer dropped from 412 after fixing the cage HiddenSingle bug (the rule
was incorrectly firing on cage units without checking all feasible solutions). The
39 previously-"solved" Observer puzzles were solved by an incorrect shortcut that
happened to give the right answer. Dynamic RREF propagation (substitute_live_rows)
and SimpleColouring recovered some (373→378). LockedCandidates (Box-Line Reduction
+ Unit→Cage) added 2 more Observer (378→380). Non-burb virtual cages via
reduce_equns-style subset subtraction (with solution propagation) added 1 more
Observer (380→381), eliminating the 8 Guardian and 33 Observer AssertionErrors
that plagued the previous RREF-only non-burb approach. Sliding-window burb equation
generation (add_equns-style along rows/cols) added 14 Guardian (446→460) and 35
Observer (381→416) by surfacing cage-aware sub-sum equations that RREF cannot
derive when cages span multiple units. Box-spanning DFS equation generation
(add_equns_r-style over adjacent 3x3 boxes) added 1 Guardian (460→461) and 1
Observer (416→417) by deriving multi-box constraints that neither RREF nor the
row/col sliding window can produce. UnitPartitionFilter (cross-cage compatibility
for completely partitioned units, ranked by m — solutions per cage) added 2 Observer
(417→419) by eliminating cage solutions that contradict any valid cross-unit
digit assignment.

To update baselines after a genuine improvement: edit GUARDIAN_BASELINE and
OBSERVER_BASELINE below, commit the change, and record the new numbers in the
commit message.
"""

import json
from pathlib import Path

import pytest

GUARDIAN_DIR = Path("guardian")
OBSERVER_DIR = Path("observer")
GUARDIAN_REPORT = GUARDIAN_DIR / "eval_report.json"
OBSERVER_REPORT = OBSERVER_DIR / "eval_report.json"

GUARDIAN_BASELINE = 461
OBSERVER_BASELINE = 419


_GUARDIAN_SKIP = "Guardian eval report not present — run evaluate --rag guardian"


@pytest.mark.skipif(not GUARDIAN_REPORT.exists(), reason=_GUARDIAN_SKIP)
def test_guardian_engine_solve_rate_no_regression() -> None:
    """Solve count must not drop below the committed Guardian baseline.

    Reads the cached guardian/eval_report.json produced by the evaluate script.
    Fails if the reported SOLVED count is less than GUARDIAN_BASELINE.
    """
    report = json.loads(GUARDIAN_REPORT.read_text())
    solved = report["solved"]
    assert solved >= GUARDIAN_BASELINE, (
        f"Guardian solve-rate regression: {solved} < baseline {GUARDIAN_BASELINE}. "
        f"Run 'python -m killer_sudoku.training.evaluate --rag guardian' to regenerate."
    )


_OBSERVER_SKIP = "Observer eval report not present — run evaluate --rag observer"


@pytest.mark.skipif(not OBSERVER_REPORT.exists(), reason=_OBSERVER_SKIP)
def test_observer_engine_solve_rate_no_regression() -> None:
    """Solve count must not drop below the committed Observer baseline.

    Reads the cached observer/eval_report.json produced by the evaluate script.
    Fails if the reported SOLVED count is less than OBSERVER_BASELINE.
    """
    report = json.loads(OBSERVER_REPORT.read_text())
    solved = report["solved"]
    assert solved >= OBSERVER_BASELINE, (
        f"Observer solve-rate regression: {solved} < baseline {OBSERVER_BASELINE}. "
        f"Run 'python -m killer_sudoku.training.evaluate --rag observer' to regenerate."
    )
