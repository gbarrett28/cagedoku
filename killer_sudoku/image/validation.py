"""Stage 2 validation: union-find cage regions and produce a validated PuzzleSpec.

This module is the boundary between image-specific extraction (Stage 1) and the
newspaper-agnostic solver (Stage 3). All cage-layout consistency checks live
here so neither InpImage nor Grid needs to duplicate them.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from killer_sudoku.solver.grid import ProcessingError
from killer_sudoku.solver.puzzle_spec import PuzzleSpec, build_brdrs


def validate_cage_layout(
    cage_totals: npt.NDArray[np.intp],
    border_x: npt.NDArray[np.bool_],
    border_y: npt.NDArray[np.bool_],
) -> PuzzleSpec:
    """Union-find cage regions, validate each cage, and return a PuzzleSpec.

    Stage 2 of the pipeline: takes raw image-extraction output and produces the
    validated PuzzleSpec contract that the solver accepts.

    Connected components are found by union-find directly on border_x/border_y,
    avoiding the coordinate-convention pitfalls of the brdrs (9,9,4) expansion.

    Three consistency checks are applied:
    - region_reassigned: two cage heads map to the same connected component.
    - invalid_cage: the declared cage total is outside the achievable range for
      the connected-component size (too small or too large).
    - unassigned_region: at least one cell belongs to a component with no cage
      head, meaning the cage-total array is incomplete.

    Args:
        cage_totals: (9,9) array; non-zero at the top-left cell of each cage.
        border_x: (9,8) horizontal cage-wall flags from border detection.
            border_x[col, row] = True means a wall between rows row and row+1.
        border_y: (8,9) vertical cage-wall flags from border detection.
            border_y[row, col] = True means a wall between cols col and col+1.

    Returns:
        A fully-validated PuzzleSpec ready for Grid.set_up.

    Raises:
        ProcessingError: if cage heads clash or a cell is left unassigned.
        ValueError: if a cage total is outside the achievable range for its size.
    """
    # Union-find: rmap[(col, row)] → representative cell for the component.
    # members[rep] → set of all cells in that component.
    rmap: dict[tuple[int, int], tuple[int, int]] = {
        (c, r): (c, r) for c in range(9) for r in range(9)
    }
    members: dict[tuple[int, int], set[tuple[int, int]]] = {
        (c, r): {(c, r)} for c in range(9) for r in range(9)
    }

    def union(a: tuple[int, int], b: tuple[int, int]) -> None:
        # Always keep the lexicographically smaller cell as the representative.
        ra, rb = sorted((rmap[a], rmap[b]))
        if ra == rb:
            return
        for p in members[rb]:
            rmap[p] = ra
        members[ra] |= members[rb]
        del members[rb]

    # Merge cells across open horizontal borders (walls between rows).
    # border_x[col, row] = True means a wall between rows row and row+1 in col.
    for col in range(9):
        for row in range(8):
            if not border_x[col, row]:
                union((col, row), (col, row + 1))

    # Merge cells across open vertical borders (walls between columns).
    # border_y is indexed [col, row] here: border_y[col, row] = True means a
    # wall between (col, row) and (col+1, row).  The first dimension (size 8)
    # covers col boundaries 0–7; the second dimension (size 9) covers all rows.
    for col in range(8):
        for row in range(9):
            if not border_y[col, row]:
                union((col, row), (col + 1, row))

    brdrs = build_brdrs(border_x, border_y)
    regions: npt.NDArray[np.intp] = np.zeros((9, 9), dtype=np.intp)
    reg = 0
    for col in range(9):
        for row in range(9):
            if cage_totals[col, row] != 0:
                component = members[rmap[(col, row)]]
                if any(regions[c, r] != 0 for c, r in component):
                    raise ProcessingError("region reassigned", regions, brdrs)
                reg += 1
                n = len(component)
                lo = (n * (n + 1)) // 2
                hi = (n * (19 - n)) // 2
                if not (lo <= cage_totals[col, row] <= hi):
                    raise ValueError(
                        f"cagesize={n}, total={cage_totals[col, row]}: "
                        f"total must be in [{lo}, {hi}]"
                    )
                for c, r in component:
                    regions[c, r] = reg

    if (regions == 0).any():
        raise ProcessingError("unassigned region", regions, brdrs)

    return PuzzleSpec(
        regions=regions,
        cage_totals=cage_totals,
        border_x=border_x,
        border_y=border_y,
    )
