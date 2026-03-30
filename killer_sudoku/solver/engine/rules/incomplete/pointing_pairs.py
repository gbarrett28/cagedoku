"""R10 PointingPairs â a digit in a box confined to one row or column.

When all cells within a 3Ã3 box that carry digit d lie in the same row
(or same column), eliminate d from the rest of that row (or column)
outside the box.

Fires on COUNT_DECREASED for BOX units.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class PointingPairs:
    """R10: digit confined to one row/col within a box â eliminate from the rest."""

    name = "PointingPairs"
    priority = 9
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.BOX})

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Eliminate pointing-pair digits from the row/col outside the box."""
        assert ctx.unit is not None
        board = ctx.board
        box_cells = ctx.unit.cells
        elims: list[Elimination] = []

        for d in range(1, 10):
            cells_with_d = [(r, c) for r, c in box_cells if d in board.candidates[r][c]]
            if len(cells_with_d) < 2:
                continue
            rows = {r for r, _ in cells_with_d}
            cols = {c for _, c in cells_with_d}
            if len(rows) == 1:
                row = next(iter(rows))
                row_uid = board.row_unit_id(row)
                for r, c in board.units[row_uid].cells:
                    if (r, c) not in box_cells and d in board.candidates[r][c]:
                        elims.append(Elimination(cell=(r, c), digit=d))
            elif len(cols) == 1:
                col = next(iter(cols))
                col_uid = board.col_unit_id(col)
                for r, c in board.units[col_uid].cells:
                    if (r, c) not in box_cells and d in board.candidates[r][c]:
                        elims.append(Elimination(cell=(r, c), digit=d))
        return elims

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
