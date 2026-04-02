"""Tests for R10 PointingPairs."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.pointing_pairs import PointingPairs
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_pointing_pairs_eliminates_from_row() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)

    # Box 0: rows 0-2, cols 0-2
    box_uid = bs.box_unit_id(0, 0)
    box = bs.units[box_uid]

    # Confine digit 5 to row 0 within box 0 only: (0,0),(0,1),(0,2)
    for r in range(1, 3):
        for c in range(3):
            bs.candidates[r][c].discard(5)

    ctx = RuleContext(
        unit=box,
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    result = PointingPairs().apply(ctx)
    elims = result.eliminations
    elim_map = {e.cell: e.digit for e in elims if e.digit == 5}

    # 5 should be eliminated from (0,3)..(0,8) — rest of row 0 outside box 0
    for c in range(3, 9):
        assert (0, c) in elim_map


def test_pointing_pairs_col_variant() -> None:
    """Digit confined to one column within a box eliminates from rest of that col."""
    spec = make_trivial_spec()
    bs = BoardState(spec)

    # Box 0: rows 0-2, cols 0-2. Confine digit 8 to col 0 within box 0.
    for r in range(3):
        for c in range(1, 3):
            bs.candidates[r][c].discard(8)

    box_uid = bs.box_unit_id(0, 0)
    ctx = RuleContext(
        unit=bs.units[box_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    result = PointingPairs().apply(ctx)
    elims = result.eliminations
    elim_map = {e.cell: e.digit for e in elims if e.digit == 8}

    # 8 should be eliminated from col 0, rows 3-8
    for r in range(3, 9):
        assert (r, 0) in elim_map
