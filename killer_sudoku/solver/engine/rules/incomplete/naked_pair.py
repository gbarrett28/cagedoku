"""R7 NakedPair â two cells in a unit share exactly the same two candidates.

Fires on COUNT_HIT_TWO. hint_digit identifies one of the pair digits.
If two cells both have exactly {d1, d2} as candidates, eliminate d1 and d2
from all other cells in the unit.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import (
    Elimination,
    RuleResult,
    Trigger,
    Unit,
    UnitKind,
)


def _unit_label(unit: Unit) -> str:
    """Return a human-readable label for a unit, e.g. 'row 1', 'box 3'."""
    if unit.kind == UnitKind.ROW:
        return f"row {unit.unit_id + 1}"
    if unit.kind == UnitKind.COL:
        return f"column {unit.unit_id - 9 + 1}"
    box = unit.unit_id - 18
    return f"box {box + 1}"


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
        """Return a hint identifying the pair cells and the eliminations they allow.

        Reconstructs the pair from the board (same logic as apply()) so the hint
        can name the two cells and the shared digit set in the explanation.
        """
        if not eliminations:
            return []
        assert ctx.unit is not None
        assert ctx.hint_digit is not None
        board = ctx.board
        cells = list(ctx.unit.cells)
        d1 = ctx.hint_digit

        d1_cells = [cell for cell in cells if d1 in board.candidates[cell[0]][cell[1]]]
        if len(d1_cells) != 2:
            return []
        c1, c2 = d1_cells
        cands1 = board.candidates[c1[0]][c1[1]]
        cands2 = board.candidates[c2[0]][c2[1]]
        if len(cands1) != 2 or cands1 != cands2:
            return []
        d2 = (cands1 - {d1}).pop()
        d_lo, d_hi = min(d1, d2), max(d1, d2)

        highlight = frozenset({c1, c2} | {e.cell for e in eliminations})
        return [
            HintResult(
                rule_name=self.name,
                display_name="Naked Pair",
                explanation=(
                    f"r{c1[0] + 1}c{c1[1] + 1} and r{c2[0] + 1}c{c2[1] + 1} both have"
                    f" only {{{d_lo},{d_hi}}} as candidates in"
                    f" {_unit_label(ctx.unit)}. These digits can be eliminated"
                    f" from all other cells in that unit."
                ),
                highlight_cells=highlight,
                eliminations=eliminations,
                placement=None,
            )
        ]
