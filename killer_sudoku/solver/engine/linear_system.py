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
    virtual_cages: list[tuple[frozenset[Cell], int]]
    _pairs_by_cell: dict[Cell, list[tuple[Cell, Cell, int]]]

    def __init__(self, spec: PuzzleSpec) -> None:
        self.initial_eliminations: list[Elimination] = []
        self.delta_pairs: list[tuple[Cell, Cell, int]] = []
        self.virtual_cages: list[tuple[frozenset[Cell], int]] = []
        self._pairs_by_cell: dict[Cell, list[tuple[Cell, Cell, int]]] = {}

        # Live RREF rows for dynamic constraint propagation.
        # When a cell is determined during solving, substitute_live_rows()
        # reduces these rows and returns new derived sum constraints.
        self._live_rows: dict[int, dict[Cell, Fraction]] = {}
        self._live_rhs: dict[int, Fraction] = {}
        self._live_by_cell: dict[Cell, set[int]] = {}
        self._next_rid = 0

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

        # Cage equations; also track real cage cell sets for dedup
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

        real_cage_cell_sets: set[frozenset[Cell]] = {
            frozenset(cells) for cells in cage_cells.values()
        }

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

        # Extract determined cells, difference pairs, and virtual cage sums.
        # Also store all multi-cell rows as live rows for dynamic propagation.
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
                # +1*x - 1*y = delta  →  x - y = delta
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
                else:
                    # +1*x + 1*y = k: 2-cell virtual cage sum
                    self._maybe_add_virtual_cage(
                        nonzero, rhs, idx_to_cell, real_cage_cell_sets
                    )
            else:
                # k >= 3: potential virtual cage if all coefficients are +1
                self._maybe_add_virtual_cage(
                    nonzero, rhs, idx_to_cell, real_cage_cell_sets
                )

            # Store multi-cell rows as live rows for dynamic propagation.
            # These enable substitute_live_rows() to derive new constraints
            # when cells are determined during solving.
            if len(nonzero) >= 2:
                rid = self._next_rid
                self._next_rid += 1
                rd: dict[Cell, Fraction] = {
                    idx_to_cell[j]: coeff for j, coeff in nonzero
                }
                self._live_rows[rid] = rd
                self._live_rhs[rid] = rhs
                for cell in rd:
                    self._live_by_cell.setdefault(cell, set()).add(rid)

        # Build per-cell index for O(k) lookup
        for pair in self.delta_pairs:
            p, q, _ = pair
            self._pairs_by_cell.setdefault(p, []).append(pair)
            self._pairs_by_cell.setdefault(q, []).append(pair)

    @staticmethod
    def _is_burb(vcells: frozenset[Cell]) -> bool:
        """Return True if all cells in vcells share a row, column, or 3×3 box.

        Mirrors Grid.is_burb: a cell set is a 'burb' if it fits entirely within
        a single sudoku unit. Only burb virtual cages may use sol_sums (which
        assumes distinct digits), because unit membership guarantees distinctness.
        """
        rows = {r for r, _ in vcells}
        if len(rows) == 1:
            return True
        cols = {c for _, c in vcells}
        if len(cols) == 1:
            return True
        boxes = {(r // 3, c // 3) for r, c in vcells}
        return len(boxes) == 1

    def _maybe_add_virtual_cage(
        self,
        nonzero: list[tuple[int, Fraction]],
        rhs: Fraction,
        idx_to_cell: dict[int, Cell],
        real_cage_cell_sets: set[frozenset[Cell]],
    ) -> None:
        """Add a virtual cage if the row is all-positive with integer RHS and burb.

        All-positive RREF rows represent derived sum equations: a set of cells
        whose values must sum to rhs. These arise from subtracting row/col/box
        totals from cage sums — e.g. 'rest of this row sums to k'.

        Only burb virtual cages (cells in a single row, col, or box) are kept:
        sol_sums assumes distinct digits, which is guaranteed only for cells that
        share a sudoku unit. Multi-row+multi-col virtual cages can have repeated
        digits and would cause incorrect eliminations if filtered with sol_sums.
        """
        if not all(coeff == Fraction(1) for _, coeff in nonzero):
            return
        if rhs.denominator != 1 or rhs <= 0:
            return
        vcells = frozenset(idx_to_cell[j] for j, _ in nonzero)
        # Skip if identical to an existing real cage (redundant)
        if vcells in real_cage_cell_sets:
            return
        # Only keep burb virtual cages (cells sharing a single row/col/box)
        if not self._is_burb(vcells):
            return
        self.virtual_cages.append((vcells, int(rhs)))

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

    def substitute_live_rows(
        self, cell: Cell, value: int
    ) -> list[tuple[frozenset[Cell], int]]:
        """Reduce live RREF rows when a cell is determined.

        Substitutes cell=value into every live row that contains it.
        Returns new sum constraints (frozenset[Cell], total) for rows that
        reduce to an all-positive, integer-RHS burb equation.  These can
        then be filtered against current board candidates to emit eliminations.

        Also directly emits a single-cell determination constraint when a row
        reduces to one cell, returned as a 1-cell frozenset.
        """
        row_ids = list(self._live_by_cell.pop(cell, set()))
        new_constraints: list[tuple[frozenset[Cell], int]] = []
        seen: set[frozenset[Cell]] = set()

        for rid in row_ids:
            if rid not in self._live_rows:
                continue
            row_dict = self._live_rows.pop(rid)
            row_rhs = self._live_rhs.pop(rid)

            # Substitute: remove cell, adjust RHS
            cell_coeff = row_dict.pop(cell)
            new_rhs = row_rhs - cell_coeff * Fraction(value)

            # Remove this row id from all other cells' live-row sets
            for other in row_dict:
                s = self._live_by_cell.get(other)
                if s is not None:
                    s.discard(rid)

            if not row_dict:
                # Row fully consumed — should be consistent (new_rhs ≈ 0)
                continue

            # Store reduced row under a new id
            new_rid = self._next_rid
            self._next_rid += 1
            self._live_rows[new_rid] = row_dict
            self._live_rhs[new_rid] = new_rhs
            for other in row_dict:
                self._live_by_cell.setdefault(other, set()).add(new_rid)

            # Check if we can extract a new constraint from the reduced row
            if len(row_dict) == 1:
                # Single-cell row: directly determines the remaining cell
                (remaining_cell, coeff) = next(iter(row_dict.items()))
                val_frac = new_rhs / coeff
                if val_frac.denominator == 1:
                    det_val = int(val_frac)
                    if 1 <= det_val <= 9:
                        vcells = frozenset({remaining_cell})
                        if vcells not in seen:
                            seen.add(vcells)
                            new_constraints.append((vcells, det_val))
            elif all(c == Fraction(1) for c in row_dict.values()):
                # All-positive sum row: check burb
                if new_rhs.denominator == 1 and 1 <= int(new_rhs) <= 45:
                    vcells = frozenset(row_dict)
                    if vcells not in seen and self._is_burb(vcells):
                        seen.add(vcells)
                        new_constraints.append((vcells, int(new_rhs)))

        return new_constraints
