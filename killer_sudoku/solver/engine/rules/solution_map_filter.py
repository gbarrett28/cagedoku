"""R4 SolutionMapFilter — prune cage solutions incompatible with current candidates.

For each cage solution, perform a per-cell bipartite feasibility check: does a
valid assignment of the solution's digits to cells exist given current candidate
sets? If not, the solution is infeasible and is removed. After pruning, eliminate
from each cell any digit that appears in no feasible assignment across all
surviving solutions.

This mirrors Grid.sol_maps: the old solver uses backtracking to assign digits to
cells and collects per-cell possible digits. The coarse "digit-set ⊆ union of
candidates" check R4 previously used missed cases where a digit is available in
the union but cannot actually be placed given per-cell constraints.

Fires on COUNT_DECREASED and SOLUTION_PRUNED for CAGE units.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind


def _per_cell_possible(
    sorted_cells: list[Cell],
    solution: frozenset[int],
    candidates: list[list[set[int]]],
) -> dict[Cell, set[int]]:
    """Return per-cell possible digits for one cage solution via backtracking.

    Explores all feasible assignments of solution's digits to cells (respecting
    per-cell candidate sets) and collects the union of feasible digits per cell.
    Returns a dict with empty sets for all cells if no feasible assignment
    exists (the solution is infeasible).

    Cells must be pre-sorted most-constrained first for good pruning performance.
    """
    result: dict[Cell, set[int]] = {c: set() for c in sorted_cells}

    def bt(idx: int, remaining: set[int]) -> bool:
        """Explore all feasible completions; populate result; return True if any."""
        if idx == len(sorted_cells):
            return True
        r, c = sorted_cells[idx]
        found = False
        for d in list(candidates[r][c] & remaining):
            remaining.discard(d)
            if bt(idx + 1, remaining):
                result[(r, c)].add(d)
                found = True
            remaining.add(d)
        return found

    bt(0, set(solution))
    return result


class SolutionMapFilter:
    """R4: per-cell feasibility filter for cage solutions."""

    name = "SolutionMapFilter"
    priority = 3
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.CAGE})

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Prune infeasible cage solutions; eliminate unsupported (cell, digit) pairs.

        Skips non-burb virtual cages (distinct_digits=False): per-cell
        backtracking assumes distinct digit assignment which is not guaranteed
        for cells spanning multiple sudoku units.  MustContain handles these.

        For each surviving solution, runs per-cell backtracking to find all
        feasible digit assignments. Solutions with no feasible per-cell
        assignment are removed from cage_solns. Each (cell, digit) pair not
        reachable in any feasible assignment across all surviving solutions is
        returned as an Elimination.

        Note: infeasible solutions are removed directly from board.cage_solns
        because the Rule protocol (return Elimination only) has no channel for
        solution-level pruning. The missing SOLUTION_PRUNED events are acceptable
        since R3/R4/R5 re-trigger via COUNT_DECREASED from the returned
        Eliminations.
        """
        assert ctx.unit is not None
        # Non-burb virtual cages: skip per-cell filtering (distinct-digit
        # backtracking would eliminate valid candidates for cells that can share
        # digits across units).  MustContain handles the must-intersection logic.
        if not ctx.unit.distinct_digits:
            return []
        cage_cells: list[Cell] = list(ctx.unit.cells)
        board = ctx.board
        cage_idx = ctx.unit.unit_id - 27
        solns = list(board.cage_solns[cage_idx])
        if not solns:
            return []

        # Sort cells most-constrained first for efficient backtracking pruning
        sorted_cells = sorted(
            cage_cells,
            key=lambda rc: len(
                board.candidates[rc[0]][rc[1]] & frozenset().union(*solns)
            ),
        )

        per_cell_possible: dict[Cell, set[int]] = {c: set() for c in cage_cells}
        surviving: list[frozenset[int]] = []

        for soln in solns:
            cell_poss = _per_cell_possible(sorted_cells, soln, board.candidates)
            if all(cell_poss[c] for c in cage_cells):
                for c, digits in cell_poss.items():
                    per_cell_possible[c] |= digits
                surviving.append(soln)

        # Remove per-cell-infeasible solutions directly (see note in docstring)
        if len(surviving) < len(solns):
            board.cage_solns[cage_idx][:] = surviving

        # Eliminate (cell, digit) pairs absent from all feasible assignments
        elims: list[Elimination] = []
        for cell in cage_cells:
            for d in list(board.candidates[cell[0]][cell[1]]):
                if d not in per_cell_possible.get(cell, set()):
                    elims.append(Elimination(cell=cell, digit=d))
        return elims
