"""R9 Naked/Hidden Triple â three cells form a closed triple in a unit.

Naked triple: three cells contain candidates only from a set of three digits.
  Eliminate those three digits from all other cells in the unit.

Hidden triple: three digits each appear in the same set of (at most) three cells.
  Restrict those cells to only the three digits.

Fires on COUNT_DECREASED. Scans all C(9,3)=84 cell combinations.
"""

from __future__ import annotations

import itertools

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind


class NakedHiddenTriple:
    """R9: naked or hidden triple elimination."""

    name = "NakedHiddenTriple"
    priority = 8
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX}
    )

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Scan for naked or hidden triples; return eliminations."""
        assert ctx.unit is not None
        board = ctx.board
        cells = list(ctx.unit.cells)
        elims: list[Elimination] = []

        # --- Naked triple ---
        for triple in itertools.combinations(cells, 3):
            union: set[int] = set()
            for r, c in triple:
                union |= board.candidates[r][c]
            if len(union) != 3:
                continue
            for r, c in cells:
                if (r, c) in triple:
                    continue
                for d in union:
                    if d in board.candidates[r][c]:
                        elims.append(Elimination(cell=(r, c), digit=d))

        if elims:
            # naked triple found; skip hidden check to avoid overlap
            return RuleResult(eliminations=elims)

        # --- Hidden triple ---
        uid = ctx.unit.unit_id
        # Digits that appear in 2 or 3 cells (count=1 already handled by HiddenSingle)
        candidate_digits = [d for d in range(1, 10) if 1 < board.counts[uid][d] <= 3]
        for d_triple in itertools.combinations(candidate_digits, 3):
            cells_with: set[tuple[int, int]] = set()
            for d in d_triple:
                for r, c in cells:
                    if d in board.candidates[r][c]:
                        cells_with.add((r, c))
            if len(cells_with) != 3:
                continue
            # Restrict the three cells to only {d1, d2, d3}
            triple_set = set(d_triple)
            for r, c in cells_with:
                for d in list(board.candidates[r][c]):
                    if d not in triple_set:
                        elims.append(Elimination(cell=(r, c), digit=d))

        return RuleResult(eliminations=elims)

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
