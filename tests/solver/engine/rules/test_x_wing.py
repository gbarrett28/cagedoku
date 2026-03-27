"""Tests for R12 X-Wing."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.incomplete.x_wing import XWing
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_x_wing_eliminates_from_columns() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)

    # X-Wing for digit 9: rows 0 and 3 each have 9 only in cols 2 and 5
    for r in range(9):
        for c in range(9):
            if r in (0, 3):
                if c not in (2, 5):
                    bs.candidates[r][c].discard(9)

    ctx = RuleContext(
        unit=None,
        cell=None,
        board=bs,
        hint=Trigger.GLOBAL,
        hint_digit=None,
    )
    elims = XWing().apply(ctx)
    elim_cells = {e.cell for e in elims if e.digit == 9}

    # Digit 9 should be eliminated from cols 2 and 5 in all rows except 0 and 3
    for r in range(9):
        if r not in (0, 3):
            if 9 in bs.candidates[r][2]:
                assert (r, 2) in elim_cells
            if 9 in bs.candidates[r][5]:
                assert (r, 5) in elim_cells


def test_x_wing_no_false_eliminations() -> None:
    """X-Wing should never eliminate from the defining rows."""
    spec = make_trivial_spec()
    bs = BoardState(spec)

    for r in range(9):
        for c in range(9):
            if r in (0, 3):
                if c not in (2, 5):
                    bs.candidates[r][c].discard(9)

    ctx = RuleContext(
        unit=None, cell=None, board=bs, hint=Trigger.GLOBAL, hint_digit=None
    )
    elims = XWing().apply(ctx)

    for e in elims:
        if e.digit == 9:
            r, _ = e.cell
            assert r not in (0, 3), (
                f"X-Wing incorrectly eliminated from defining row {r}"
            )
