"""Active rule set for the coaching engine.

Only rules that implement ``HintableRule`` (i.e. have ``compute_hints``) or are
in ``DEFAULT_ALWAYS_APPLY_RULES`` belong here.  Rules in ``default_rules()`` are
usable in three ways:
- Promoted to always-apply via the config modal (HintableRule required)
- Surfaced as on-demand hints (HintableRule required)
- Listed in ``DEFAULT_ALWAYS_APPLY_RULES`` (bootstrapped without user action)

Priority order (ascending = higher priority = fired first):
  0  NakedSingle              — CELL_DETERMINED (recognition + placement hint)
  0  CellSolutionElimination  — CELL_SOLVED (peer cleanup; DEFAULT_ALWAYS_APPLY)
  1  HiddenSingle             — COUNT_HIT_ONE (row/col/box/cage)
  1  CageCandidateFilter      — COUNT_DECREASED / SOLUTION_PRUNED (DEFAULT_ALWAYS_APPLY)
  2  SolutionMapFilter        — COUNT_DECREASED / SOLUTION_PRUNED
  3  MustContainOutie         — COUNT_DECREASED / SOLUTION_PRUNED
  4  CageConfinement          — GLOBAL
  6  NakedPair                — COUNT_HIT_TWO (row/col/box)

Rules without hint implementations live in ``rules/incomplete/`` and are used
only by the batch solver.  See that sub-package's docstring for how to graduate
a rule back to this package.
"""

from killer_sudoku.solver.engine.rule import SolverRule
from killer_sudoku.solver.engine.rules.cage_candidate_filter import CageCandidateFilter
from killer_sudoku.solver.engine.rules.cage_confinement import CageConfinement
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
from killer_sudoku.solver.engine.rules.must_contain_outie import MustContainOutie
from killer_sudoku.solver.engine.rules.naked_single import NakedSingle
from killer_sudoku.solver.engine.rules.solution_map_filter import SolutionMapFilter


def default_rules() -> list[SolverRule]:
    """Return the active coaching rule set in priority order.

    These rules are all hintable (implement HintableRule) or bootstrapped via
    DEFAULT_ALWAYS_APPLY_RULES.  The coaching config modal discovers all
    HintableRule instances here and presents them for user promotion.

    For the full batch-solver rule set (including incomplete rules), use
    ``killer_sudoku.solver.engine.all_rules()``.
    """
    return [
        NakedSingle(),
        CellSolutionElimination(),
        HiddenSingle(),
        CageCandidateFilter(),
        SolutionMapFilter(),
        MustContainOutie(),
        CageConfinement(),
        NakedPair(),
        LinearElimination(),
        DeltaConstraint(),
        SumPairConstraint(),
    ]
