"""Tests for R7 NakedPair."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.naked_pair import NakedPair
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_naked_pair_eliminates_from_rest() -> None:
    """When cells (0,0) and (0,1) each have {4,6}, 6 is eliminated from all other
    row cells (d1=4 is already absent from other cells since count(4)=2)."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row_uid = bs.row_unit_id(0)

    # Pair cells: both have exactly {4,6}
    bs.candidates[0][0] = {4, 6}
    bs.candidates[0][1] = {4, 6}
    # Other cells: include d2=6 but not d1=4 (so count(4)==2, as COUNT_HIT_TWO requires)
    for c in range(2, 9):
        bs.candidates[0][c] = {1, 2, 3, 5, 6, 7, 8, 9}

    # Sync counts
    for d in range(1, 10):
        bs.counts[row_uid][d] = sum(1 for c in range(9) if d in bs.candidates[0][c])

    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_HIT_TWO,
        hint_digit=4,
    )
    elims = NakedPair().apply(ctx)
    elim_map: dict[tuple[int, int], set[int]] = {}
    for e in elims:
        elim_map.setdefault(e.cell, set()).add(e.digit)

    # d2=6 should be eliminated from (0,2)..(0,8); d1=4 is already absent there
    for c in range(2, 9):
        assert 6 in elim_map.get((0, c), set())
    # NOT eliminated from the pair cells themselves
    assert (0, 0) not in elim_map
    assert (0, 1) not in elim_map


def test_naked_pair_no_match_returns_empty() -> None:
    """If the two cells for hint_digit don't share the same pair, return empty."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row_uid = bs.row_unit_id(0)
    bs.candidates[0][0] = {4, 6}
    bs.candidates[0][1] = {4, 7}  # different second digit — not a naked pair
    bs.counts[row_uid][4] = 2
    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_HIT_TWO,
        hint_digit=4,
    )
    assert NakedPair().apply(ctx) == []
