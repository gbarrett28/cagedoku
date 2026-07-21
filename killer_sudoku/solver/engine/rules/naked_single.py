"""R1a NakedSingle — recognise a cell reduced to a single candidate.

Fires on CELL_DETERMINED.  Returns no eliminations — the engine has
already reduced candidates[r][c] to a singleton.  This rule exists as
a named concept so the coaching layer can generate a placement hint:
"cell (r,c) has only one remaining candidate (d) — place d there."

Peer eliminations that follow placement are handled by CellSolutionElimination
(R1b), which fires on CELL_SOLVED after NakedSingle acknowledges the cell.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules._registry import hintable_rule
from killer_sudoku.solver.engine.types import (
    Elimination,
    Placement,
    RuleResult,
    Trigger,
    UnitKind,
)


@hintable_rule
class NakedSingle:
    """R1a: named recognition of a cell determined by a single candidate."""

    name = "NakedSingle"
    description = (
        "When a cell has only one remaining candidate, that digit must go there. Also "
        "removes it from peer cells in the same row, column, and box."
    )
    priority = 0
    triggers: frozenset[Trigger] = frozenset({Trigger.CELL_DETERMINED})
    unit_kinds: frozenset[UnitKind] = frozenset()  # cell-scoped

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Return a placement for the determined cell.

        When NakedSingle is always-apply, the engine promotes the placement to
        user_grid automatically.  When hint-only, as_hints() surfaces it as a
        coaching suggestion instead.
        """
        assert ctx.cell is not None
        assert ctx.hint_digit is not None
        return RuleResult(placements=[Placement(cell=ctx.cell, digit=ctx.hint_digit)])

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return a placement hint for the determined cell.

        NakedSingle fires on CELL_DETERMINED (ctx.cell set, ctx.hint_digit set).
        The placement hint instructs the user to place the digit — no eliminations.
        """
        assert ctx.cell is not None
        assert ctx.hint_digit is not None
        r, c = ctx.cell
        d = ctx.hint_digit
        return [
            HintResult(
                rule_name=self.name,
                display_name="Naked Single",
                explanation=(
                    f"Cell r{r + 1}c{c + 1} has only one remaining candidate:"
                    f" {d}. Place {d} there."
                ),
                highlight_cells=frozenset({(r, c)}),
                eliminations=[],
                placement=(r, c, d),
            )
        ]
