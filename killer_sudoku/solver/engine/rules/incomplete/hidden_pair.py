"""R8 HiddenPair — two digits each confined to the same two cells in a unit.

Fires on COUNT_HIT_TWO. hint_digit identifies one of the pair digits.
If a second digit d2 also appears in exactly the same two cells, restrict
those cells to {d1, d2} by eliminating all other candidates.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class HiddenPair:
    """R8: two digits locked to the same two cells — restrict those cells."""

    name = "HiddenPair"
    priority = 7
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_HIT_TWO})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX}
    )

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Find hidden pair using hint_digit; eliminate non-pair digits."""
        assert ctx.unit is not None
        assert ctx.hint_digit is not None
        board = ctx.board
        uid = ctx.unit.unit_id
        cells = list(ctx.unit.cells)
        d1 = ctx.hint_digit

        # The two cells that carry d1
        pair_cells = [
            cell for cell in cells if d1 in board.candidates[cell[0]][cell[1]]
        ]
        if len(pair_cells) != 2:
            return []

        # Find a second digit also confined to the same two cells
        elims: list[Elimination] = []
        for d2 in range(1, 10):
            if d2 == d1:
                continue
            if board.counts[uid][d2] != 2:
                continue
            d2_cells = [
                cell for cell in cells if d2 in board.candidates[cell[0]][cell[1]]
            ]
            if sorted(d2_cells) != sorted(pair_cells):
                continue
            # Hidden pair {d1, d2} in pair_cells — restrict to only these two digits
            for r, c in pair_cells:
                for d in list(board.candidates[r][c]):
                    if d not in (d1, d2):
                        elims.append(Elimination(cell=(r, c), digit=d))
            break  # one hidden pair per invocation is sufficient
        return elims
