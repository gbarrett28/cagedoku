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

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind


class CellSolutionElimination:
    """R1b: eliminate a confirmed digit from all row/col/box peers."""

    name = "CellSolutionElimination"
    priority = 0
    triggers: frozenset[Trigger] = frozenset({Trigger.CELL_SOLVED})
    unit_kinds: frozenset[UnitKind] = frozenset()  # cell-scoped

    def apply(self, ctx: RuleContext) -> RuleResult:
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
        return RuleResult(eliminations=elims)

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Describe the peer eliminations for a solved cell.

        CellSolutionElimination fires on CELL_SOLVED; ctx.cell is the
        determined cell and ctx.hint_digit is its placed value.
        """
        if not eliminations:
            return []
        assert ctx.cell is not None
        assert ctx.hint_digit is not None
        r, c = ctx.cell
        d = ctx.hint_digit
        peer_labels = ", ".join(
            sorted(f"r{e.cell[0] + 1}c{e.cell[1] + 1}" for e in eliminations)
        )
        return [
            HintResult(
                rule_name=self.name,
                display_name="Naked Single",
                explanation=(
                    f"Cell r{r + 1}c{c + 1} is {d}. "
                    f"Eliminating {d} from peers: {peer_labels}."
                ),
                highlight_cells=frozenset({ctx.cell} | {e.cell for e in eliminations}),
                eliminations=eliminations,
            )
        ]
