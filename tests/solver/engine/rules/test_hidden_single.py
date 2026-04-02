"""Tests for R2 HiddenSingle."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.incomplete.hidden_single import HiddenSingle
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_hidden_single_places_digit() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    # Remove digit 7 from all cells in row 0 except (0,4)
    for c in range(9):
        if c != 4:
            bs.candidates[0][c].discard(7)
    # Force count to 1 for row 0 digit 7
    row_uid = bs.row_unit_id(0)
    bs.counts[row_uid][7] = 1

    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_HIT_ONE,
        hint_digit=7,
    )
    result = HiddenSingle().apply(ctx)
    elims = result.eliminations
    # Should eliminate all other candidates from (0,4)
    assert all(e.cell == (0, 4) for e in elims)
    assert all(e.digit != 7 for e in elims)
    assert len(elims) == len(bs.candidates[0][4]) - 1


def test_hidden_single_no_sole_cell_returns_empty() -> None:
    """If the digit is somehow absent from all cells, return empty."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row_uid = bs.row_unit_id(0)
    for c in range(9):
        bs.candidates[0][c].discard(3)
    bs.counts[row_uid][3] = 0

    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_HIT_ONE,
        hint_digit=3,
    )
    assert HiddenSingle().apply(ctx).eliminations == []
