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

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind


def _cell_label(cell: Cell) -> str:
    """Return rNcM notation (1-based) for a cell."""
    r, c = cell
    return f"r{r + 1}c{c + 1}"


class CageCandidateFilter:
    """Restrict cage cell candidates to digits present in at least one cage solution."""

    name = "CageCandidateFilter"
    priority = 2
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.CAGE})

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Eliminate digits from cage cells that appear in no remaining solution."""
        assert ctx.unit is not None
        if not ctx.unit.distinct_digits:
            return []
        board = ctx.board
        cage_idx = ctx.unit.unit_id - 27
        solns = board.cage_solns[cage_idx]
        if not solns:
            return []
        cage_possible: set[int] = set().union(*solns)
        return [
            Elimination(cell=(r, c), digit=d)
            for r, c in ctx.unit.cells
            for d in list(board.candidates[r][c])
            if d not in cage_possible
        ]

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder — replaced with full implementation in Task 5."""
        return []

    def compute_hints(self, board: BoardState) -> list[HintResult]:
        """Return one HintResult per cage that has eliminable digits."""
        results: list[HintResult] = []
        for unit in board.units:
            if unit.kind != UnitKind.CAGE or not unit.distinct_digits:
                continue
            cage_idx = unit.unit_id - 27
            solns = board.cage_solns[cage_idx]
            if not solns:
                continue
            cage_possible: set[int] = set().union(*solns)
            solns_str = "{" + ", ".join(str(d) for d in sorted(cage_possible)) + "}"
            elims = [
                Elimination(cell=(r, c), digit=d)
                for r, c in unit.cells
                for d in list(board.candidates[r][c])
                if d not in cage_possible
            ]
            if not elims:
                continue
            cell_labels = ", ".join(sorted(_cell_label(c) for c in unit.cells))
            affected = sorted(
                {_cell_label(e.cell) for e in elims},
                key=lambda s: (int(s[1 : s.index("c")]), int(s[s.index("c") + 1 :])),
            )
            removed = sorted({e.digit for e in elims})
            removed_str = ", ".join(str(d) for d in removed)
            affected_str = ", ".join(affected)
            explanation = (
                f"Cage [{cell_labels}] has solutions {solns_str}. "
                f"Digit{'s' if len(removed) > 1 else ''} {removed_str} "
                f"do{'es' if len(removed) == 1 else ''} not appear in any solution "
                f"and can be eliminated from {affected_str}."
            )
            results.append(
                HintResult(
                    rule_name="CageCandidateFilter",
                    display_name="Digit impossible for cage",
                    explanation=explanation,
                    highlight_cells=frozenset(unit.cells),
                    eliminations=elims,
                )
            )
        return results
