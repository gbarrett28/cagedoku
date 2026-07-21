"""Shared type aliases and protocols for the killer_sudoku solver package."""

from typing import Protocol

import numpy as np
import numpy.typing as npt

# A set of (row, col) coordinates identifying a group of cells
CellSet = frozenset[tuple[int, int]]


class GridLike(Protocol):
    """Minimal interface that Equation needs from Grid.

    Using a Protocol instead of a concrete Grid reference avoids the
    circular import that would otherwise form (equation -> grid -> equation).
    The Protocol is structurally typed, so Grid satisfies it without
    explicitly inheriting from it.
    """

    region: npt.NDArray[np.intp]
