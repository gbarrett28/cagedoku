"""R2 HiddenSingle — a digit with count=1 in a unit must go in that one cell.

Fires on COUNT_HIT_ONE. hint_digit narrows search to the triggered digit.
Returns Eliminations removing all other candidates from the sole remaining cell.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class HiddenSingle:
    """R2: when exactly one cell in a unit can hold a digit, place it there."""

    name = "HiddenSingle"
    priority = 1
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_HIT_ONE})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Find the sole cell that can hold hint_digit; eliminate all others from it."""
        assert ctx.unit is not None
        assert ctx.hint_digit is not None
        d = ctx.hint_digit
        sole = next(
            ((r, c) for r, c in ctx.unit.cells if d in ctx.board.candidates[r][c]),
            None,
        )
        if sole is None:
            return []
        r, c = sole
        return [
            Elimination(cell=(r, c), digit=other)
            for other in ctx.board.candidates[r][c]
            if other != d
        ]
