"""PuzzleSpec: the validated contract between image processing and the solver.

This module defines the boundary between Stage 2 (cage validation) and the
solver. A PuzzleSpec is produced by validate_cage_layout() after all
cage-layout consistency checks have passed.
"""

import dataclasses

import numpy as np
import numpy.typing as npt


def build_brdrs(
    border_x: npt.NDArray[np.bool_],
    border_y: npt.NDArray[np.bool_],
) -> npt.NDArray[np.bool_]:
    """Expand compact border arrays to per-cell (9,9,4) form for rendering.

    border_x[col, row] = True means a cage wall between rows row and row+1 in
    column col (shape 9×8). border_y[row, col] = True means a cage wall between
    columns col and col+1 in row row (shape 8×9). Outer grid edges are always
    True (walled).

    Note: the loop variable named ``col`` plays the role of *row-index* in the
    result array for the isbv lines, and vice-versa.  This is an artefact of the
    loop sharing variables across two different border orientations; see the
    inline comments.

    Args:
        border_x: (9, 8) bool array of horizontal cage-wall flags.
        border_y: (8, 9) bool array of vertical cage-wall flags.

    Returns:
        (9, 9, 4) bool array; True means a wall is present.
    """
    result: npt.NDArray[np.bool_] = np.full((9, 9, 4), True, dtype=bool)
    for col in range(9):
        for row in range(8):
            isbh = bool(border_x[col, row])
            isbv = bool(border_y[row, col])
            # isbh: horizontal wall in column col, between rows row and row+1.
            result[row + 0, col][1] = isbh
            result[row + 1, col][3] = isbh
            # isbv: vertical wall in row row, between cols col and col+1.
            # Here `col` is the first index into result (acting as a row index)
            # and `row` is the second index (acting as a col index).
            result[col, row + 0][2] = isbv
            result[col, row + 1][0] = isbv
    return result


@dataclasses.dataclass
class PuzzleSpec:
    """Validated puzzle contract passed from image processing to the solver.

    Produced by validate_cage_layout() after all cage-layout consistency checks
    have passed. Represents the clean boundary between the image pipeline
    (newspaper-specific) and the solver (newspaper-agnostic).

    Attributes:
        regions: (9,9) 1-based cage index per cell; 0 means unassigned.
        cage_totals: (9,9) declared cage sum at each cage's head cell, 0 elsewhere.
        border_x: (9,8) compact horizontal cage-wall flags — True = wall.
            border_x[col, row] is the wall between rows row and row+1 in col.
        border_y: (8,9) compact vertical cage-wall flags — True = wall.
            border_y[row, col] is the wall between columns col and col+1 in row.
    """

    regions: npt.NDArray[np.intp]
    cage_totals: npt.NDArray[np.intp]
    border_x: npt.NDArray[np.bool_]
    border_y: npt.NDArray[np.bool_]

    @property
    def brdrs(self) -> npt.NDArray[np.bool_]:
        """Expand to (9,9,4) per-cell border flags for rendering and solving.

        Computed on demand from the canonical border_x / border_y arrays.
        The (9,9,4) form is redundant — each of the 144 physical borders appears
        in two adjacent cells — but convenient for the draw_borders call.
        """
        return build_brdrs(self.border_x, self.border_y)
