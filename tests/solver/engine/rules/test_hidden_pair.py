"""Tests for R8 HiddenPair."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.incomplete.hidden_pair import HiddenPair
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_hidden_pair_restricts_pair_cells() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row_uid = bs.row_unit_id(0)

    # Digits 3 and 7 appear only in cells (0,2) and (0,5)
    for c in range(9):
        if c not in (2, 5):
            bs.candidates[0][c].discard(3)
            bs.candidates[0][c].discard(7)
    bs.counts[row_uid][3] = 2
    bs.counts[row_uid][7] = 2

    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_HIT_TWO,
        hint_digit=3,
    )
    result = HiddenPair().apply(ctx)
    elims = result.eliminations
    elim_map: dict[tuple[int, int], set[int]] = {}
    for e in elims:
        elim_map.setdefault(e.cell, set()).add(e.digit)

    # Each of (0,2) and (0,5) should lose everything except {3,7}
    for c in (2, 5):
        removed = elim_map.get((0, c), set())
        remaining = bs.candidates[0][c] - removed
        assert remaining <= {3, 7}


def test_hidden_pair_no_match_returns_empty() -> None:
    """If no second digit shares the same two cells, return empty."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row_uid = bs.row_unit_id(0)
    # Digit 3 in (0,2) and (0,5); digit 7 in (0,2) and (0,3) — different cells
    for c in range(9):
        bs.candidates[0][c].discard(3)
        bs.candidates[0][c].discard(7)
    bs.candidates[0][2].add(3)
    bs.candidates[0][5].add(3)
    bs.candidates[0][2].add(7)
    bs.candidates[0][3].add(7)
    bs.counts[row_uid][3] = 2
    bs.counts[row_uid][7] = 2
    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_HIT_TWO,
        hint_digit=3,
    )
    assert HiddenPair().apply(ctx).eliminations == []
