"""LinearElimination â apply cells determined algebraically by the linear system.

The LinearSystem solves the cage-sum equations by Gaussian elimination.
Where the system uniquely determines a cell's value (a single-variable row),
those cells are recorded as initial_eliminations.

This rule surfaces those determinations as a proper, toggleable rule so
the coaching layer can present them as hints and they are not silently
pre-applied in playing mode.

Fires as GLOBAL: runs whenever the engine's event queue is exhausted.
After the first pass the eliminations have been applied, so subsequent
firings return nothing.
"""

from __future__ import annotations

from typing import ClassVar

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class LinearElimination:
    """Apply cells determined by the cage-sum linear system."""

    name = "LinearElimination"
    priority = 1
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()
    # BoardState must be constructed with include_virtual_cages=True for the
    # linear system to function.  _make_board_and_engine() reads this flag so
    # the rule name never needs to be hardcoded outside DEFAULT_ALWAYS_APPLY_RULES.
    requires_virtual_cages: ClassVar[bool] = True

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Return initial_eliminations still present in the candidate sets."""
        return [
            e
            for e in ctx.board.linear_system.initial_eliminations
            if e.digit in ctx.board.candidates[e.cell[0]][e.cell[1]]
        ]

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
