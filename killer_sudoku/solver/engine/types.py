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
class Placement:
    """A digit placement in a cell, returned by apply() for placement rules.

    Signals that the rule has determined the unique digit for a cell (e.g.
    NakedSingle).  The engine records the placement in applied_placements;
    the API layer promotes it to user_grid.
    """

    cell: Cell
    digit: int


@dataclasses.dataclass(frozen=True)
class SolutionElimination:
    """Direct removal of a cage solution, returned by apply().

    Used by rules that can prove a specific cage combination is impossible
    without going through individual candidate removals.  The engine removes
    the solution from board.cage_solns and re-fires SOLUTION_PRUNED for the
    affected cage unit.
    """

    cage_idx: int
    solution: frozenset[int]


@dataclasses.dataclass(frozen=True)
class VirtualCageAddition:
    """A derived sum constraint to register as a virtual cage.

    Returned by rules that derive new cell-group sum equations (e.g. from
    the linear system).  The engine collects these in applied_virtual_cages;
    the API layer adds them to PuzzleState.virtual_cages.
    """

    cells: frozenset[Cell]
    total: int


@dataclasses.dataclass
class RuleResult:
    """Full return type for SolverRule.apply(), replacing list[Elimination].

    Aggregates all four kinds of change a rule can produce:
      eliminations        — remove digits from cell candidate sets
      placements          — confirm a cell's digit (e.g. NakedSingle)
      solution_eliminations — remove cage solutions directly
      virtual_cage_additions — add derived sum constraints

    All fields default to empty so rules that only produce one kind of result
    can construct RuleResult with a single keyword argument.
    """

    eliminations: list[Elimination] = dataclasses.field(default_factory=list)
    placements: list[Placement] = dataclasses.field(default_factory=list)
    solution_eliminations: list[SolutionElimination] = dataclasses.field(
        default_factory=list
    )
    virtual_cage_additions: list[VirtualCageAddition] = dataclasses.field(
        default_factory=list
    )

    @property
    def has_progress(self) -> bool:
        """True if any result was produced (used by RuleStats)."""
        return bool(
            self.eliminations
            or self.placements
            or self.solution_eliminations
            or self.virtual_cage_additions
        )


@dataclasses.dataclass(frozen=True)
class BoardEvent:
    """Typed event returned by BoardState mutation methods.

    payload is Cell (r, c) for CELL_DETERMINED; unit_id (int) for all other
    triggers. hint_digit is None for SOLUTION_PRUNED and GLOBAL.
    """

    trigger: Trigger
    payload: Cell | int
    hint_digit: int | None
