"""R6 DeltaConstraint â apply difference pairs from LinearSystem.

For each active pair (p, q, delta) where value[p] - value[q] = delta:
  candidates[p] is narrowed to {m + delta | m in candidates[q], 1 <= m+delta <= 9}
  candidates[q] is narrowed to {m - delta | m in candidates[p], 1 <= m-delta <= 9}

Fires on COUNT_DECREASED for any unit containing either cell of an active pair.
CELL_DETERMINED is NOT in triggers â LinearSystem.substitute_cell (called in
apply_eliminations) already handles cell determinations, so registering for
CELL_DETERMINED would only queue wasted work items that return RuleResult().
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules._registry import hintable_rule
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind


@hintable_rule
class DeltaConstraint:
    """R6: narrow candidates using linear difference constraints."""

    name = "DeltaConstraint"
    priority = 5
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    def apply(self, ctx: RuleContext) -> RuleResult:
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
        return RuleResult(eliminations=elims)

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return one hint per delta pair that would eliminate candidates.

        Each hint explains the algebraic difference constraint and shows the
        resulting candidate eliminations for the pair.
        """
        if not eliminations:
            return []
        assert ctx.unit is not None
        board = ctx.board
        hints: list[HintResult] = []
        seen: set[tuple[tuple[int, int], tuple[int, int], int]] = set()

        for r, c in ctx.unit.cells:
            for pair in board.linear_system.pairs_for_cell((r, c)):
                if pair in seen:
                    continue
                seen.add(pair)
                p, q, delta = pair
                pr, pc = p
                qr, qc = q

                pair_elims: list[Elimination] = []
                valid_p = {
                    m + delta for m in board.candidates[qr][qc] if 1 <= m + delta <= 9
                }
                for d in board.candidates[pr][pc]:
                    if d not in valid_p:
                        pair_elims.append(Elimination(cell=p, digit=d))
                valid_q = {
                    m - delta for m in board.candidates[pr][pc] if 1 <= m - delta <= 9
                }
                for d in board.candidates[qr][qc]:
                    if d not in valid_q:
                        pair_elims.append(Elimination(cell=q, digit=d))

                if not pair_elims:
                    continue

                sign = "+" if delta >= 0 else "-"
                abs_delta = abs(delta)
                name_p = f"r{pr + 1}c{pc + 1}"
                name_q = f"r{qr + 1}c{qc + 1}"
                hints.append(
                    HintResult(
                        rule_name=self.name,
                        display_name=f"Delta: {name_p} \u2212 {name_q} = {delta}",
                        explanation=(
                            f"The cage-sum equations show {name_p} \u2212 {name_q}"
                            f" = {delta}. {name_p} must equal {name_q}"
                            f" {sign} {abs_delta}, which rules out some candidates."
                        ),
                        highlight_cells=frozenset({p, q}),
                        eliminations=pair_elims,
                    )
                )
        return hints
