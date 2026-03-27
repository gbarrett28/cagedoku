"""R3 CageIntersection — must-contain intersection with row/col/box.

When all remaining cage solutions require certain digits, and all cells that
could carry those digits within the cage share a row, col, or box with cells
outside the cage, eliminate those digits from the external cells.

This mirrors Grid.elim_must intersection propagation.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class CageIntersection:
    """R3: cage must-contain digits confined to a row/col/box eliminate from outside."""

    name = "CageIntersection"
    priority = 2
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.CAGE})

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """For each must-contain digit, if all carrier cells share a non-cage unit,
        eliminate that digit from the rest of that unit.

        Non-burb virtual cages (distinct_digits=False) are skipped: their
        must-sets come from sol_sums which assumes distinct digits — not
        guaranteed for cells spanning multiple units.  An overestimated must
        set would eliminate valid candidates from real rows/cols/boxes.
        """
        assert ctx.unit is not None
        if not ctx.unit.distinct_digits:
            return []
        cage_cells = ctx.unit.cells
        board = ctx.board
        cage_idx = ctx.unit.unit_id - 27
        solns = board.cage_solns[cage_idx]
        if not solns:
            return []

        # must: digits that appear in every remaining cage solution
        must = set(solns[0])
        for s in solns[1:]:
            must &= s

        elims: list[Elimination] = []
        for d in must:
            cells_with_d = [
                (r, c) for r, c in cage_cells if d in board.candidates[r][c]
            ]
            if not cells_with_d:
                continue
            # Find units shared by all cells carrying d (excluding cage units)
            shared_units: set[int] | None = None
            for r, c in cells_with_d:
                non_cage = {
                    uid
                    for uid in board.cell_unit_ids(r, c)
                    if board.units[uid].kind != UnitKind.CAGE
                }
                if shared_units is None:
                    shared_units = non_cage
                else:
                    shared_units &= non_cage
            if not shared_units:
                continue
            for uid in shared_units:
                for r, c in board.units[uid].cells:
                    if (r, c) not in cage_cells and d in board.candidates[r][c]:
                        elims.append(Elimination(cell=(r, c), digit=d))
        return elims
