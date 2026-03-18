"""R1 NakedSingle — when a cell has one candidate, eliminate it from peers.

Fires on CELL_DETERMINED. Receives cell=(r,c) and hint_digit=d.
Returns Eliminations removing d from all cells sharing a row, col, or box
(cage peers are handled by R3/R4 cage rules, not here).
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class NakedSingle:
    """R1: eliminate a determined digit from all row/col/box peers."""

    name = "NakedSingle"
    priority = 0
    triggers: frozenset[Trigger] = frozenset({Trigger.CELL_DETERMINED})
    unit_kinds: frozenset[UnitKind] = frozenset()  # cell-scoped

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Eliminate hint_digit from all row/col/box peers of ctx.cell."""
        assert ctx.cell is not None
        assert ctx.hint_digit is not None
        r, c = ctx.cell
        d = ctx.hint_digit
        elims: list[Elimination] = []
        for uid in ctx.board.cell_unit_ids(r, c):
            unit = ctx.board.units[uid]
            if unit.kind == UnitKind.CAGE:
                continue  # cage peers handled by R3/R4
            for pr, pc in unit.cells:
                if (pr, pc) != (r, c) and d in ctx.board.candidates[pr][pc]:
                    elims.append(Elimination(cell=(pr, pc), digit=d))
        return elims
