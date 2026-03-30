"""R6 DeltaConstraint â apply difference pairs from LinearSystem.

For each active pair (p, q, delta) where value[p] - value[q] = delta:
  candidates[p] is narrowed to {m + delta | m in candidates[q], 1 <= m+delta <= 9}
  candidates[q] is narrowed to {m - delta | m in candidates[p], 1 <= m-delta <= 9}

Fires on COUNT_DECREASED for any unit containing either cell of an active pair.
CELL_DETERMINED is NOT in triggers â LinearSystem.substitute_cell (called in
apply_eliminations) already handles cell determinations, so registering for
CELL_DETERMINED would only queue wasted work items that return [].
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class DeltaConstraint:
    """R6: narrow candidates using linear difference constraints."""

    name = "DeltaConstraint"
    priority = 5
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Narrow candidate sets using active delta pairs touching this unit."""

        assert ctx.unit is not None
        board = ctx.board
        elims: list[Elimination] = []
        seen: set[tuple[tuple[int, int], tuple[int, int], int]] = set()

        for r, c in ctx.unit.cells:
            for pair in board.linear_system.pairs_for_cell((r, c)):
                if pair in seen:
                    continue
                seen.add(pair)
                p, q, delta = pair
                pr, pc = p
                qr, qc = q
                # p candidates must be in {m + delta | m in cands[q]}
                valid_p = {
                    m + delta for m in board.candidates[qr][qc] if 1 <= m + delta <= 9
                }
                for d in list(board.candidates[pr][pc]):
                    if d not in valid_p:
                        elims.append(Elimination(cell=p, digit=d))
                # q candidates must be in {m - delta | m in cands[p]}
                valid_q = {
                    m - delta for m in board.candidates[pr][pc] if 1 <= m - delta <= 9
                }
                for d in list(board.candidates[qr][qc]):
                    if d not in valid_q:
                        elims.append(Elimination(cell=q, digit=d))
        return elims

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
