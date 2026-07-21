"""R13 Simple Colouring â single-digit chain eliminations.

For each digit d, build a graph of conjugate pairs: pairs of cells in a unit
(row, column, or 3Ã3 box) where d appears in exactly those two cells.  Colour
the graph with two colours via BFS.  Two inference patterns follow:

  Wrap (colour conflict):
    If two cells of the same colour see each other, one of them must be wrong
    â so every cell of that colour can have d eliminated.

  Trap:
    Any uncoloured cell that sees at least one cell of each colour can have d
    eliminated (because whichever colour is "true", d is present in something
    that sees it).

Fires on GLOBAL trigger.
"""

from __future__ import annotations

from collections import deque

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind

Cell = tuple[int, int]


def _sees(r1: int, c1: int, r2: int, c2: int) -> bool:
    """Return True if the two cells share a row, column, or 3Ã3 box."""
    if r1 == r2 or c1 == c2:
        return True
    return (r1 // 3, c1 // 3) == (r2 // 3, c2 // 3)


class SimpleColouring:
    """R13: Simple colouring â eliminate a digit via single-digit chain reasoning."""

    name = "SimpleColouring"
    description = (
        "Uses chains of cells where a digit can only go in one of two places to "
        "eliminate that digit from cells that see both ends of the chain."
    )
    priority = 18
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()  # GLOBAL

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Scan all digits for simple colouring patterns."""
        board = ctx.board
        elims: list[Elimination] = []

        for d in range(1, 10):
            # Build conjugate-pair adjacency graph for digit d.
            # A conjugate pair is a unit where d appears in exactly 2 cells.
            adj: dict[Cell, list[Cell]] = {}

            for r in range(9):
                cols = [c for c in range(9) if d in board.candidates[r][c]]
                if len(cols) == 2:
                    a, b = (r, cols[0]), (r, cols[1])
                    adj.setdefault(a, []).append(b)
                    adj.setdefault(b, []).append(a)

            for c in range(9):
                rows = [r for r in range(9) if d in board.candidates[r][c]]
                if len(rows) == 2:
                    a, b = (rows[0], c), (rows[1], c)
                    adj.setdefault(a, []).append(b)
                    adj.setdefault(b, []).append(a)

            for br in range(3):
                for bc in range(3):
                    cells = [
                        (br * 3 + dr, bc * 3 + dc)
                        for dr in range(3)
                        for dc in range(3)
                        if d in board.candidates[br * 3 + dr][bc * 3 + dc]
                    ]
                    if len(cells) == 2:
                        a, b = cells[0], cells[1]
                        adj.setdefault(a, []).append(b)
                        adj.setdefault(b, []).append(a)

            # 2-colour each connected component via BFS.
            colour: dict[Cell, int] = {}
            for start in list(adj):
                if start in colour:
                    continue
                colour[start] = 0
                queue: deque[Cell] = deque([start])
                while queue:
                    cell = queue.popleft()
                    for nb in adj[cell]:
                        if nb not in colour:
                            colour[nb] = 1 - colour[cell]
                            queue.append(nb)

            # Find connected components by BFS.
            component_of: dict[Cell, int] = {}
            comp_id = 0
            for start in list(adj):
                if start in component_of:
                    continue
                queue2: deque[Cell] = deque([start])
                component_of[start] = comp_id
                while queue2:
                    cell = queue2.popleft()
                    for nb in adj.get(cell, []):
                        if nb not in component_of:
                            component_of[nb] = comp_id
                            queue2.append(nb)
                comp_id += 1

            # Build per-component colour sets.
            comp_colours: dict[int, tuple[set[Cell], set[Cell]]] = {}
            for cell, cid in component_of.items():
                if cid not in comp_colours:
                    comp_colours[cid] = (set(), set())
                comp_colours[cid][colour[cell]].add(cell)

            for c0_cells, c1_cells in comp_colours.values():
                if not c0_cells or not c1_cells:
                    continue

                # --- Wrap: two cells of the same colour see each other ---
                def _has_conflict(cell_set: set[Cell]) -> bool:
                    cell_list = list(cell_set)
                    for i, (r1, c1_) in enumerate(cell_list):
                        for r2, c2_ in cell_list[i + 1 :]:
                            if _sees(r1, c1_, r2, c2_):
                                return True
                    return False

                if _has_conflict(c0_cells):
                    for r, c in c0_cells:
                        if d in board.candidates[r][c]:
                            elims.append(Elimination(cell=(r, c), digit=d))
                    continue

                if _has_conflict(c1_cells):
                    for r, c in c1_cells:
                        if d in board.candidates[r][c]:
                            elims.append(Elimination(cell=(r, c), digit=d))
                    continue

                # --- Trap: uncoloured cell sees both colours ---
                all_coloured = c0_cells | c1_cells
                for r in range(9):
                    for c in range(9):
                        if (r, c) in all_coloured:
                            continue
                        if d not in board.candidates[r][c]:
                            continue
                        sees_c0 = any(_sees(r, c, cr, cc) for cr, cc in c0_cells)
                        sees_c1 = any(_sees(r, c, cr, cc) for cr, cc in c1_cells)
                        if sees_c0 and sees_c1:
                            elims.append(Elimination(cell=(r, c), digit=d))

        return RuleResult(eliminations=list(dict.fromkeys(elims)))

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
