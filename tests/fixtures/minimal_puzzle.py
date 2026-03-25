"""Minimal programmatic puzzle fixture for testing.

Constructs a valid 9x9 killer sudoku where every cell is its own cage.
This is the simplest possible puzzle: each cage has exactly one cell and
its total equals the digit that must go there (derived from a known solution).

No image files, model files, or external resources are required.
"""

import numpy as np
import numpy.typing as npt

from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.puzzle_spec import PuzzleSpec

# A known valid sudoku solution used as the basis for the trivial puzzle.
KNOWN_SOLUTION: list[list[int]] = [
    [5, 3, 4, 6, 7, 8, 9, 1, 2],
    [6, 7, 2, 1, 9, 5, 3, 4, 8],
    [1, 9, 8, 3, 4, 2, 5, 6, 7],
    [8, 5, 9, 7, 6, 1, 4, 2, 3],
    [4, 2, 6, 8, 5, 3, 7, 9, 1],
    [7, 1, 3, 9, 2, 4, 8, 5, 6],
    [9, 6, 1, 5, 3, 7, 2, 8, 4],
    [2, 8, 7, 4, 1, 9, 6, 3, 5],
    [3, 4, 5, 2, 8, 6, 1, 7, 9],
]


def make_trivial_cage_totals() -> npt.NDArray[np.intp]:
    """Return a (9, 9) array where every cell is its own single-cell cage.

    The value in each cell equals the digit that must go there (from KNOWN_SOLUTION).
    """
    return np.array(KNOWN_SOLUTION, dtype=np.intp)


def make_trivial_border_x() -> npt.NDArray[np.bool_]:
    """Return a (9, 8) border_x array where every inter-cell edge is a cage wall.

    Every cell is its own cage, so all horizontal borders are True (wall present).
    border_x[col, row] = True means a wall between rows row and row+1 in column col.
    """
    return np.ones((9, 8), dtype=bool)


def make_trivial_border_y() -> npt.NDArray[np.bool_]:
    """Return a (8, 9) border_y array where every inter-cell edge is a cage wall.

    Every cell is its own cage, so all vertical borders are True (wall present).
    border_y[row, col] = True means a wall between columns col and col+1 in row row.
    """
    return np.ones((8, 9), dtype=bool)


def make_trivial_spec() -> PuzzleSpec:
    """Return a fully-validated PuzzleSpec for the trivial single-cell-cage puzzle."""
    return validate_cage_layout(
        make_trivial_cage_totals(),
        make_trivial_border_x(),
        make_trivial_border_y(),
    )


# First-row triplet values from KNOWN_SOLUTION: 5 + 3 + 4 = 12
THREE_CELL_CAGE_CELLS = ((0, 0), (0, 1), (0, 2))
THREE_CELL_CAGE_TOTAL = (
    KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1] + KNOWN_SOLUTION[0][2]
)  # = 12


def make_three_cell_cage_spec() -> PuzzleSpec:
    """Return a PuzzleSpec where BoardState cells (0,0), (0,1), (0,2) form one cage.

    All other cells remain as single-cell cages (from KNOWN_SOLUTION values).
    The 3-cell cage total is 12 (KNOWN_SOLUTION[0][0]+[0][1]+[0][2] = 5+3+4).

    Border convention (from validation.py): border_x[col, row] controls the wall
    between rows `row` and `row+1` in column `col`. BoardState cell (r, c)
    corresponds to validation (col=r, row=c), so walls between (0,0)-(0,1) and
    (0,1)-(0,2) are at border_x[0, 0] and border_x[0, 1] respectively.

    This fixture is used to test rules that require multi-cell cages
    (e.g. SolutionMapFilter per-cell feasibility) without loading image files.
    """
    totals = make_trivial_cage_totals().copy()
    # Cage label goes in the first cell; other cage cells get 0
    totals[0, 0] = THREE_CELL_CAGE_TOTAL
    totals[0, 1] = 0
    totals[0, 2] = 0

    border_x = make_trivial_border_x().copy()
    border_y = make_trivial_border_y()
    # Remove walls between BoardState (0,0)↔(0,1) and (0,1)↔(0,2)
    # border_x[col=0, row=0] → wall between validation (0,0) and (0,1)
    # border_x[col=0, row=1] → wall between validation (0,1) and (0,2)
    border_x[0, 0] = False
    border_x[0, 1] = False

    return validate_cage_layout(totals, border_x, border_y)


# Cells (0,0) and (0,1) from KNOWN_SOLUTION: 5 + 3 = 8
TWO_CELL_CAGE_CELLS = ((0, 0), (0, 1))
TWO_CELL_CAGE_TOTAL = KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1]  # = 8


def make_two_cell_cage_spec() -> PuzzleSpec:
    """Return a PuzzleSpec where BoardState cells (0,0) and (0,1) form one cage.

    All other cells remain as single-cell cages.
    Cage total = 8 (KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1] = 5 + 3).
    sol_sums(2, 0, 8) = [{1,7}, {2,6}, {3,5}] — three valid combinations.

    Border removal: border_x[col=0, row=0] controls the wall between
    validation (0,0) and (0,1), i.e. BoardState cells (0,0) and (0,1).
    """
    totals = make_trivial_cage_totals().copy()
    totals[0, 0] = TWO_CELL_CAGE_TOTAL
    totals[0, 1] = 0

    border_x = make_trivial_border_x().copy()
    border_x[0, 0] = False  # remove wall between (0,0) and (0,1)

    return validate_cage_layout(totals, border_x, make_trivial_border_y())
