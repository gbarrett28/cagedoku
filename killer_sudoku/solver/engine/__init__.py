"""Solver engine public API.

Entry point: solve(spec) builds a BoardState, runs the engine main loop with
all_rules() (coaching rules + incomplete rules including LinearElimination),
and returns the final BoardState. The caller checks whether the board is fully solved.

For the coaching app, use default_rules() which contains only rules that have
as_hints() implementations and can be surfaced via the config modal.
"""

import numpy as np
import numpy.typing as npt

from killer_sudoku.solver.engine.board_state import BoardState, validate_solution
from killer_sudoku.solver.engine.rule import SolverRule
from killer_sudoku.solver.engine.rules import default_rules
from killer_sudoku.solver.engine.rules.incomplete import incomplete_rules
from killer_sudoku.solver.engine.solver_engine import SolverEngine
from killer_sudoku.solver.engine.types import Elimination
from killer_sudoku.solver.puzzle_spec import PuzzleSpec

__all__ = [
    "BoardState",
    "SolverEngine",
    "all_rules",
    "default_rules",
    "incomplete_rules",
    "solve",
    "validate_solution",
]


def all_rules() -> list[SolverRule]:
    """Return the full rule set for batch solving (coaching rules + incomplete rules).

    The incomplete rules include LinearElimination and 18 other rules that lack
    hint implementations.  This combined set is used by solve() for maximum
    solving power.

    For the coaching app rule set only, use default_rules().
    """
    return [*default_rules(), *incomplete_rules()]


def solve(
    spec: PuzzleSpec, given_digits: npt.NDArray[np.intp] | None = None
) -> BoardState:
    """Run the full solver engine on a validated PuzzleSpec.

    Constructs BoardState with virtual cages (required by LinearElimination) and
    runs the main loop with all_rules() until no further progress is possible.

    If given_digits is provided, pre-eliminates all non-given candidates from
    the given cells before seeding the engine, so fixed digits propagate
    through all rules (HiddenSingle, NakedSingle, peer cleanup, etc.) exactly
    like any other elimination.

    Args:
        spec: A validated PuzzleSpec from validate_cage_layout().
        given_digits: Optional (9, 9) array of pre-fixed digits (0 = empty).
            Used for classic sudoku puzzles where given clues must constrain
            the candidate sets from the outset.

    Returns:
        The final BoardState. Fully-solved cells have len(candidates[r][c]) == 1.
    """
    board = BoardState(spec, include_virtual_cages=True)
    engine = SolverEngine(board, rules=all_rules())
    if given_digits is not None:
        for r in range(9):
            for c in range(9):
                d = int(given_digits[r, c])
                if d > 0:
                    engine.apply_eliminations(
                        [
                            Elimination(cell=(r, c), digit=other)
                            for other in range(1, 10)
                            if other != d and other in board.candidates[r][c]
                        ]
                    )
    return engine.solve()
