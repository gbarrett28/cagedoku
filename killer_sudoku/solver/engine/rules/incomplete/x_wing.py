"""R12 X-Wing â digit confined to the same two columns in two rows (or vice versa).

GLOBAL rule: scans all rows (and columns) simultaneously.
When digit d appears in exactly two columns in row r1 and in the same two
columns in row r2, eliminate d from all other rows in those columns.
The column variant mirrors this with rows and columns swapped.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

import itertools

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind


class XWing:
    """R12: X-Wing pattern â eliminate from column/row peers outside the rectangle."""

    name = "XWing"
    description = (
        "When a digit appears in only two cells in each of two rows, and those cells "
        "share the same two columns, the digit can be removed from all other cells in "
        "those columns."
    )
    priority = 13
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()  # GLOBAL

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Scan all digits for row-based and column-based X-Wing patterns."""
        board = ctx.board
        elims: list[Elimination] = []

        for d in range(1, 10):
            # Row variant: rows where d appears in exactly 2 columns
            row_cols: list[tuple[int, frozenset[int]]] = []
            for r in range(9):
                cols_with_d = frozenset(
                    c for c in range(9) if d in board.candidates[r][c]
                )
                if len(cols_with_d) == 2:
                    row_cols.append((r, cols_with_d))

            for (r1, cols1), (r2, cols2) in itertools.combinations(row_cols, 2):
                if cols1 != cols2:
                    continue
                for col in cols1:
                    for r in range(9):
                        if r not in (r1, r2) and d in board.candidates[r][col]:
                            elims.append(Elimination(cell=(r, col), digit=d))

            # Column variant: cols where d appears in exactly 2 rows
            col_rows: list[tuple[int, frozenset[int]]] = []
            for c in range(9):
                rows_with_d = frozenset(
                    r for r in range(9) if d in board.candidates[r][c]
                )
                if len(rows_with_d) == 2:
                    col_rows.append((c, rows_with_d))

            for (c1, rows1), (c2, rows2) in itertools.combinations(col_rows, 2):
                if rows1 != rows2:
                    continue
                for row in rows1:
                    for c in range(9):
                        if c not in (c1, c2) and d in board.candidates[row][c]:
                            elims.append(Elimination(cell=(row, c), digit=d))

        # Deduplicate while preserving order
        return RuleResult(eliminations=list(dict.fromkeys(elims)))

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
