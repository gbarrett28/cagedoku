"""Tests for killer_sudoku.solver.grid."""

import pytest

from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.output.sol_image import SolImage
from killer_sudoku.solver.grid import Grid, ProcessingError
from killer_sudoku.solver.puzzle_spec import build_brdrs
from tests.fixtures.minimal_puzzle import (
    KNOWN_SOLUTION,
    make_trivial_border_x,
    make_trivial_border_y,
    make_trivial_cage_totals,
    make_trivial_spec,
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
    g.set_up(make_trivial_spec())
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
    g.set_up(make_trivial_spec())
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
# validate_cage_layout: ProcessingError on incomplete cage layout
# ---------------------------------------------------------------------------


def test_validate_cage_layout_unassigned_cell() -> None:
    """validate_cage_layout raises ProcessingError when a cell is left unassigned.

    We deliberately zero the top-left cell's total so no cage head covers it.
    With all-True borders every cell is isolated, so cell (0,0) has no cage.
    """
    cage_totals = make_trivial_cage_totals().copy()
    cage_totals[0, 0] = 0  # Remove the cage-leader marking for cell (0,0)
    with pytest.raises(ProcessingError):
        validate_cage_layout(
            cage_totals, make_trivial_border_x(), make_trivial_border_y()
        )


# ---------------------------------------------------------------------------
# PuzzleSpec.brdrs property
# ---------------------------------------------------------------------------


def test_puzzle_spec_brdrs_all_walls() -> None:
    """PuzzleSpec.brdrs expands all-True border_x/border_y to all-True (9,9,4)."""
    spec = make_trivial_spec()
    brdrs = spec.brdrs
    assert brdrs.shape == (9, 9, 4)
    assert brdrs.all(), "All borders should be True when every cell is its own cage"


def test_puzzle_spec_brdrs_open_interior() -> None:
    """build_brdrs correctly reflects open (False) borders in the expanded form."""
    border_x = make_trivial_border_x().copy()
    border_x[:, 0] = False  # Open wall between row 0 and row 1 for every column
    border_y = make_trivial_border_y()

    expanded = build_brdrs(border_x, border_y)
    assert expanded.shape == (9, 9, 4)
    # border_x[col=0, row=0] = False → right border of (row=0, col=0) is open
    assert not expanded[0, 0, 1], "Right border should be open for (row=0, col=0)"
    assert not expanded[1, 0, 3], "Left border of (row=1, col=0) should match"
