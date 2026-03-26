"""R1a NakedSingle — recognise a cell reduced to a single candidate.

Fires on CELL_DETERMINED.  Returns no eliminations — the engine has
already promoted the sole remaining candidate to the cell's solution.

This rule exists as a named concept so the coaching layer can generate
a hint: "cell (r,c) has only one remaining candidate (d), so it must
hold d."  The actual peer eliminations that follow are handled by
SolvedCellElimination (R1b).
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class NakedSingle:
    """R1a: named recognition of a cell determined by a single candidate."""

    name = "NakedSingle"
    priority = 0
    triggers: frozenset[Trigger] = frozenset({Trigger.CELL_DETERMINED})
    unit_kinds: frozenset[UnitKind] = frozenset()  # cell-scoped

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """No eliminations — promotion is handled unconditionally by the engine."""
        return []
