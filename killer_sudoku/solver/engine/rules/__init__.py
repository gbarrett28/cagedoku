"""Active rule set for the coaching engine.

Rules decorated with @hintable_rule self-register when their module is imported.
Importing all rule modules here populates the registry; registered_rules() then
returns them sorted by priority.

Priority order (ascending = higher priority = fired first):
  0  NakedSingle              — CELL_DETERMINED (recognition + placement hint)
  0  CellSolutionElimination  — CELL_SOLVED (peer cleanup; DEFAULT_ALWAYS_APPLY)
  1  HiddenSingle             — COUNT_HIT_ONE (row/col/box/cage)
  1  LinearElimination        — COUNT_DECREASED / SOLUTION_PRUNED
  2  CageCandidateFilter      — COUNT_DECREASED / SOLUTION_PRUNED (DEFAULT_ALWAYS_APPLY)
  2  CageIntersection         — COUNT_DECREASED / SOLUTION_PRUNED (cage-first locking)
  3  SolutionMapFilter        — COUNT_DECREASED / SOLUTION_PRUNED
  4  MustContain              — COUNT_DECREASED (unit-first cage confined digits)
  4  MustContainOutie         — COUNT_DECREASED / SOLUTION_PRUNED
  5  DeltaConstraint          — COUNT_DECREASED / SOLUTION_PRUNED
  5  SumPairConstraint        — COUNT_DECREASED / SOLUTION_PRUNED
  6  NakedPair                — COUNT_HIT_TWO (row/col/box)
  9  PointingPairs            — COUNT_DECREASED (box→row/col locking)
 11  LockedCandidates         — COUNT_DECREASED (row/col→cage and row/col→box)
 12  CageConfinement          — GLOBAL
 12  UnitPartitionFilter      — GLOBAL (cross-cage partition compatibility)

Rules without hint implementations live in ``rules/incomplete/`` and are used
only by the batch solver.  See that sub-package's docstring for how to graduate
a rule back to this package.
"""

from killer_sudoku.solver.engine.rule import SolverRule
from killer_sudoku.solver.engine.rules._registry import registered_rules

# Import all rule modules so their @hintable_rule decorators fire and populate
# the registry.  Import order within each priority tier determines tie-breaking.
from killer_sudoku.solver.engine.rules.cage_candidate_filter import CageCandidateFilter
from killer_sudoku.solver.engine.rules.cage_confinement import CageConfinement
from killer_sudoku.solver.engine.rules.cage_intersection import CageIntersection
from killer_sudoku.solver.engine.rules.cell_solution_elimination import (
    CellSolutionElimination,
)
from killer_sudoku.solver.engine.rules.incomplete.delta_constraint import (
    DeltaConstraint,
)
from killer_sudoku.solver.engine.rules.incomplete.hidden_single import HiddenSingle
from killer_sudoku.solver.engine.rules.incomplete.linear_elimination import (
    LinearElimination,
)
from killer_sudoku.solver.engine.rules.incomplete.naked_pair import NakedPair
from killer_sudoku.solver.engine.rules.incomplete.sum_pair_constraint import (
    SumPairConstraint,
)
from killer_sudoku.solver.engine.rules.locked_candidates import LockedCandidates
from killer_sudoku.solver.engine.rules.must_contain import MustContain
from killer_sudoku.solver.engine.rules.must_contain_outie import MustContainOutie
from killer_sudoku.solver.engine.rules.naked_single import NakedSingle
from killer_sudoku.solver.engine.rules.pointing_pairs import PointingPairs
from killer_sudoku.solver.engine.rules.solution_map_filter import SolutionMapFilter
from killer_sudoku.solver.engine.rules.unit_partition_filter import UnitPartitionFilter

__all__ = [
    "CageCandidateFilter",
    "CageConfinement",
    "CageIntersection",
    "CellSolutionElimination",
    "DeltaConstraint",
    "HiddenSingle",
    "LinearElimination",
    "LockedCandidates",
    "MustContain",
    "MustContainOutie",
    "NakedPair",
    "NakedSingle",
    "PointingPairs",
    "SolutionMapFilter",
    "SumPairConstraint",
    "UnitPartitionFilter",
]


def default_rules() -> list[SolverRule]:
    """Return the active coaching rule set in priority order.

    Each rule self-registers via @hintable_rule when its module is imported
    above.  registered_rules() instantiates and sorts them by priority.

    For the full batch-solver rule set (including incomplete rules), use
    ``killer_sudoku.solver.engine.all_rules()``.
    """
    return registered_rules()
