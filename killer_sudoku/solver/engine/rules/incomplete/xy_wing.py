"""R15 XY-Wing â three-cell bivalue chain elimination.

A pivot cell P with exactly two candidates {x, y} sees two pincer cells:
  - Pincer A with candidates {x, z}  (shares a unit with P)
  - Pincer B with candidates {y, z}  (shares a unit with P)

Any cell that sees both A and B can have z eliminated, because whichever
value P takes (x or y), one of the pincers must hold z.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind


def _sees(r1: int, c1: int, r2: int, c2: int) -> bool:
    """Return True if the two cells share a row, column, or 3Ã3 box."""
    if r1 == r2 or c1 == c2:
        return True
    return (r1 // 3, c1 // 3) == (r2 // 3, c2 // 3)


class XYWing:
    """R15: XY-Wing â three bivalue cells forming a chain."""

    name = "XYWing"
    priority = 16
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()  # GLOBAL

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Find all XY-Wing patterns and return z-eliminations."""
        board = ctx.board
        elims: list[Elimination] = []

        # Collect all bivalue cells as (cell, cand_a, cand_b) with cand_a < cand_b
        bivalue: list[tuple[Cell, int, int]] = []
        for r in range(9):
            for c in range(9):
                if len(board.candidates[r][c]) == 2:
                    d1, d2 = sorted(board.candidates[r][c])
                    bivalue.append(((r, c), d1, d2))

        # For each pivot P = {x, y}, find pincers A = {x, z} and B = {y, z}
        # where both pincers see the pivot, and eliminate z from cells seeing both
        for (pr, pc), x, y in bivalue:
            # Build pincers grouped by which shared digit they carry
            # x_pincers: cells seeing P with {x, z} for some z != y
            # y_pincers: cells seeing P with {y, z} for some z != x
            x_pincers: list[tuple[Cell, int]] = []  # (cell, z)
            y_pincers: list[tuple[Cell, int]] = []

            for (ar, ac), a1, a2 in bivalue:
                if (ar, ac) == (pr, pc):
                    continue
                if not _sees(pr, pc, ar, ac):
                    continue
                # A shares x with P but not y
                if a1 == x and a2 != y:
                    x_pincers.append(((ar, ac), a2))
                elif a2 == x and a1 != y:
                    x_pincers.append(((ar, ac), a1))
                # A shares y with P but not x
                if a1 == y and a2 != x:
                    y_pincers.append(((ar, ac), a2))
                elif a2 == y and a1 != x:
                    y_pincers.append(((ar, ac), a1))

            # Pair up pincers: A from x_pincers, B from y_pincers with same z
            for (ar, ac), z_a in x_pincers:
                for (br, bc), z_b in y_pincers:
                    if z_a != z_b:
                        continue
                    if (ar, ac) == (br, bc):
                        continue
                    z = z_a
                    # Eliminate z from all cells seeing both A and B
                    for r in range(9):
                        for c in range(9):
                            if (r, c) in ((ar, ac), (br, bc)):
                                continue
                            if z in board.candidates[r][c]:
                                if _sees(r, c, ar, ac) and _sees(r, c, br, bc):
                                    elims.append(Elimination(cell=(r, c), digit=z))

        return list(dict.fromkeys(elims))

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
