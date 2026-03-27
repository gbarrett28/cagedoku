"""Solver engine public API.

Entry point: solve(spec) builds a BoardState, runs the engine main loop with
all_rules() (coaching rules + incomplete rules including LinearElimination),
and returns the final BoardState. The caller checks whether the board is fully solved.

For the coaching app, use default_rules() which contains only rules that have
hint implementations and can be surfaced via the config modal.
"""

from killer_sudoku.solver.engine.board_state import BoardState, validate_solution
from killer_sudoku.solver.engine.hint import HintableRule, collect_hints
from killer_sudoku.solver.engine.rule import SolverRule
from killer_sudoku.solver.engine.rules import default_rules
from killer_sudoku.solver.engine.rules.incomplete import incomplete_rules
from killer_sudoku.solver.engine.solver_engine import SolverEngine
from killer_sudoku.solver.puzzle_spec import PuzzleSpec

__all__ = [
    "BoardState",
    "HintableRule",
    "SolverEngine",
    "all_rules",
    "collect_hints",
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


def solve(spec: PuzzleSpec) -> BoardState:
    """Run the full solver engine on a validated PuzzleSpec.

    Constructs BoardState with virtual cages (required by LinearElimination) and
    runs the main loop with all_rules() until no further progress is possible.

    Args:
        spec: A validated PuzzleSpec from validate_cage_layout().

    Returns:
        The final BoardState. Fully-solved cells have len(candidates[r][c]) == 1.
    """
    board = BoardState(spec, include_virtual_cages=True)
    engine = SolverEngine(board, rules=all_rules())
    return engine.solve()
