"""Tests for the MRV backtracker fallback."""

from __future__ import annotations

import numpy as np

from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.engine import mrv_backtrack, solve
from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rules import default_rules
from killer_sudoku.solver.engine.rules.incomplete import incomplete_rules
from killer_sudoku.solver.engine.solver_engine import SolverEngine
from killer_sudoku.solver.engine.types import Elimination
from tests.fixtures.sudoku.easy_fixture import GIVEN_DIGITS as EASY_GIVEN
from tests.fixtures.sudoku.easy_fixture import SOLUTION as EASY_SOLUTION
from tests.fixtures.sudoku.hard_fixture import GIVEN_DIGITS as HARD_GIVEN


def _classic_spec() -> object:
    """Build a PuzzleSpec with 9 column cages (each summing to 45)."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    for r in range(9):
        cage_totals[0, r] = 45
    border_x = np.ones((9, 8), dtype=bool)
    border_y = np.zeros((8, 9), dtype=bool)
    return validate_cage_layout(cage_totals, border_x, border_y)


def _all_rules() -> list:  # type: ignore[type-arg]
    return [*default_rules(), *incomplete_rules()]


def _stalled_board(spec: object, given: np.ndarray) -> BoardState:
    """Run the rule engine without the backtracker, returning the partial state."""
    board = BoardState(spec, include_virtual_cages=True)  # type: ignore[arg-type]
    engine = SolverEngine(board, rules=_all_rules())
    for r in range(9):
        for c in range(9):
            d = int(given[r, c])
            if d > 0:
                engine.apply_eliminations(
                    [
                        Elimination(cell=(r, c), digit=other)
                        for other in range(1, 10)
                        if other != d and other in board.candidates[r][c]
                    ]
                )
    return engine.solve()


class TestMrvBacktrack:
    def test_returns_none_when_cell_has_no_candidates(self) -> None:
        """mrv_backtrack returns None when a cell has an empty candidate set."""
        spec = _classic_spec()
        board = BoardState(spec, include_virtual_cages=True)  # type: ignore[arg-type]
        # Solve all cells to their easy-fixture answers first, then empty one cell.
        given = np.array(EASY_GIVEN, dtype=np.intp)
        fully_solved = solve(spec, given)  # type: ignore[arg-type]
        for r in range(9):
            for c in range(9):
                board.candidates[r][c] = set(fully_solved.candidates[r][c])
        # Empty one cell's candidate set — guaranteed unsolvable.
        board.candidates[4][4] = set()
        result = mrv_backtrack(board)
        assert result is None

    def test_solves_easy_puzzle(self) -> None:
        """mrv_backtrack completes the easy puzzle when called on the stalled board."""
        spec = _classic_spec()
        given = np.array(EASY_GIVEN, dtype=np.intp)
        board = _stalled_board(spec, given)
        # Easy puzzle should already be fully solved by the rule engine.
        # Call backtracker anyway — it must succeed.
        result = mrv_backtrack(board)
        assert result is not None
        assert result.shape == (9, 9)

    def test_solve_easy_via_public_api_matches_solution(self) -> None:
        """solve() on the easy puzzle returns the known correct solution."""
        spec = _classic_spec()
        given = np.array(EASY_GIVEN, dtype=np.intp)
        board = solve(spec, given)  # type: ignore[arg-type]
        assert all(len(board.candidates[r][c]) == 1 for r in range(9) for c in range(9))
        assert EASY_SOLUTION is not None
        for r in range(9):
            for c in range(9):
                assert next(iter(board.candidates[r][c])) == EASY_SOLUTION[r][c], (
                    f"Cell ({r},{c}): got {next(iter(board.candidates[r][c]))}, "
                    f"expected {EASY_SOLUTION[r][c]}"
                )

    def test_solve_hard_puzzle_returns_full_board(self) -> None:
        """solve() on the hard (ambiguous) puzzle completes all 81 cells."""
        spec = _classic_spec()
        given = np.array(HARD_GIVEN, dtype=np.intp)
        board = solve(spec, given)  # type: ignore[arg-type]

        # Every cell must be solved.
        unsolved = [
            (r, c)
            for r in range(9)
            for c in range(9)
            if len(board.candidates[r][c]) != 1
        ]
        assert unsolved == [], f"Cells still unsolved: {unsolved}"

        # The found solution must satisfy all sudoku constraints.
        solution = [
            [next(iter(board.candidates[r][c])) for c in range(9)] for r in range(9)
        ]
        for r in range(9):
            assert sorted(solution[r]) == list(range(1, 10)), f"Row {r} invalid"
        for c in range(9):
            col = [solution[r][c] for r in range(9)]
            assert sorted(col) == list(range(1, 10)), f"Col {c} invalid"
        for br in range(3):
            for bc in range(3):
                box = [
                    solution[br * 3 + dr][bc * 3 + dc]
                    for dr in range(3)
                    for dc in range(3)
                ]
                assert sorted(box) == list(range(1, 10)), f"Box {br},{bc} invalid"
        # Given digits must be present.
        for r in range(9):
            for c in range(9):
                if HARD_GIVEN[r][c] != 0:
                    assert solution[r][c] == HARD_GIVEN[r][c], (
                        f"Given ({r},{c}) violated"
                    )
