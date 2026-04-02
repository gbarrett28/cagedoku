"""R7 NakedPair â two cells in a unit share exactly the same two candidates.

Fires on COUNT_HIT_TWO. hint_digit identifies one of the pair digits.
If two cells both have exactly {d1, d2} as candidates, eliminate d1 and d2
from all other cells in the unit.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind


class NakedPair:
    """R7: two cells locked to the same two candidates â eliminate from peers."""

    name = "NakedPair"
    priority = 6
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_HIT_TWO})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX}
    )

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Find naked pair using hint_digit; eliminate both digits from unit peers."""
        assert ctx.unit is not None
        assert ctx.hint_digit is not None
        board = ctx.board
        cells = list(ctx.unit.cells)
        d1 = ctx.hint_digit

        # Locate the two cells that carry d1 with count=2
        d1_cells = [cell for cell in cells if d1 in board.candidates[cell[0]][cell[1]]]
        if len(d1_cells) != 2:
            return RuleResult()
        c1, c2 = d1_cells

        # Naked pair requires both cells to have exactly {d1, d2}
        cands1 = board.candidates[c1[0]][c1[1]]
        cands2 = board.candidates[c2[0]][c2[1]]
        if len(cands1) != 2 or cands1 != cands2:
            return RuleResult()

        d2 = (cands1 - {d1}).pop()
        elims: list[Elimination] = []
        for r, c in cells:
            if (r, c) in (c1, c2):
                continue
            for d in (d1, d2):
                if d in board.candidates[r][c]:
                    elims.append(Elimination(cell=(r, c), digit=d))
        return RuleResult(eliminations=elims)

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
