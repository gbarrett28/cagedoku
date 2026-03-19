"""R9b Naked/Hidden Quad — four cells form a closed quad in a unit.

Naked quad: four cells contain candidates only from a set of four digits.
  Eliminate those four digits from all other cells in the unit.

Hidden quad: four digits each appear in the same set of (at most) four cells.
  Restrict those cells to only the four digits.

Fires on COUNT_DECREASED. Scans all C(9,4)=126 cell combinations.
"""

from __future__ import annotations

import itertools

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class NakedHiddenQuad:
    """R9b: naked or hidden quad elimination."""

    name = "NakedHiddenQuad"
    priority = 9
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX}
    )

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Scan for naked or hidden quads; return eliminations."""
        assert ctx.unit is not None
        board = ctx.board
        cells = list(ctx.unit.cells)
        elims: list[Elimination] = []

        # --- Naked quad ---
        for quad in itertools.combinations(cells, 4):
            union: set[int] = set()
            for r, c in quad:
                union |= board.candidates[r][c]
            if len(union) != 4:
                continue
            for r, c in cells:
                if (r, c) in quad:
                    continue
                for d in union:
                    if d in board.candidates[r][c]:
                        elims.append(Elimination(cell=(r, c), digit=d))

        if elims:
            return elims  # naked quad found; skip hidden check to avoid overlap

        # --- Hidden quad ---
        uid = ctx.unit.unit_id
        # Digits that appear in 2..4 cells (count=1 already handled by HiddenSingle)
        candidate_digits = [d for d in range(1, 10) if 1 < board.counts[uid][d] <= 4]
        for d_quad in itertools.combinations(candidate_digits, 4):
            cells_with: set[tuple[int, int]] = set()
            for d in d_quad:
                for r, c in cells:
                    if d in board.candidates[r][c]:
                        cells_with.add((r, c))
            if len(cells_with) != 4:
                continue
            quad_set = set(d_quad)
            for r, c in cells_with:
                for d in list(board.candidates[r][c]):
                    if d not in quad_set:
                        elims.append(Elimination(cell=(r, c), digit=d))

        return elims
