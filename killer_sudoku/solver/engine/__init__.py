"""Solver engine public API.

Entry point: solve(spec) builds a BoardState, runs the engine main loop
with all default rules (including LinearElimination as a GLOBAL rule),
and returns the final BoardState. The caller checks whether the board is
fully solved.
"""

from killer_sudoku.solver.engine.board_state import BoardState, validate_solution
from killer_sudoku.solver.engine.hint import HintableRule, collect_hints
from killer_sudoku.solver.engine.rules import default_rules
from killer_sudoku.solver.engine.solver_engine import SolverEngine
from killer_sudoku.solver.puzzle_spec import PuzzleSpec

__all__ = [
    "BoardState",
    "HintableRule",
    "SolverEngine",
    "collect_hints",
    "default_rules",
    "solve",
    "validate_solution",
]


def solve(spec: PuzzleSpec) -> BoardState:
    """Run the full solver engine on a validated PuzzleSpec.

    Constructs BoardState and runs the main loop with all default rules until
    no further progress is possible.  LinearElimination fires as a GLOBAL rule
    during the first pass, so no explicit pre-seeding is needed.

    Args:
        spec: A validated PuzzleSpec from validate_cage_layout().

    Returns:
        The final BoardState. Fully-solved cells have len(candidates[r][c]) == 1.
    """
    board = BoardState(spec)
    engine = SolverEngine(board, rules=default_rules())
    return engine.solve()
