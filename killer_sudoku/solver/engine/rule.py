"""SolverRule protocol, RuleContext, and RuleStats.

SolverRule is a structural protocol — any object with the required
attributes and an apply() method qualifies. Rules are stateless;
all mutable state lives in BoardState. Rules must not call BoardState
mutators directly; they return RuleResult.
"""

from __future__ import annotations

import dataclasses
from typing import Protocol

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.types import (
    Cell,
    Elimination,
    RuleResult,
    Trigger,
    Unit,
    UnitKind,
)


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
    progress: int = 0  # times apply() produced any result
    eliminations: int = 0  # total candidate Eliminations returned
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

    def record(self, result: RuleResult, elapsed_ns: int) -> None:
        """Record one apply() call's results."""
        self.calls += 1
        if result.has_progress:
            self.progress += 1
        self.eliminations += len(result.eliminations)
        self.elapsed_ns += elapsed_ns


class SolverRule(Protocol):
    """Structural protocol for solver rules.

    Rules are stateless — apply() reads from ctx.board and returns a
    RuleResult.  It must not call any BoardState mutator directly.
    unit_kinds: empty frozenset means GLOBAL/cell-scoped (unit=None in ctx).
    """

    name: str
    description: str
    priority: int
    triggers: frozenset[Trigger]
    unit_kinds: frozenset[UnitKind]

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Apply the rule; return eliminations, placements, solution prunings, or
        virtual cage additions.  Rules that only produce candidate eliminations
        construct RuleResult(eliminations=[...]).
        """
        ...

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Convert a rule firing to coaching hints (called when rule is hint-only).

        ctx provides the triggering context (unit, cell, board, trigger, hint_digit).
        eliminations is result.eliminations from apply() for the same ctx.
        Rules that produce placement hints (e.g. NakedSingle) may ignore eliminations.
        Rules that produce multiple independent hints (e.g. CageConfinement) return
        one HintResult per finding.
        """
        ...
