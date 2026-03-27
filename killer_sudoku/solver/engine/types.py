"""Core value types for the solver engine.

All types here are pure data — no logic, no imports from the rest of the
engine. This module is the dependency-free foundation imported by every
other engine module.
"""

from __future__ import annotations

import dataclasses
from enum import Enum

# (row, col), both 0-based
Cell = tuple[int, int]


class UnitKind(Enum):
    """The four kinds of units in a killer sudoku grid."""

    ROW = "row"
    COL = "col"
    BOX = "box"
    CAGE = "cage"


@dataclasses.dataclass(frozen=True)
class Unit:
    """A typed, indexed group of cells (row, col, box, or cage).

    distinct_digits controls whether the cells are guaranteed to hold distinct
    digits (True for rows, cols, boxes, and burb virtual cages; False for
    non-burb derived sum constraints).  When False, SolutionMapFilter skips
    this cage — per-cell backtracking assumes distinctness and would produce
    wrong eliminations for cells that can legally share a digit.  MustContain
    still applies because its must-intersection + elsewhere-candidates check
    is safe even with an overestimated must set.
    """

    unit_id: int
    kind: UnitKind
    cells: frozenset[Cell]
    distinct_digits: bool = True


class Trigger(Enum):
    """Events that fire when board state changes.

    Used to route work items to rules that care about a specific kind of change.
    """

    CELL_DETERMINED = 0  # candidates[r][c] became a singleton
    COUNT_HIT_ONE = 1  # counts[unit][digit] just reached 1 (hidden single)
    COUNT_HIT_TWO = 2  # counts[unit][digit] just reached 2 (pair candidate)
    COUNT_DECREASED = 3  # counts[unit][digit] decreased (any amount)
    SOLUTION_PRUNED = 4  # a cage solution was eliminated
    GLOBAL = 5  # fires when unit queue is otherwise empty
    CELL_SOLVED = 6  # cell solution officially committed (fires after CELL_DETERMINED)


@dataclasses.dataclass(frozen=True)
class Elimination:
    """A single inference: remove digit from a cell's candidate set."""

    cell: Cell
    digit: int


@dataclasses.dataclass(frozen=True)
class BoardEvent:
    """Typed event returned by BoardState mutation methods.

    payload is Cell (r, c) for CELL_DETERMINED; unit_id (int) for all other
    triggers. hint_digit is None for SOLUTION_PRUNED and GLOBAL.
    """

    trigger: Trigger
    payload: Cell | int
    hint_digit: int | None
