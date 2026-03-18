"""Solver engine public API.

Entry point: solve(spec) builds a BoardState, applies LinearSystem initial
eliminations, runs the engine main loop with all default rules, and returns
the final BoardState. The caller checks whether the board is fully solved.
"""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rules import default_rules
from killer_sudoku.solver.engine.solver_engine import SolverEngine
from killer_sudoku.solver.puzzle_spec import PuzzleSpec


def solve(spec: PuzzleSpec) -> BoardState:
    """Run the full solver engine on a validated PuzzleSpec.

    Constructs BoardState, propagates LinearSystem initial eliminations through
    the engine (so rules can react to them), then runs the main loop until no
    further progress is possible.

    Args:
        spec: A validated PuzzleSpec from validate_cage_layout().

    Returns:
        The final BoardState. Fully-solved cells have len(candidates[r][c]) == 1.
    """
    board = BoardState(spec)
    engine = SolverEngine(board, rules=default_rules())
    # Route initial eliminations through the engine so triggered rules fire
    engine.apply_eliminations(
        [
            e
            for e in board.linear_system.initial_eliminations
            if e.digit in board.candidates[e.cell[0]][e.cell[1]]
        ]
    )
    return engine.solve()
