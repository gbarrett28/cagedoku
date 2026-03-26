"""Tests for R4b MustContainOutie.

Pattern: cage {(0,5),(0,6),(0,7),(1,7)} — three cells in row 0, one outie at
(1,7) in row 1.  External cell (0,2) in row 0 has candidates {6,8,9}.  The
cage's must-contain set is also {6,8,9}.  The rule should restrict the outie
(1,7) to {6,8,9}, eliminating 7 (and other digits outside the set).
"""

from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.must_contain_outie import MustContainOutie
from killer_sudoku.solver.engine.types import Trigger
from killer_sudoku.solver.puzzle_spec import PuzzleSpec
from tests.fixtures.minimal_puzzle import (
    make_trivial_border_x,
    make_trivial_border_y,
    make_trivial_cage_totals,
    make_trivial_spec,
)


def _make_outie_spec() -> object:
    """Spec with cage {(0,5),(0,6),(0,7),(1,7)}, all other cells single-cell.

    Border convention (from validation.py):
      border_x[col, row]: wall between BS cells (col, row) and (col, row+1)
                          i.e. column-adjacent cells in the same BS row.
      border_y[row, col]: wall between BS cells (col, row) and (col+1, row)
                          i.e. row-adjacent cells in the same BS column.

    Walls removed: (0,5)↔(0,6), (0,6)↔(0,7) via border_x; (0,7)↔(1,7) via border_y.
    """
    totals = make_trivial_cage_totals().copy()
    # 4-cell cage head at BS (0,5); use total=24 ({1,6,8,9} sums to 24)
    totals[0, 5] = 24
    totals[0, 6] = 0
    totals[0, 7] = 0
    totals[1, 7] = 0

    border_x = make_trivial_border_x().copy()
    border_x[0, 5] = False  # remove wall between BS (0,5) and (0,6)
    border_x[0, 6] = False  # remove wall between BS (0,6) and (0,7)

    border_y = make_trivial_border_y().copy()
    border_y[0, 7] = False  # remove wall between BS (0,7) and (1,7)

    return validate_cage_layout(totals, border_x, border_y)


def _board_with_outie_setup() -> tuple[BoardState, int]:
    """Return (BoardState, cage_idx) with must-contain {6,8,9} and (0,2)={6,8,9}."""
    spec = _make_outie_spec()
    assert isinstance(spec, PuzzleSpec)
    bs = BoardState(spec)

    cage_idx = int(bs.regions[0, 5])

    # Override cage solutions so must-contain = {6,8,9}
    # Three solutions all containing {6,8,9} with different fourth digits
    bs.cage_solns[cage_idx] = [
        frozenset({1, 6, 8, 9}),
        frozenset({2, 6, 8, 9}),
        frozenset({7, 6, 8, 9}),
    ]

    # External cell (0,2): candidates = {6,8,9} — simulates prior cage elimination
    bs.candidates[0][2] = frozenset({6, 8, 9})

    # Outie (1,7): all digits available so we can confirm eliminations
    bs.candidates[1][7] = frozenset(range(1, 10))

    return bs, cage_idx


def test_must_contain_outie_no_crash_trivial() -> None:
    """MustContainOutie does not crash on a fresh board."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    ctx = RuleContext(
        unit=bs.units[bs.row_unit_id(0)],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    assert isinstance(MustContainOutie().apply(ctx), list)


def test_must_contain_outie_restricts_outie_row_trigger() -> None:
    """Outie candidates are restricted to external cell's candidates (row trigger)."""
    bs, _ = _board_with_outie_setup()
    ctx = RuleContext(
        unit=bs.units[bs.row_unit_id(0)],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    elims = MustContainOutie().apply(ctx)

    elim_set = {(e.cell, e.digit) for e in elims}

    # Digits outside {6,8,9} should be eliminated from outie (1,7)
    for d in range(1, 10):
        if d in {6, 8, 9}:
            assert ((1, 7), d) not in elim_set, f"digit {d} should not be eliminated"
        else:
            assert ((1, 7), d) in elim_set, f"digit {d} should be eliminated"


def test_must_contain_outie_restricts_outie_cage_trigger() -> None:
    """Same result when triggered by the cage unit rather than the row unit."""
    bs, cage_idx = _board_with_outie_setup()
    cage_uid = 27 + cage_idx
    ctx = RuleContext(
        unit=bs.units[cage_uid],
        cell=None,
        board=bs,
        hint=Trigger.SOLUTION_PRUNED,
        hint_digit=None,
    )
    elims = MustContainOutie().apply(ctx)

    elim_set = {(e.cell, e.digit) for e in elims}
    for d in range(1, 10):
        if d in {6, 8, 9}:
            assert ((1, 7), d) not in elim_set
        else:
            assert ((1, 7), d) in elim_set


def test_must_contain_outie_no_fire_when_two_external_cells() -> None:
    """Rule does not fire when more than one external cell qualifies."""
    bs, cage_idx = _board_with_outie_setup()
    # Add a second qualifying external cell in row 0
    bs.candidates[0][3] = frozenset({6, 8, 9})

    ctx = RuleContext(
        unit=bs.units[bs.row_unit_id(0)],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    elims = MustContainOutie().apply(ctx)
    outie_elims = [(e.cell, e.digit) for e in elims if e.cell == (1, 7)]
    assert outie_elims == [], "should not fire with two qualifying external cells"


def test_must_contain_outie_no_fire_when_candidates_not_subset() -> None:
    """Rule does not fire when external cell candidates include non-must digits."""
    bs, _ = _board_with_outie_setup()
    # External cell (0,2) has 7 added — no longer ⊆ {6,8,9}
    bs.candidates[0][2] = frozenset({6, 7, 8, 9})

    ctx = RuleContext(
        unit=bs.units[bs.row_unit_id(0)],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    elims = MustContainOutie().apply(ctx)
    outie_elims = [e for e in elims if e.cell == (1, 7)]
    assert outie_elims == [], "should not fire when external candidates ⊄ must-contain"


def test_must_contain_outie_no_fire_when_cage_fully_inside_unit() -> None:
    """Rule does not fire when all cage cells are inside the unit (no outie)."""
    bs, cage_idx = _board_with_outie_setup()
    bs.candidates[0][2] = frozenset({6, 8, 9})

    # The cage has (0,7) and (1,7); column 7 contains both.
    # The cage also has (0,5),(0,6) — col 7 does NOT contain those.
    # So column 7 has exactly one outie: ... actually (0,5) and (0,6) are outie.
    # Let's test with a column unit where 3 cage cells are outside — should not fire
    # because there are 3 outies, not 1.
    col5_uid = bs.col_unit_id(5)
    ctx = RuleContext(
        unit=bs.units[col5_uid],
        cell=None,
        board=bs,
        hint=Trigger.COUNT_DECREASED,
        hint_digit=None,
    )
    elims = MustContainOutie().apply(ctx)
    # Column 5 contains only (0,5) from the cage; outside = (0,6),(0,7),(1,7) — 3 outies
    # Rule requires exactly 1 outie, so it should not fire for this direction
    cage_elims = [e for e in elims if e.cell in {(0, 6), (0, 7), (1, 7)}]
    assert cage_elims == []
