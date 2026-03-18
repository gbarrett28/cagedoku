"""R4 SolutionMapFilter — prune cage solutions incompatible with current candidates.

For each cage solution, check whether its digit set is a subset of the union
of candidate sets across all cage cells. If not, the solution is dead and
digits it uniquely provided can be eliminated from the cage cells.

Fires on COUNT_DECREASED and SOLUTION_PRUNED for CAGE units.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class SolutionMapFilter:
    """R4: eliminate digits not supported by any surviving cage solution."""

    name = "SolutionMapFilter"
    priority = 3
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.CAGE})

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Remove cage digits that appear in no surviving solution."""
        assert ctx.unit is not None
        cage_cells = list(ctx.unit.cells)
        board = ctx.board
        cage_idx = ctx.unit.unit_id - 27
        solns = board.cage_solns[cage_idx]
        if not solns:
            return []

        # Union of all candidates still present in any cage cell
        available: set[int] = set()
        for r, c in cage_cells:
            available |= board.candidates[r][c]

        # A solution is feasible if its digit set fits within available candidates.
        # (Fine-grained per-cell assignment is handled by R3 CageIntersection.)
        surviving = [s for s in solns if s <= available]

        if len(surviving) == len(solns):
            return []  # no solutions pruned by this check

        # Digits that appear in at least one surviving solution
        possible: set[int] = set()
        for s in surviving:
            possible |= s

        # Eliminate digits that can no longer appear anywhere in the cage
        elims: list[Elimination] = []
        for r, c in cage_cells:
            for d in list(board.candidates[r][c]):
                if d not in possible:
                    elims.append(Elimination(cell=(r, c), digit=d))
        return elims
