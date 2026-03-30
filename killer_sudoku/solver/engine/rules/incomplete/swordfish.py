"""R13 Swordfish â 3-unit basic fish pattern (row and column variants).

When digit d appears in 2 or 3 positions within each of exactly 3 rows,
and those positions collectively span only 3 columns, d can be eliminated
from all other cells in those 3 columns (and vice versa for columnsârows).

This is the size-3 generalisation of X-Wing; it catches cases where no
single pair of rows forms an X-Wing but three rows together cover only 3
columns.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

import itertools

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class Swordfish:
    """R13: Swordfish â 3-row or 3-column basic fish."""

    name = "Swordfish"
    priority = 14
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()  # GLOBAL

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Scan for row-based and column-based Swordfish patterns."""
        board = ctx.board
        elims: list[Elimination] = []

        for d in range(1, 10):
            # Row variant: rows where d appears in 2 or 3 columns
            row_cols: list[tuple[int, frozenset[int]]] = []
            for r in range(9):
                cols_with_d = frozenset(
                    c for c in range(9) if d in board.candidates[r][c]
                )
                if 2 <= len(cols_with_d) <= 3:
                    row_cols.append((r, cols_with_d))

            for triple in itertools.combinations(row_cols, 3):
                base_rows = frozenset(r for r, _ in triple)
                cover_cols: set[int] = set()
                for _, cs in triple:
                    cover_cols |= cs
                if len(cover_cols) != 3:
                    continue
                for col in cover_cols:
                    for r in range(9):
                        if r not in base_rows and d in board.candidates[r][col]:
                            elims.append(Elimination(cell=(r, col), digit=d))

            # Column variant: cols where d appears in 2 or 3 rows
            col_rows: list[tuple[int, frozenset[int]]] = []
            for c in range(9):
                rows_with_d = frozenset(
                    r for r in range(9) if d in board.candidates[r][c]
                )
                if 2 <= len(rows_with_d) <= 3:
                    col_rows.append((c, rows_with_d))

            for triple in itertools.combinations(col_rows, 3):
                base_cols = frozenset(c for c, _ in triple)
                cover_rows: set[int] = set()
                for _, rs in triple:
                    cover_rows |= rs
                if len(cover_rows) != 3:
                    continue
                for row in cover_rows:
                    for c in range(9):
                        if c not in base_cols and d in board.candidates[row][c]:
                            elims.append(Elimination(cell=(row, c), digit=d))

        return list(dict.fromkeys(elims))

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
