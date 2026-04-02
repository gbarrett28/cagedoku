"""Tests for R5 MustContain."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.must_contain import MustContain
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_must_contain_no_crash_on_trivial() -> None:
    """MustContain should not crash on a fresh trivial board."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row0_uid = bs.row_unit_id(0)
    ctx = RuleContext(
        unit=bs.units[row0_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    result = MustContain().apply(ctx)
    elims = result.eliminations
    assert isinstance(elims, list)


def test_must_contain_returns_list() -> None:
    """MustContain returns a list (possibly empty) for all unit types."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    for uid in range(len(bs.units)):
        unit = bs.units[uid]
        ctx = RuleContext(
            unit=unit,
            cell=None,
            board=bs,
            hint=Trigger.COUNT_DECREASED,
            hint_digit=None,
        )
        result = MustContain().apply(ctx)
        # apply() now returns RuleResult; eliminations is the list
        assert isinstance(result.eliminations, list)
