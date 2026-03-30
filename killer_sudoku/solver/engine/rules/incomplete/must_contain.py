"""R5 MustContain â cage must-contain digits confined to an overlap region.

When a cage's must-contain digits can only be placed in cells that all lie
within a shared row/col/box, those digits are eliminated from the rest of
that row/col/box outside the cage.

Fires on COUNT_DECREASED for all unit kinds.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class MustContain:
    """R5: cage must-contain intersection â eliminate from external shared cells."""

    name = "MustContain"
    priority = 4
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """For each cage overlapping this unit, eliminate its confined digits.

        Non-burb virtual cages (distinct_digits=False) are skipped as the
        triggering unit: eliminating from their cells via real-cage must-sets
        is unsound because those cells span multiple units and can share digits.
        Non-burb cages still contribute as the *overlapping* cage when a real
        unit fires â in that direction the logic is safe.
        """
        assert ctx.unit is not None
        if not ctx.unit.distinct_digits:
            return []
        board = ctx.board
        unit_cells = ctx.unit.cells
        elims: list[Elimination] = []
        seen_cage_ids: set[int] = set()

        for r, c in unit_cells:
            for uid in board.cell_unit_ids(r, c):
                other = board.units[uid]
                if other.kind != UnitKind.CAGE:
                    continue
                cage_idx = other.unit_id - 27
                if cage_idx in seen_cage_ids:
                    continue
                seen_cage_ids.add(cage_idx)

                overlap = unit_cells & other.cells
                if not overlap or overlap == unit_cells:
                    continue

                # Digits other_elsewhere: available outside the overlap in the cage
                other_elsewhere: set[int] = set()
                for cr, cc in other.cells - overlap:
                    other_elsewhere |= board.candidates[cr][cc]

                # must_other: digits every remaining solution requires
                solns = board.cage_solns[cage_idx]
                if not solns:
                    continue
                must_other = set(solns[0])
                for s in solns[1:]:
                    must_other &= s

                # Digits confined to the overlap (not available elsewhere in the cage)
                confined = must_other - other_elsewhere
                if not confined:
                    continue

                # Eliminate confined digits from this unit's cells outside the overlap
                for er, ec in unit_cells - overlap:
                    for d in confined:
                        if d in board.candidates[er][ec]:
                            elims.append(Elimination(cell=(er, ec), digit=d))
        return elims

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
