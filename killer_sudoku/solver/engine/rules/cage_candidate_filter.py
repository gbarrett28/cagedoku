"""CageCandidateFilter — narrow each cage cell to the union of cage solutions.

The candidates of every cell in a cage must be a subset of the union of the
cage's remaining solutions.  Any digit absent from every solution is
impossible in every cell of that cage.

This is the most basic cage constraint: a digit that cannot appear in any
valid digit assignment for the cage cannot appear in any cell of the cage.

Fires on COUNT_DECREASED and SOLUTION_PRUNED for cage units so it re-runs
whenever the cage solution set shrinks.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules._registry import hintable_rule
from killer_sudoku.solver.engine.types import (
    Cell,
    Elimination,
    RuleResult,
    Trigger,
    UnitKind,
)


def _cell_label(cell: Cell) -> str:
    """Return rNcM notation (1-based) for a cell."""
    r, c = cell
    return f"r{r + 1}c{c + 1}"


@hintable_rule
class CageCandidateFilter:
    """Restrict cage cell candidates to digits present in at least one cage solution."""

    name = "CageCandidateFilter"
    description = (
        "Narrows each cell's candidates to digits that appear in at least one valid "
        "solution for that cell's cage."
    )
    priority = 2
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.CAGE})

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Eliminate digits from cage cells that appear in no remaining solution."""
        assert ctx.unit is not None
        if not ctx.unit.distinct_digits:
            return RuleResult()
        board = ctx.board
        cage_idx = ctx.unit.unit_id - 27
        solns = board.cage_solns[cage_idx]
        if not solns:
            return RuleResult()
        cage_possible: set[int] = set().union(*solns)
        return RuleResult(
            eliminations=[
                Elimination(cell=(r, c), digit=d)
                for r, c in ctx.unit.cells
                for d in list(board.candidates[r][c])
                if d not in cage_possible
            ]
        )

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """One hint per eliminated digit, explaining the cage-solution constraint.

        CageCandidateFilter fires once per cage unit; ctx.unit is that cage.
        Each hint covers all cells from which a single digit is eliminated.
        """
        if not eliminations:
            return []
        assert ctx.unit is not None
        board = ctx.board
        cage_idx = ctx.unit.unit_id - 27
        solns = board.cage_solns[cage_idx]
        cage_labels = sorted(_cell_label(c) for c in ctx.unit.cells)
        cage_str = "[" + ", ".join(cage_labels) + "]"
        total = 0
        for r, c in ctx.unit.cells:
            v = int(board.spec.cage_totals[r, c])
            if v:
                total = v
                break
        by_digit: dict[int, list[Elimination]] = {}
        for e in eliminations:
            by_digit.setdefault(e.digit, []).append(e)
        hints: list[HintResult] = []
        for digit, elims in sorted(by_digit.items()):
            cells_str = ", ".join(sorted(_cell_label(e.cell) for e in elims))
            soln_sample = [str(sorted(s)) for s in solns[:3]]
            soln_display = (
                "{" + ", ".join(soln_sample) + ("..." if len(solns) > 3 else "") + "}"
            )
            explanation = (
                f"Cage {cage_str} (total {total}) has solutions {soln_display}. "
                f"Digit {digit} does not appear in any valid solution, "
                f"so it cannot be placed in {cells_str}."
            )
            hints.append(
                HintResult(
                    rule_name=self.name,
                    display_name="Digit impossible for cage",
                    explanation=explanation,
                    highlight_cells=frozenset(e.cell for e in elims) | ctx.unit.cells,
                    eliminations=elims,
                )
            )
        return hints
