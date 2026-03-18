"""SolverRule protocol, RuleContext, and RuleStats.

SolverRule is a structural protocol — any object with the required
attributes and an apply() method qualifies. Rules are stateless;
all mutable state lives in BoardState. Rules must not call BoardState
mutators directly; they return list[Elimination] only.
"""

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING, Protocol

from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, Unit, UnitKind

if TYPE_CHECKING:
    from killer_sudoku.solver.engine.board_state import BoardState


@dataclasses.dataclass
class RuleContext:
    """Input to a rule's apply() method."""

    unit: Unit | None  # None for CELL_DETERMINED and GLOBAL rules
    cell: Cell | None  # Set for CELL_DETERMINED; None otherwise
    board: BoardState
    hint: Trigger
    hint_digit: int | None  # Digit that triggered, if known


@dataclasses.dataclass
class RuleStats:
    """Accumulated statistics for a single rule across all solves."""

    calls: int = 0
    progress: int = 0  # times apply() returned at least one Elimination
    eliminations: int = 0  # total Eliminations returned
    elapsed_ns: int = 0

    @property
    def hit_rate(self) -> float:
        """Fraction of apply() calls that made progress."""
        return self.progress / self.calls if self.calls else 0.0

    @property
    def utility(self) -> float:
        """Eliminations per nanosecond; used for offline priority calibration."""
        cost = self.elapsed_ns / self.calls if self.calls else 1.0
        return (self.eliminations / self.calls if self.calls else 0.0) / cost

    def record(self, eliminations: list[Elimination], elapsed_ns: int) -> None:
        """Record one apply() call's results."""
        self.calls += 1
        if eliminations:
            self.progress += 1
        self.eliminations += len(eliminations)
        self.elapsed_ns += elapsed_ns


class SolverRule(Protocol):
    """Structural protocol for solver rules.

    Rules are stateless — apply() reads from ctx.board and returns
    a list of Eliminations. It must not call any BoardState mutator.
    unit_kinds: empty frozenset means GLOBAL/cell-scoped (unit=None in ctx).
    """

    name: str
    priority: int
    triggers: frozenset[Trigger]
    unit_kinds: frozenset[UnitKind]

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Apply the rule and return candidate eliminations."""
        ...
