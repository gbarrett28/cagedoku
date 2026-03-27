"""R1b CellSolutionElimination — eliminate a confirmed digit from all unit peers.

Fires on CELL_SOLVED (emitted by the engine after CELL_DETERMINED).  Receives
cell=(r,c) and hint_digit=d.  Returns Eliminations removing d from all cells
sharing a row, col, or box (cage peers are handled by R3/R4 cage rules).

This is the peer-propagation step of a naked single: once the engine has
committed a cell's solution via CELL_SOLVED, this rule ensures d is removed
from every peer in the same row, column, and 3×3 box.

Separation from NakedSingle (R1a):
  R1a (CELL_DETERMINED) — recognition and placement hint
  R1b (CELL_SOLVED)     — peer candidate elimination

This two-trigger chain makes the data flow explicit: NakedSingle acknowledges
the cell first, then CellSolutionElimination cleans up peers.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind


class CellSolutionElimination:
    """R1b: eliminate a confirmed digit from all row/col/box peers."""

    name = "CellSolutionElimination"
    priority = 0
    triggers: frozenset[Trigger] = frozenset({Trigger.CELL_SOLVED})
    unit_kinds: frozenset[UnitKind] = frozenset()  # cell-scoped

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Eliminate hint_digit from all row/col/box peers of ctx.cell."""
        assert ctx.cell is not None
        assert ctx.hint_digit is not None
        r, c = ctx.cell
        d = ctx.hint_digit
        elims: list[Elimination] = []
        for uid in ctx.board.cell_unit_ids(r, c):
            unit = ctx.board.units[uid]
            if unit.kind == UnitKind.CAGE:
                continue  # cage peers handled by R3/R4
            for pr, pc in unit.cells:
                if (pr, pc) != (r, c) and d in ctx.board.candidates[pr][pc]:
                    elims.append(Elimination(cell=(pr, pc), digit=d))
        return elims

    def compute_hints(self, board: BoardState) -> list[HintResult]:
        """Return elimination hints for naked singles when demoted to hint-only.

        When this rule is always-apply (the default) it is skipped by
        collect_hints.  This method is only reached when the user has demoted
        CellSolutionElimination to hint-only via the config modal.
        """
        naked_singles: list[tuple[int, int, int]] = [
            (r, c, next(iter(board.candidates[r][c])))
            for r in range(9)
            for c in range(9)
            if len(board.candidates[r][c]) == 1
        ]
        if not naked_singles:
            return []

        seen_elim_keys: set[tuple[Cell, int]] = set()
        all_elims: list[Elimination] = []
        highlight: set[Cell] = set()

        for r, c, d in naked_singles:
            highlight.add((r, c))
            for uid in board.cell_unit_ids(r, c):
                unit = board.units[uid]
                if unit.kind == UnitKind.CAGE:
                    continue
                for pr, pc in unit.cells:
                    if (pr, pc) != (r, c) and d in board.candidates[pr][pc]:
                        key: tuple[Cell, int] = ((pr, pc), d)
                        if key not in seen_elim_keys:
                            seen_elim_keys.add(key)
                            all_elims.append(Elimination(cell=(pr, pc), digit=d))

        if not all_elims:
            return []

        if len(naked_singles) == 1:
            r0, c0, d0 = naked_singles[0]
            explanation = (
                f"Cell r{r0 + 1}c{c0 + 1} has only one remaining candidate:"
                f" {d0}. It must be {d0}."
            )
        else:
            parts = [f"r{r + 1}c{c + 1} must be {d}" for r, c, d in naked_singles]
            explanation = f"{len(naked_singles)} naked singles: {'; '.join(parts)}."

        return [
            HintResult(
                rule_name=self.name,
                display_name="Naked Single",
                explanation=explanation,
                highlight_cells=frozenset(highlight),
                eliminations=all_elims,
            )
        ]
