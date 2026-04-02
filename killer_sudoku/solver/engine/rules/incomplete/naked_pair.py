"""R7 NakedPair â two cells in a unit share exactly the same two candidates.

Fires on COUNT_HIT_TWO. hint_digit identifies one of the pair digits.
If two cells both have exactly {d1, d2} as candidates, eliminate d1 and d2
from all other cells in the unit.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules._labels import cell_label, unit_label
from killer_sudoku.solver.engine.rules._registry import hintable_rule
from killer_sudoku.solver.engine.types import (
    Cell,
    Elimination,
    RuleResult,
    Trigger,
    UnitKind,
)


@hintable_rule
class NakedPair:
    """R7: two cells locked to the same two candidates â eliminate from peers."""

    name = "NakedPair"
    priority = 6
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_HIT_TWO})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX}
    )

    # ── internal helper ─────────────────────────────────────────────────────

    @staticmethod
    def _find_pair(
        ctx: RuleContext,
    ) -> tuple[Cell, Cell, int, int] | None:
        """Return (c1, c2, d_lo, d_hi) if a naked pair exists in the trigger unit.

        Shared by apply() and as_hints() so the pair-finding logic is computed
        once and not duplicated across both methods.
        Returns None if the triggered digit does not form a valid naked pair.
        """
        assert ctx.unit is not None
        assert ctx.hint_digit is not None
        board = ctx.board
        cells = list(ctx.unit.cells)
        d1 = ctx.hint_digit

        d1_cells = [cell for cell in cells if d1 in board.candidates[cell[0]][cell[1]]]
        if len(d1_cells) != 2:
            return None
        c1, c2 = d1_cells
        cands1 = board.candidates[c1[0]][c1[1]]
        cands2 = board.candidates[c2[0]][c2[1]]
        if len(cands1) != 2 or cands1 != cands2:
            return None
        d2 = (cands1 - {d1}).pop()
        return c1, c2, min(d1, d2), max(d1, d2)

    # ── SolverRule protocol ─────────────────────────────────────────────────

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Find naked pair using hint_digit; eliminate both digits from unit peers."""
        assert ctx.unit is not None
        pair = self._find_pair(ctx)
        if pair is None:
            return RuleResult()
        c1, c2, d_lo, d_hi = pair
        cells = list(ctx.unit.cells)
        elims: list[Elimination] = [
            Elimination(cell=(r, c), digit=d)
            for r, c in cells
            if (r, c) not in (c1, c2)
            for d in (d_lo, d_hi)
            if d in ctx.board.candidates[r][c]
        ]
        return RuleResult(eliminations=elims)

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return a hint identifying the pair cells and the eliminations they allow."""
        if not eliminations:
            return []
        pair = self._find_pair(ctx)
        if pair is None:
            return []
        assert ctx.unit is not None
        c1, c2, d_lo, d_hi = pair
        highlight = frozenset({c1, c2} | {e.cell for e in eliminations})
        return [
            HintResult(
                rule_name=self.name,
                display_name="Naked Pair",
                explanation=(
                    f"{cell_label(c1)} and {cell_label(c2)} both have only"
                    f" {{{d_lo},{d_hi}}} as candidates in {unit_label(ctx.unit)}."
                    f" These digits can be eliminated from all other cells in"
                    f" that unit."
                ),
                highlight_cells=highlight,
                eliminations=eliminations,
                placement=None,
            )
        ]
