"""Tests for R1b CellSolutionElimination."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.cell_solution_elimination import (
    CellSolutionElimination,
)
from killer_sudoku.solver.engine.types import Trigger, UnitKind
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_cell_solution_elimination_eliminates_from_row_peers() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    bs.candidates[0][0] = {5}
    ctx = RuleContext(
        unit=None,
        cell=(0, 0),
        board=bs,
        hint=Trigger.CELL_SOLVED,
        hint_digit=5,
    )
    elims = CellSolutionElimination().apply(ctx)
    elim_cells = {e.cell for e in elims}
    assert all(e.digit == 5 for e in elims)
    # Row peers
    for c in range(1, 9):
        assert (0, c) in elim_cells
    # Col peers
    for r in range(1, 9):
        assert (r, 0) in elim_cells
    # Box peers (box 0: rows 0-2, cols 0-2, excluding (0,0))
    for r in range(3):
        for c in range(3):
            if (r, c) != (0, 0):
                assert (r, c) in elim_cells


def test_cell_solution_elimination_excludes_cage_peers() -> None:
    """CellSolutionElimination skips cage units — cage logic belongs to R3/R4."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    bs.candidates[0][0] = {5}
    ctx = RuleContext(
        unit=None,
        cell=(0, 0),
        board=bs,
        hint=Trigger.CELL_SOLVED,
        hint_digit=5,
    )
    elims = CellSolutionElimination().apply(ctx)
    # Trivial spec: each cell is its own cage, so no cage-based eliminations
    # are generated. The result should only cover row/col/box cells.
    for e in elims:
        # Verify every elimination target is in a non-cage unit shared with (0,0)
        r, c = e.cell
        non_cage_uids = {
            uid for uid in bs.cell_unit_ids(0, 0) if bs.units[uid].kind != UnitKind.CAGE
        }
        shared = any((r, c) in bs.units[uid].cells for uid in non_cage_uids)
        assert shared, f"Cell {e.cell} not in any non-cage unit of (0,0)"


def test_cell_solution_elimination_fires_on_cell_solved() -> None:
    """CellSolutionElimination must declare CELL_SOLVED as its trigger."""
    assert Trigger.CELL_SOLVED in CellSolutionElimination.triggers
    assert Trigger.CELL_DETERMINED not in CellSolutionElimination.triggers
