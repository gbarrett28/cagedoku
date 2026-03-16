"""Tests for killer_sudoku.solver.grid."""

import pytest

from killer_sudoku.output.sol_image import SolImage
from killer_sudoku.solver.grid import Grid, ProcessingError
from tests.fixtures.minimal_puzzle import (
    KNOWN_SOLUTION,
    make_trivial_borders,
    make_trivial_cage_totals,
)

# ---------------------------------------------------------------------------
# Grid construction
# ---------------------------------------------------------------------------


def test_grid_init() -> None:
    """Grid() starts with all 81 cells having candidates 1-9."""
    g = Grid()
    for i in range(9):
        for j in range(9):
            assert g.sq_poss[i][j] == set(range(1, 10))


def test_grid_with_injected_sol_image() -> None:
    """Grid accepts an externally constructed SolImage without error."""
    img = SolImage()
    g = Grid(sol_img=img)
    assert g.sol_img is img


# ---------------------------------------------------------------------------
# Grid.set_up with trivial puzzle
# ---------------------------------------------------------------------------


def test_grid_set_up_trivial() -> None:
    """set_up() with the trivial single-cell puzzle populates all regions."""
    g = Grid()
    cage_totals = make_trivial_cage_totals()
    borders = make_trivial_borders()
    g.set_up(cage_totals, borders)
    # All 81 cells should be assigned to a region (non-zero)
    assert (g.region != 0).all()
    # Should have exactly 81 cages (one per cell)
    assert len(g.CAGES) == 81


# ---------------------------------------------------------------------------
# Grid.solve with trivial puzzle
# ---------------------------------------------------------------------------


def test_grid_solve_trivial() -> None:
    """solve() on the trivial single-cell puzzle yields the known solution."""
    g = Grid()
    cage_totals = make_trivial_cage_totals()
    borders = make_trivial_borders()
    g.set_up(cage_totals, borders)
    alts_sum, _ = g.solve()
    # Every cell is fully determined: exactly 81 single-element candidate sets
    assert alts_sum == 81
    for i in range(9):
        for j in range(9):
            assert g.sq_poss[i][j] == {KNOWN_SOLUTION[i][j]}, (
                f"Cell ({i},{j}): expected {{{KNOWN_SOLUTION[i][j]}}}, "
                f"got {g.sq_poss[i][j]}"
            )


# ---------------------------------------------------------------------------
# ProcessingError
# ---------------------------------------------------------------------------


def test_grid_processing_error_on_unassigned_cell() -> None:
    """set_up() raises ProcessingError when a cell is left unassigned.

    We deliberately give a borders array that creates an island with no
    cage-total entry, so mark_region is never called for it.
    """
    g = Grid()
    # Use real cage totals but suppress the top-left cell's total to create
    # an unassigned region. The top-left cell (0,0) has KNOWN_SOLUTION value 5;
    # zeroing it means no cage total entry is provided for cells reachable from it.
    cage_totals = make_trivial_cage_totals().copy()
    cage_totals[0, 0] = 0  # Remove the cage-leader marking for cell (0,0)
    borders = make_trivial_borders()
    with pytest.raises(ProcessingError):
        g.set_up(cage_totals, borders)
