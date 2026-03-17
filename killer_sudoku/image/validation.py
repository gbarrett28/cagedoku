"""Stage 2 validation: flood-fill cages and produce a validated PuzzleSpec.

This module is the boundary between image-specific extraction (Stage 1) and the
newspaper-agnostic solver (Stage 3). All cage-layout consistency checks live
here so neither InpImage nor Grid needs to duplicate them.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from killer_sudoku.solver.grid import BRDR_MV, ProcessingError
from killer_sudoku.solver.puzzle_spec import PuzzleSpec, build_brdrs


def validate_cage_layout(
    cage_totals: npt.NDArray[np.intp],
    border_x: npt.NDArray[np.bool_],
    border_y: npt.NDArray[np.bool_],
) -> PuzzleSpec:
    """Flood-fill cage regions, validate each cage, and return a PuzzleSpec.

    Stage 2 of the pipeline: takes raw image-extraction output and produces the
    validated PuzzleSpec contract that the solver accepts.

    Three consistency checks are applied:
    - region_reassigned: a cell is reachable from two different cage heads,
      indicating an inconsistent border map.
    - invalid_cage: the declared cage total is outside the achievable range for
      the flood-filled cage size (too small or too large).
    - unassigned_region: at least one cell was not reached by any cage head,
      meaning the cage-total array is incomplete.

    Args:
        cage_totals: (9,9) array; non-zero at the top-left cell of each cage.
        border_x: (9,8) horizontal cage-wall flags from border detection.
        border_y: (8,9) vertical cage-wall flags from border detection.

    Returns:
        A fully-validated PuzzleSpec ready for Grid.set_up.

    Raises:
        ProcessingError: if regions overlap or a cell is left unassigned.
        ValueError: if a cage total is outside the achievable range for its size.
    """
    brdrs = build_brdrs(border_x, border_y)
    regions: npt.NDArray[np.intp] = np.zeros((9, 9), dtype=np.intp)

    def _flood(i: int, j: int, reg: int) -> int:
        """Recursively mark cell (i, j) as belonging to cage reg.

        Returns the count of cells newly marked in this call tree.
        Raises ProcessingError if a cell already assigned to a different cage
        is reached, indicating an inconsistent border map.
        """
        if regions[i][j] == 0:
            regions[i][j] = reg
            count = 1
            for b, mv in zip(brdrs[j][i], BRDR_MV, strict=False):
                if not b:
                    count += _flood(i + mv[1], j + mv[0], reg)
            return count
        if regions[i][j] != reg:
            raise ProcessingError("region reassigned", regions, brdrs)
        return 0

    reg = 0
    for i in range(9):
        for j in range(9):
            if cage_totals[i][j] != 0:
                reg += 1
                n = _flood(i, j, reg)
                lo = (n * (n + 1)) // 2
                hi = (n * (19 - n)) // 2
                if not (lo <= cage_totals[i][j] <= hi):
                    raise ValueError(
                        f"cagesize={n}, total={cage_totals[i][j]}: "
                        f"total must be in [{lo}, {hi}]"
                    )

    if (regions == 0).any():
        raise ProcessingError("unassigned region", regions, brdrs)

    return PuzzleSpec(
        regions=regions,
        cage_totals=cage_totals,
        border_x=border_x,
        border_y=border_y,
    )
