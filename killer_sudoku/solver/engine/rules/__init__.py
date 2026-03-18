"""Default rule set for the solver engine.

Rules are ordered by priority (ascending = higher priority = fired first):
  0  NakedSingle       — CELL_DETERMINED
  1  HiddenSingle      — COUNT_HIT_ONE
  2  CageIntersection  — COUNT_DECREASED / SOLUTION_PRUNED (CAGE)
  3  SolutionMapFilter — COUNT_DECREASED / SOLUTION_PRUNED (CAGE)
  4  MustContain       — COUNT_DECREASED (all units)
  5  DeltaConstraint   — COUNT_DECREASED / CELL_DETERMINED
  6  NakedPair         — COUNT_HIT_TWO
  7  HiddenPair        — COUNT_HIT_TWO
  8  NakedHiddenTriple — COUNT_DECREASED (ROW/COL/BOX)
  9  PointingPairs     — COUNT_DECREASED (BOX)
 11  XWing             — GLOBAL
 12  SimpleColouring   — GLOBAL
"""

from killer_sudoku.solver.engine.rule import SolverRule
from killer_sudoku.solver.engine.rules.cage_intersection import CageIntersection
from killer_sudoku.solver.engine.rules.delta_constraint import DeltaConstraint
from killer_sudoku.solver.engine.rules.hidden_pair import HiddenPair
from killer_sudoku.solver.engine.rules.hidden_single import HiddenSingle
from killer_sudoku.solver.engine.rules.must_contain import MustContain
from killer_sudoku.solver.engine.rules.naked_hidden_triple import NakedHiddenTriple
from killer_sudoku.solver.engine.rules.naked_pair import NakedPair
from killer_sudoku.solver.engine.rules.naked_single import NakedSingle
from killer_sudoku.solver.engine.rules.pointing_pairs import PointingPairs
from killer_sudoku.solver.engine.rules.simple_colouring import SimpleColouring
from killer_sudoku.solver.engine.rules.solution_map_filter import SolutionMapFilter
from killer_sudoku.solver.engine.rules.x_wing import XWing


def default_rules() -> list[SolverRule]:
    """Return the full default rule set in priority order."""
    return [
        NakedSingle(),
        HiddenSingle(),
        CageIntersection(),
        SolutionMapFilter(),
        MustContain(),
        DeltaConstraint(),
        NakedPair(),
        HiddenPair(),
        NakedHiddenTriple(),
        PointingPairs(),
        XWing(),
        SimpleColouring(),
    ]
