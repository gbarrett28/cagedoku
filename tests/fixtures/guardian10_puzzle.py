"""Guardian puzzle 10 spec fixture.

Provides a programmatic PuzzleSpec for the Guardian killer sudoku puzzle 10,
extracted from a confirmed session.  No image files required.

Key structural features used by hint tests:
  Cage D  (label index 3, 1-based region 4): cells r1c6, r1c7, r1c8, r2c8
           total=30, only solution {6,7,8,9}, must-contain={6,7,8,9}.
           MustContainOutie fires (r1c3 has candidates ⊆ {6,7,8,9}).
           CageConfinement n=1 fires for d=7 after MustContainOutie removes 7
           from r2c8.
  Cage B  (label index 1, 1-based region 2): cells r1c3, r2c3, r2c4
           together with cage D both confined to rows 1–2; CageConfinement n=2
           fires for digits {6,8,9}.
"""

from __future__ import annotations

import numpy as np

from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.puzzle_spec import PuzzleSpec

# 1-based cage indices per cell (row-major, 9×9).
_REGIONS: list[list[int]] = [
    [1, 1, 2, 3, 3, 4, 4, 4, 5],
    [6, 6, 2, 2, 7, 7, 8, 4, 5],
    [6, 9, 9, 10, 7, 7, 8, 11, 11],
    [12, 9, 9, 10, 13, 13, 8, 11, 11],
    [12, 14, 15, 15, 13, 13, 16, 16, 16],
    [12, 14, 17, 15, 18, 18, 19, 19, 16],
    [12, 14, 17, 20, 20, 21, 19, 22, 22],
    [23, 17, 17, 20, 20, 21, 19, 24, 22],
    [23, 25, 25, 25, 24, 24, 24, 24, 22],
]

# Cage total at the head cell of each cage; 0 elsewhere.
_CAGE_TOTALS: list[list[int]] = [
    [8, 0, 23, 6, 0, 30, 0, 0, 6],
    [13, 0, 0, 0, 19, 0, 11, 0, 0],
    [0, 21, 0, 11, 0, 0, 0, 20, 0],
    [21, 0, 0, 0, 17, 0, 0, 0, 0],
    [0, 9, 19, 0, 0, 0, 21, 0, 0],
    [0, 0, 21, 0, 7, 0, 25, 0, 0],
    [0, 0, 0, 16, 0, 9, 0, 14, 0],
    [12, 0, 0, 0, 0, 0, 0, 31, 0],
    [0, 15, 0, 0, 0, 0, 0, 0, 0],
]

# Horizontal cage walls: border_x[col][row] = wall between rows row and row+1
# in column col.  Shape (9, 8).
_BORDER_X: list[list[bool]] = [
    [False, True, True, False, True, False, False, True],
    [False, True, False, True, False, True, True, True],
    [True, False, True, True, False, True, True, False],
    [True, False, True, True, False, True, True, False],
    [True, True, False, True, False, True, False, False],
    [True, True, True, True, False, True, False, True],
    [True, True, True, False, True, True, True, False],
    [True, False, True, False, True, True, True, True],
    [True, False, False, True, False, False, False, True],
]

# Vertical cage walls: border_y[row][col] = wall between cols col and col+1
# in row row.  Shape (8, 9).
_BORDER_Y: list[list[bool]] = [
    [True, True, False, True, True, True, True, False, False],
    [False, True, True, True, False, False, False, True, True],
    [True, False, False, False, True, True, False, False, False],
    [False, True, True, True, False, False, True, True, True],
    [False, False, True, False, True, True, True, True, False],
    [False, False, False, True, True, True, False, True, True],
    [True, True, False, False, False, False, False, True, False],
    [False, True, True, True, True, True, True, False, False],
]


def make_guardian10_spec() -> PuzzleSpec:
    """Return a validated PuzzleSpec for Guardian puzzle 10."""
    return validate_cage_layout(
        np.array(_CAGE_TOTALS, dtype=np.intp),
        np.array(_BORDER_X, dtype=bool),
        np.array(_BORDER_Y, dtype=bool),
    )
