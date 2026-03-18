"""Tests for R6 DeltaConstraint."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.delta_constraint import DeltaConstraint
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_delta_constraint_narrows_candidates() -> None:
    """With pair (0,0)-(0,1) delta=2: (0,0) loses {1,2}, (0,1) loses {8,9}."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    # Reset to full candidates for both cells
    bs.candidates[0][0] = set(range(1, 10))
    bs.candidates[0][1] = set(range(1, 10))
    # Inject a synthetic pair
    pair: tuple[tuple[int, int], tuple[int, int], int] = ((0, 0), (0, 1), 2)
    bs.linear_system.delta_pairs.append(pair)
    bs.linear_system._pairs_by_cell.setdefault((0, 0), []).append(pair)
    bs.linear_system._pairs_by_cell.setdefault((0, 1), []).append(pair)

    row_uid = bs.row_unit_id(0)
    ctx = RuleContext(
        unit=bs.units[row_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    elims = DeltaConstraint().apply(ctx)
    elim_map: dict[tuple[int, int], set[int]] = {}
    for e in elims:
        elim_map.setdefault(e.cell, set()).add(e.digit)
    # (0,0) - (0,1) = 2 means (0,0) must be >= 3; (0,1) must be <= 7
    assert {1, 2} <= elim_map.get((0, 0), set())
    assert {8, 9} <= elim_map.get((0, 1), set())


def test_delta_constraint_skips_cell_determined() -> None:
    """CELL_DETERMINED trigger is handled by LinearSystem — rule returns empty."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    ctx = RuleContext(
        unit=None,
        cell=(0, 0),
        board=bs,
        hint=Trigger.CELL_DETERMINED,
        hint_digit=5,
    )
    assert DeltaConstraint().apply(ctx) == []
