"""R14 Jellyfish — 4-unit basic fish pattern (row and column variants).

When digit d appears in 2, 3, or 4 positions within each of exactly 4
rows and those positions collectively span only 4 columns, d can be
eliminated from all other cells in those 4 columns (and vice versa).

This is the size-4 generalisation of X-Wing/Swordfish.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

import itertools

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class Jellyfish:
    """R14: Jellyfish — 4-row or 4-column basic fish."""

    name = "Jellyfish"
    priority = 15
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()  # GLOBAL

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Scan for row-based and column-based Jellyfish patterns."""
        board = ctx.board
        elims: list[Elimination] = []

        for d in range(1, 10):
            # Row variant: rows where d appears in 2..4 columns
            row_cols: list[tuple[int, frozenset[int]]] = []
            for r in range(9):
                cols_with_d = frozenset(
                    c for c in range(9) if d in board.candidates[r][c]
                )
                if 2 <= len(cols_with_d) <= 4:
                    row_cols.append((r, cols_with_d))

            for quad in itertools.combinations(row_cols, 4):
                base_rows = frozenset(r for r, _ in quad)
                cover_cols: set[int] = set()
                for _, cs in quad:
                    cover_cols |= cs
                if len(cover_cols) != 4:
                    continue
                for col in cover_cols:
                    for r in range(9):
                        if r not in base_rows and d in board.candidates[r][col]:
                            elims.append(Elimination(cell=(r, col), digit=d))

            # Column variant: cols where d appears in 2..4 rows
            col_rows: list[tuple[int, frozenset[int]]] = []
            for c in range(9):
                rows_with_d = frozenset(
                    r for r in range(9) if d in board.candidates[r][c]
                )
                if 2 <= len(rows_with_d) <= 4:
                    col_rows.append((c, rows_with_d))

            for quad in itertools.combinations(col_rows, 4):
                base_cols = frozenset(c for c, _ in quad)
                cover_rows: set[int] = set()
                for _, rs in quad:
                    cover_rows |= rs
                if len(cover_rows) != 4:
                    continue
                for row in cover_rows:
                    for c in range(9):
                        if c not in base_cols and d in board.candidates[row][c]:
                            elims.append(Elimination(cell=(row, c), digit=d))

        return list(dict.fromkeys(elims))
