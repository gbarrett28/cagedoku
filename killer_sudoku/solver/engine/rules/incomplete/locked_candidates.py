"""R10b LockedCandidates â digit in a unit confined to one cage or box.

Two patterns:

  Unit â Cage (Cage-Line Reduction):
    When all cells in a row/col/box that carry digit d lie within a single
    cage, d is locked to the unitâcage intersection.  Eliminate d from cage
    cells outside the unit.

  Unit â Box (Box-Line Reduction):
    When all cells in a row or column that carry digit d lie within a single
    3Ã3 box, d is locked to the unitâbox intersection.  Eliminate d from box
    cells outside the row/column.

These are the symmetric counterparts to CageIntersection (cageâunit) and
PointingPairs (boxârow/col).

Fires on COUNT_DECREASED for ROW, COL, and BOX units.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class LockedCandidates:
    """R10b: digit in a unit confined to one cage or box â eliminate from container."""

    name = "LockedCandidates"
    priority = 11
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX}
    )

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Eliminate d from any container that holds all of this unit's d-candidates."""
        assert ctx.unit is not None
        board = ctx.board
        unit_cells = ctx.unit.cells
        unit_kind = ctx.unit.kind
        elims: list[Elimination] = []

        for d in range(1, 10):
            cells_with_d = [
                (r, c) for r, c in unit_cells if d in board.candidates[r][c]
            ]
            if len(cells_with_d) < 2:
                continue

            # --- Unit â Cage: all d-cells in this unit share a cage ---
            common_cage_ids: set[int] | None = None
            for r, c in cells_with_d:
                cell_cages = {
                    uid
                    for uid in board.cell_unit_ids(r, c)
                    if board.units[uid].kind == UnitKind.CAGE
                }
                if common_cage_ids is None:
                    common_cage_ids = cell_cages
                else:
                    common_cage_ids &= cell_cages
                if not common_cage_ids:
                    break

            if common_cage_ids:
                for cage_uid in common_cage_ids:
                    for r, c in board.units[cage_uid].cells:
                        if (r, c) not in unit_cells and d in board.candidates[r][c]:
                            elims.append(Elimination(cell=(r, c), digit=d))

            # --- Unit â Box: row/col d-cells all in one box (Box-Line Reduction) ---
            if unit_kind in (UnitKind.ROW, UnitKind.COL):
                rows = {r for r, _ in cells_with_d}
                cols = {c for _, c in cells_with_d}
                box_rows = {r // 3 for r in rows}
                box_cols = {c // 3 for c in cols}
                if len(box_rows) == 1 and len(box_cols) == 1:
                    br, bc = next(iter(box_rows)), next(iter(box_cols))
                    # br/bc are box-grid indices (0â2); box_unit_id expects cell
                    # coordinates, so multiply back to get the top-left cell.
                    box_uid = board.box_unit_id(br * 3, bc * 3)
                    for r, c in board.units[box_uid].cells:
                        if (r, c) not in unit_cells and d in board.candidates[r][c]:
                            elims.append(Elimination(cell=(r, c), digit=d))

        return list(dict.fromkeys(elims))

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
