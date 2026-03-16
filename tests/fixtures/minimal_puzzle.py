"""Minimal programmatic puzzle fixture for testing.

Constructs a valid 9x9 killer sudoku where every cell is its own cage.
This is the simplest possible puzzle: each cage has exactly one cell and
its total equals the digit that must go there (derived from a known solution).

No image files, model files, or external resources are required.
"""

import numpy as np
import numpy.typing as npt

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


def make_trivial_borders() -> npt.NDArray[np.bool_]:
    """Return a (9, 9, 4) array where every inter-cell edge is a cage border.

    Every cell is its own cage, so all borders are True.
    """
    return np.ones((9, 9, 4), dtype=bool)
