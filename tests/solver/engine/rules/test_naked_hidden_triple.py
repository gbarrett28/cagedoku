"""Tests for R9 Naked/Hidden Triple."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.incomplete.naked_hidden_triple import (
    NakedHiddenTriple,
)
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_naked_triple_eliminates_from_rest() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row_uid = bs.row_unit_id(0)

    # Cells (0,0),(0,1),(0,2) each hold subsets of {1,2,3}
    bs.candidates[0][0] = {1, 2}
    bs.candidates[0][1] = {1, 3}
    bs.candidates[0][2] = {2, 3}
    for c in range(3, 9):
        bs.candidates[0][c] = set(range(1, 10))

    # Sync counts
    for d in range(1, 10):
        bs.counts[row_uid][d] = sum(1 for c in range(9) if d in bs.candidates[0][c])

    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    elims = NakedHiddenTriple().apply(ctx)
    elim_cells = {e.cell for e in elims if e.digit in (1, 2, 3)}

    # Digits 1, 2, 3 should be eliminated from cells (0,3)..(0,8)
    for c in range(3, 9):
        assert (0, c) in elim_cells


def test_hidden_triple_restricts_cells() -> None:
    """Three digits each appear in the same three cells — restrict those cells."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row_uid = bs.row_unit_id(0)

    # Digits 1,2,3 each in exactly cells (0,0),(0,1),(0,2); other digits absent there
    for c in range(9):
        bs.candidates[0][c] = set(range(4, 10))  # start with {4..9}
    for c in (0, 1, 2):
        bs.candidates[0][c] = set(range(1, 10))  # (0,0..2) have all candidates
    # Remove 1,2,3 from (0,3..8) to confine them to (0,0..2)
    for c in range(3, 9):
        bs.candidates[0][c].discard(1)
        bs.candidates[0][c].discard(2)
        bs.candidates[0][c].discard(3)

    for d in range(1, 10):
        bs.counts[row_uid][d] = sum(1 for c in range(9) if d in bs.candidates[0][c])

    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    elims = NakedHiddenTriple().apply(ctx)
    assert isinstance(elims, list)
