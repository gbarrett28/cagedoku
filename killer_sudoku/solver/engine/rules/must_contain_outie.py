"""R4b MustContainOutie — outie must mirror the single external cell's candidates.

When a cage C has exactly one cell outside a unit U (the "outie"), and there
is exactly one external cell x in U (not in C) whose candidates are all in
C's must-contain set, then the outie's candidates are restricted to candidates(x).

Intuition: x can only take a digit from C's must-have set.  Whichever digit x
holds, unit-uniqueness blocks it from every inside cell of C (they share U with
x).  The cage still needs that digit somewhere, so it must land on the outie.
This holds for every possible value of x, so the outie's candidates ⊆ cands(x).

Example: cage {r1c6, r1c7, r1c8, r2c8} must contain {6,8,9}.  Cell r1c3 is
external to the cage but in row 1, with candidates {6,8,9}.  Three cage cells
(r1c6, r1c7, r1c8) share row 1 with r1c3; r2c8 is the sole outie.  Whichever
of {6,8,9} r1c3 holds, it is blocked from the three row-1 cage cells, so the
cage must place that digit at r2c8 → cands(r2c8) ⊆ {6,8,9}.

Fires on COUNT_DECREASED (all unit kinds) and SOLUTION_PRUNED (cage only).
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind


class MustContainOutie:
    """R4b: single external cell with candidates ⊆ must-contain restricts the outie."""

    name = "MustContainOutie"
    priority = 4
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Restrict outie candidates when one external cell qualifies.

        When triggered by a cage unit: checks each row/col/box unit the cage
        partially overlaps.  When triggered by a row/col/box: checks each cage
        that partially overlaps that unit.  Non-burb cages are skipped.
        """
        assert ctx.unit is not None
        board = ctx.board
        elims: list[Elimination] = []

        def check(
            cage_cells: frozenset[Cell],
            must: set[int],
            unit_cells: frozenset[Cell],
        ) -> None:
            """Append eliminations for the outie when the condition is met.

            Condition: exactly one cage cell outside unit (outie), and exactly
            one external cell in unit whose candidates are a non-empty subset
            of must.  Eliminates from outie any digit absent in that cell's
            candidates.
            """
            inside = cage_cells & unit_cells
            outside = cage_cells - unit_cells
            if len(outside) != 1 or not inside:
                return
            outie = next(iter(outside))
            outie_cands = board.candidates[outie[0]][outie[1]]
            if not outie_cands:
                return

            # Find external cells whose candidates are a non-empty subset of must
            qualifying: list[Cell] = [
                (r, c)
                for r, c in unit_cells
                if (r, c) not in cage_cells
                and board.candidates[r][c]
                and board.candidates[r][c].issubset(must)
            ]
            if len(qualifying) != 1:
                return

            x_r, x_c = qualifying[0]
            x_cands = board.candidates[x_r][x_c]
            for d in outie_cands:
                if d not in x_cands:
                    elims.append(Elimination(cell=outie, digit=d))

        if ctx.unit.kind == UnitKind.CAGE:
            if not ctx.unit.distinct_digits:
                return []
            cage_cells = ctx.unit.cells
            cage_idx = ctx.unit.unit_id - 27
            solns = board.cage_solns[cage_idx]
            if not solns:
                return []
            must: set[int] = set(solns[0])
            for s in solns[1:]:
                must &= s
            if not must:
                return []
            seen_unit_ids: set[int] = set()
            for r, c in cage_cells:
                for uid in board.cell_unit_ids(r, c):
                    unit = board.units[uid]
                    if unit.kind == UnitKind.CAGE or uid in seen_unit_ids:
                        continue
                    seen_unit_ids.add(uid)
                    check(cage_cells, must, unit.cells)
        else:
            unit_cells = ctx.unit.cells
            seen_cage_ids: set[int] = set()
            for r, c in unit_cells:
                for uid in board.cell_unit_ids(r, c):
                    other = board.units[uid]
                    if other.kind != UnitKind.CAGE or not other.distinct_digits:
                        continue
                    cage_idx = other.unit_id - 27
                    if cage_idx in seen_cage_ids:
                        continue
                    seen_cage_ids.add(cage_idx)
                    solns = board.cage_solns[cage_idx]
                    if not solns:
                        continue
                    cage_must: set[int] = set(solns[0])
                    for s in solns[1:]:
                        cage_must &= s
                    if not cage_must:
                        continue
                    check(other.cells, cage_must, unit_cells)

        return elims
