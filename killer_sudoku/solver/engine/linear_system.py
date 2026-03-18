"""LinearSystem — equation setup and Gaussian elimination for the solver engine.

Builds a linear system over Q from all row/col/box/cage sum equations,
reduces it to RREF using exact rational arithmetic (fractions.Fraction),
and extracts:
- initial_eliminations: cells whose value is determined at setup
- delta_pairs: list of (cell_p, cell_q, delta) where value[p] - value[q] = delta
- pairs_for_cell(cell): O(k) lookup returning active pairs involving that cell
- substitute_cell(cell, value): update pairs when a cell becomes determined

The 81 unknowns are the digit values of each cell (0-based row, col).
"""

from __future__ import annotations

import dataclasses
from fractions import Fraction

from killer_sudoku.solver.engine.types import Cell, Elimination
from killer_sudoku.solver.puzzle_spec import PuzzleSpec


@dataclasses.dataclass
class LinearSystem:
    """Gaussian-reduced linear system built from a PuzzleSpec at solver setup."""

    initial_eliminations: list[Elimination]
    delta_pairs: list[tuple[Cell, Cell, int]]
    _pairs_by_cell: dict[Cell, list[tuple[Cell, Cell, int]]]

    def __init__(self, spec: PuzzleSpec) -> None:
        self.initial_eliminations = []
        self.delta_pairs = []
        self._pairs_by_cell = {}

        # Variable index: cell (r,c) -> column 0..80
        var_index: dict[Cell, int] = {
            (r, c): r * 9 + c for r in range(9) for c in range(9)
        }
        n_vars = 81

        rows: list[list[Fraction]] = []

        def add_eq(cells: list[Cell], total: int) -> None:
            row = [Fraction(0)] * (n_vars + 1)
            for cell in cells:
                row[var_index[cell]] += Fraction(1)
            row[n_vars] = Fraction(total)
            rows.append(row)

        # Standard sudoku constraints: each row/col/box sums to 45
        for r in range(9):
            add_eq([(r, c) for c in range(9)], 45)
        for c in range(9):
            add_eq([(r, c) for r in range(9)], 45)
        for b in range(9):
            r0, c0 = (b // 3) * 3, (b % 3) * 3
            add_eq([(r0 + dr, c0 + dc) for dr in range(3) for dc in range(3)], 45)

        # Cage equations
        cage_cells: dict[int, list[Cell]] = {}
        cage_totals_map: dict[int, int] = {}
        for r in range(9):
            for c in range(9):
                cid = int(spec.regions[r, c])
                cage_cells.setdefault(cid, []).append((r, c))
                v = int(spec.cage_totals[r, c])
                if v != 0:
                    cage_totals_map[cid] = v
        for cid, cells in cage_cells.items():
            total = cage_totals_map.get(cid, 0)
            if total > 0:
                add_eq(cells, total)

        # Gaussian elimination to RREF
        n_rows = len(rows)
        pivot_row = 0
        for pivot_col in range(n_vars):
            if pivot_row >= n_rows:
                break
            # Find a pivot in this column at or below pivot_row
            found = -1
            for i in range(pivot_row, n_rows):
                if rows[i][pivot_col] != 0:
                    found = i
                    break
            if found == -1:
                continue
            rows[pivot_row], rows[found] = rows[found], rows[pivot_row]
            scale = rows[pivot_row][pivot_col]
            rows[pivot_row] = [x / scale for x in rows[pivot_row]]
            for i in range(n_rows):
                if i != pivot_row and rows[i][pivot_col] != 0:
                    factor = rows[i][pivot_col]
                    rows[i] = [
                        rows[i][j] - factor * rows[pivot_row][j]
                        for j in range(n_vars + 1)
                    ]
            pivot_row += 1

        # Extract determined cells and difference pairs from reduced system
        idx_to_cell = {v: k for k, v in var_index.items()}
        for row in rows:
            nonzero = [(j, row[j]) for j in range(n_vars) if row[j] != 0]
            rhs = row[n_vars]
            if not nonzero:
                continue
            if len(nonzero) == 1:
                j, coeff = nonzero[0]
                val_frac = rhs / coeff
                if val_frac.denominator == 1:
                    val = int(val_frac)
                    if 1 <= val <= 9:
                        cell = idx_to_cell[j]
                        for d in range(1, 10):
                            if d != val:
                                self.initial_eliminations.append(
                                    Elimination(cell=cell, digit=d)
                                )
            elif len(nonzero) == 2:
                j_p, coeff_p = nonzero[0]
                j_q, coeff_q = nonzero[1]
                # Pattern: +1*x + -1*y = delta  →  x - y = delta
                if coeff_p == Fraction(1) and coeff_q == Fraction(-1):
                    if rhs.denominator == 1:
                        pair: tuple[Cell, Cell, int] = (
                            idx_to_cell[j_p],
                            idx_to_cell[j_q],
                            int(rhs),
                        )
                        self.delta_pairs.append(pair)
                elif coeff_p == Fraction(-1) and coeff_q == Fraction(1):
                    if rhs.denominator == 1:
                        pair = (idx_to_cell[j_q], idx_to_cell[j_p], int(-rhs))
                        self.delta_pairs.append(pair)

        # Build per-cell index for O(k) lookup
        for pair in self.delta_pairs:
            p, q, _ = pair
            self._pairs_by_cell.setdefault(p, []).append(pair)
            self._pairs_by_cell.setdefault(q, []).append(pair)

    def pairs_for_cell(self, cell: Cell) -> list[tuple[Cell, Cell, int]]:
        """Return all active delta pairs where cell is either p or q."""
        return list(self._pairs_by_cell.get(cell, []))

    def substitute_cell(self, cell: Cell, value: int) -> list[Elimination]:
        """Update active delta pairs when cell becomes determined.

        Removes all pairs containing this cell. For each such pair, if the
        other cell's value is now forced, emits eliminations to place it.
        """
        pairs = list(self._pairs_by_cell.pop(cell, []))
        eliminations: list[Elimination] = []
        for pair in pairs:
            p, q, delta = pair
            if pair in self.delta_pairs:
                self.delta_pairs.remove(pair)
            other = q if p == cell else p
            other_list = self._pairs_by_cell.get(other, [])
            if pair in other_list:
                other_list.remove(pair)
            # Derive other cell's value: if cell=p then value_q = value - delta
            #                            if cell=q then value_p = value + delta
            other_val = (value - delta) if p == cell else (value + delta)
            if 1 <= other_val <= 9:
                for d in range(1, 10):
                    if d != other_val:
                        eliminations.append(Elimination(cell=other, digit=d))
        return eliminations
