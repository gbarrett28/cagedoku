"""Tests for R1a NakedSingle."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.naked_single import NakedSingle
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_naked_single_returns_no_eliminations() -> None:
    """NakedSingle is a recognition-only rule: it produces no eliminations."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    bs.candidates[0][0] = {5}
    ctx = RuleContext(
        unit=None,
        cell=(0, 0),
        board=bs,
        hint=Trigger.CELL_DETERMINED,
        hint_digit=5,
    )
    assert NakedSingle().apply(ctx) == []


def test_naked_single_fires_on_cell_determined() -> None:
    """NakedSingle must declare CELL_DETERMINED as its trigger."""
    assert Trigger.CELL_DETERMINED in NakedSingle.triggers
