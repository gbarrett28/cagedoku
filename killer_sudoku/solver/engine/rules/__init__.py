"""Default rule set for the solver engine.

Rules are ordered by priority (ascending = higher priority = fired first):
  0  NakedSingle           — CELL_DETERMINED (recognition only, no eliminations)
  0  SolvedCellElimination — CELL_DETERMINED (eliminate confirmed digit from unit peers)
  1  LinearElimination     — GLOBAL (cells determined by cage-sum algebra)
  1  HiddenSingle          — COUNT_HIT_ONE
  2  CageCandidateFilter   — COUNT_DECREASED / SOLUTION_PRUNED (CAGE)
  2  CageIntersection      — COUNT_DECREASED / SOLUTION_PRUNED (CAGE)
  3  SolutionMapFilter     — COUNT_DECREASED / SOLUTION_PRUNED (CAGE)
  4  MustContain           — COUNT_DECREASED (all units)
  4  MustContainOutie      — COUNT_DECREASED / SOLUTION_PRUNED (all units)
  5  DeltaConstraint       — COUNT_DECREASED / CELL_DETERMINED
  5  SumPairConstraint     — COUNT_DECREASED / CELL_DETERMINED
  6  NakedPair             — COUNT_HIT_TWO
  7  HiddenPair            — COUNT_HIT_TWO
  8  NakedHiddenTriple     — COUNT_DECREASED (ROW/COL/BOX)
  9  NakedHiddenQuad       — COUNT_DECREASED (ROW/COL/BOX)
 10  PointingPairs         — COUNT_DECREASED (BOX)
 11  LockedCandidates      — COUNT_DECREASED (ROW/COL/BOX)
 12  UnitPartitionFilter   — GLOBAL
 13  XWing                 — GLOBAL
 14  Swordfish             — GLOBAL
 15  Jellyfish             — GLOBAL
 16  XYWing                — GLOBAL
 17  UniqueRectangle       — GLOBAL
 18  SimpleColouring       — GLOBAL
"""

from killer_sudoku.solver.engine.rule import SolverRule
from killer_sudoku.solver.engine.rules.cage_candidate_filter import CageCandidateFilter
from killer_sudoku.solver.engine.rules.cage_intersection import CageIntersection
from killer_sudoku.solver.engine.rules.delta_constraint import DeltaConstraint
from killer_sudoku.solver.engine.rules.hidden_pair import HiddenPair
from killer_sudoku.solver.engine.rules.hidden_single import HiddenSingle
from killer_sudoku.solver.engine.rules.jellyfish import Jellyfish
from killer_sudoku.solver.engine.rules.linear_elimination import LinearElimination
from killer_sudoku.solver.engine.rules.locked_candidates import LockedCandidates
from killer_sudoku.solver.engine.rules.must_contain import MustContain
from killer_sudoku.solver.engine.rules.must_contain_outie import MustContainOutie
from killer_sudoku.solver.engine.rules.naked_hidden_quad import NakedHiddenQuad
from killer_sudoku.solver.engine.rules.naked_hidden_triple import NakedHiddenTriple
from killer_sudoku.solver.engine.rules.naked_pair import NakedPair
from killer_sudoku.solver.engine.rules.naked_single import NakedSingle
from killer_sudoku.solver.engine.rules.pointing_pairs import PointingPairs
from killer_sudoku.solver.engine.rules.simple_colouring import SimpleColouring
from killer_sudoku.solver.engine.rules.solution_map_filter import SolutionMapFilter
from killer_sudoku.solver.engine.rules.solved_cell_elimination import (
    SolvedCellElimination,
)
from killer_sudoku.solver.engine.rules.sum_pair_constraint import SumPairConstraint
from killer_sudoku.solver.engine.rules.swordfish import Swordfish
from killer_sudoku.solver.engine.rules.unique_rectangle import UniqueRectangle
from killer_sudoku.solver.engine.rules.unit_partition_filter import UnitPartitionFilter
from killer_sudoku.solver.engine.rules.x_wing import XWing
from killer_sudoku.solver.engine.rules.xy_wing import XYWing


def default_rules() -> list[SolverRule]:
    """Return the full default rule set in priority order."""
    return [
        NakedSingle(),
        SolvedCellElimination(),
        LinearElimination(),
        HiddenSingle(),
        CageCandidateFilter(),
        CageIntersection(),
        SolutionMapFilter(),
        MustContain(),
        MustContainOutie(),
        DeltaConstraint(),
        SumPairConstraint(),
        NakedPair(),
        HiddenPair(),
        NakedHiddenTriple(),
        NakedHiddenQuad(),
        PointingPairs(),
        LockedCandidates(),
        UnitPartitionFilter(),
        XWing(),
        Swordfish(),
        Jellyfish(),
        XYWing(),
        UniqueRectangle(),
        SimpleColouring(),
    ]
