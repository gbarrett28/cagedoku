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
import itertools
from fractions import Fraction

from killer_sudoku.solver.engine.types import Cell, Elimination
from killer_sudoku.solver.equation import sol_sums
from killer_sudoku.solver.puzzle_spec import PuzzleSpec

# 4-tuple: (cells, total, distinct_digits, pre_computed_solns).
# pre_computed_solns=None for burb cages (board_state calls sol_sums);
# pre_computed_solns=list for non-burb (reduce_equns-propagated solutions).
_VirtualCage = tuple[frozenset[Cell], int, bool, list[frozenset[int]] | None]


@dataclasses.dataclass
class _DeriveEq:
    """Mutable equation used during reduce_equns-style non-burb cage derivation.

    Each instance tracks a cell set, its running sum, and the list of feasible
    distinct-digit assignments (frozensets).  difference_update() propagates
    these solution sets so that derived must-sets stay correct even for non-burb
    cells (cells spanning multiple sudoku units).
    """

    cells: frozenset[Cell]
    total: int
    solns: list[frozenset[int]]


@dataclasses.dataclass
class LinearSystem:
    """Gaussian-reduced linear system built from a PuzzleSpec at solver setup."""

    initial_eliminations: list[Elimination]
    delta_pairs: list[tuple[Cell, Cell, int]]
    virtual_cages: list[_VirtualCage]
    _pairs_by_cell: dict[Cell, list[tuple[Cell, Cell, int]]]

    def __init__(self, spec: PuzzleSpec) -> None:
        self.initial_eliminations: list[Elimination] = []
        self.delta_pairs: list[tuple[Cell, Cell, int]] = []
        # (cells, total, distinct_digits, pre_computed_solns)
        # distinct_digits=False for non-burb derived equations.
        # pre_computed_solns=None for burb cages (board_state uses sol_sums);
        # pre_computed_solns=list[frozenset[int]] for non-burb (solution sets
        # propagated via reduce_equns-style difference_update, not plain sol_sums).
        self.virtual_cages: list[_VirtualCage] = []
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

        # Derive non-burb virtual cages using reduce_equns-style subset subtraction.
        # Must be called AFTER burb virtual cages are added so they participate
        # in the derivation as input equations.
        self._derive_nonburb_virtual_cages(spec, real_cage_cell_sets)

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
        """Add a burb virtual cage for any all-positive RREF row with integer RHS.

        Only burb cell sets (cells sharing one row/col/box) are added here.
        sol_sums is correct for burb sets because unit membership guarantees
        digit distinctness.  Non-burb virtual cages are derived separately in
        _derive_nonburb_virtual_cages using reduce_equns-style solution
        propagation, which produces correct must-sets without the distinctness
        assumption.
        """
        if not all(coeff == Fraction(1) for _, coeff in nonzero):
            return
        if rhs.denominator != 1 or rhs <= 0:
            return
        vcells = frozenset(idx_to_cell[j] for j, _ in nonzero)
        if vcells in real_cage_cell_sets:
            return
        if not self._is_burb(vcells):
            return  # non-burb cages handled by _derive_nonburb_virtual_cages
        self.virtual_cages.append((vcells, int(rhs), True, None))

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
    ) -> list[tuple[frozenset[Cell], int, bool]]:
        """Reduce live RREF rows when a cell is determined.

        Substitutes cell=value into every live row that contains it.
        Returns new sum constraints (cells, total, distinct_digits) for rows
        that reduce to an all-positive, integer-RHS equation.

        distinct_digits=True for burb cells (share one unit) — the caller may
        apply sol_sums backtracking.  distinct_digits=False for non-burb cells
        — the caller must use a range-only filter to avoid wrong eliminations.

        Also directly emits single-cell determinations (1-cell frozenset,
        distinct_digits=True) when a row reduces to one variable.
        """
        row_ids = list(self._live_by_cell.pop(cell, set()))
        new_constraints: list[tuple[frozenset[Cell], int, bool]] = []
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
                            new_constraints.append((vcells, det_val, True))
            elif all(c == Fraction(1) for c in row_dict.values()):
                # All-positive sum row
                if new_rhs.denominator == 1 and 1 <= int(new_rhs) <= 45:
                    vcells = frozenset(row_dict)
                    if vcells not in seen:
                        seen.add(vcells)
                        distinct = self._is_burb(vcells)
                        new_constraints.append((vcells, int(new_rhs), distinct))

        return new_constraints

    @staticmethod
    def _reduce_derive(eqs: list[_DeriveEq]) -> None:
        """Run reduce_equns-style subset subtraction in-place.

        For each pair (ei, ej) where ei.cells ⊆ ej.cells, updates ej:
          - ej.cells  -= ei.cells
          - ej.total  -= ei.total
          - ej.solns   = {ss - os for os in ei.solns for ss in ej.solns if os ≤ ss}

        The solution propagation mirrors the old solver's Equation.difference_update:
        it filters feasible assignments so that the resulting must-set is correct
        even for non-burb cells (cells that span multiple units).

        Repeats until no further reductions are possible.
        """
        reduced = True
        while reduced:
            reduced = False
            active = sorted(
                [eq for eq in eqs if eq.cells],
                key=lambda e: len(e.cells),
            )
            for i, ei in enumerate(active):
                for ej in itertools.islice(active, i + 1, None):
                    if ei.cells <= ej.cells:
                        ej.cells = ej.cells - ei.cells
                        ej.total = ej.total - ei.total
                        ej.solns = list(
                            {ss - os for os in ei.solns for ss in ej.solns if os <= ss}
                        )
                        reduced = True

    @staticmethod
    def _add_equns_line(
        line: list[frozenset[Cell]],
        cage_of: dict[Cell, frozenset[Cell]],
        total_of: dict[Cell, int],
    ) -> list[tuple[frozenset[Cell], int]]:
        """Sliding-window burb equation derivation along an ordered unit sequence.

        Mirrors Grid.add_equns: for each unit in the sequence, adds the full cage
        for each new cell encountered (accumulating cage totals).  When a unit is
        completely covered, it is subtracted (sum -= 45).  Any non-trivial burb
        residual is recorded as a (cells, total) pair.

        This generates cage-aware sub-sum equations that pure subset-subtraction
        (_reduce_derive) cannot find when cages span multiple units.  For example,
        a cage spanning columns 3-4 prevents col-3 cells from being expressed as a
        pure sub-equation of col 3 via pairwise subtraction, but the sliding window
        handles this naturally by including the whole cage in the cover and later
        cancelling the col-4 portion when col 4 is subtracted.
        """
        equns: list[tuple[frozenset[Cell], int]] = []
        rf = rb = 0
        cvr: set[Cell] = set()
        sm = 0
        while rf < len(line):
            for cell in line[rf] - cvr:
                if cell not in cvr:  # cage may cover multiple cells in this unit
                    cvr |= cage_of[cell]
                    sm += total_of[cell]
            rf += 1
            while rb < len(line) and line[rb] <= cvr:
                cvr -= line[rb]
                sm -= 45
                rb += 1
            rf = max(rf, rb)
            if sm > 0 and cvr:
                fcvr = frozenset(cvr)
                if LinearSystem._is_burb(fcvr):
                    equns.append((fcvr, sm))
        return equns

    def _derive_nonburb_virtual_cages(
        self,
        spec: PuzzleSpec,
        real_cage_cell_sets: set[frozenset[Cell]],
    ) -> None:
        """Derive virtual cages via sliding-window + reduce_equns-style subtraction.

        Builds an initial equation set (rows + cols + boxes + real cages +
        sliding-window burb equations + RREF burb virtual cages) then
        repeatedly subtracts sub-equations from larger ones, carrying solution
        sets through each step.

        Any resulting equation not already in the initial set is appended to
        self.virtual_cages:
          - burb equations → distinct_digits=True, precomp_solns=propagated solns
          - non-burb equations with non-empty must → distinct_digits=False,
            precomp_solns=propagated solns

        The sliding-window step (add_equns-style) seeds additional burb equations
        that RREF misses because multi-unit cages block the subset-subtraction
        chain.  Without it, constraints like "col-3 residual after removing cages
        spanning cols 3-4" are absent, leaving LockedCandidates unable to fire.
        """
        nine_solns = sol_sums(9, 0, 45)  # always [{1,...,9}]

        eqs: list[_DeriveEq] = []

        # Rows, cols, boxes
        rows: list[frozenset[Cell]] = [
            frozenset((r, c) for c in range(9)) for r in range(9)
        ]
        cols: list[frozenset[Cell]] = [
            frozenset((r, c) for r in range(9)) for c in range(9)
        ]
        for row in rows:
            eqs.append(_DeriveEq(row, 45, list(nine_solns)))
        for col in cols:
            eqs.append(_DeriveEq(col, 45, list(nine_solns)))
        for b in range(9):
            r0, c0 = (b // 3) * 3, (b % 3) * 3
            eqs.append(
                _DeriveEq(
                    frozenset((r0 + dr, c0 + dc) for dr in range(3) for dc in range(3)),
                    45,
                    list(nine_solns),
                )
            )

        # Real cage equations from the puzzle spec; build per-cell lookups too
        cage_cells_map: dict[int, list[Cell]] = {}
        cage_totals_map: dict[int, int] = {}
        for r in range(9):
            for c in range(9):
                cid = int(spec.regions[r, c])
                cage_cells_map.setdefault(cid, []).append((r, c))
                v = int(spec.cage_totals[r, c])
                if v != 0:
                    cage_totals_map[cid] = v

        cage_of: dict[Cell, frozenset[Cell]] = {}
        total_of: dict[Cell, int] = {}
        for cid, cells_list in cage_cells_map.items():
            total = cage_totals_map.get(cid, 0)
            if total > 0:
                fc = frozenset(cells_list)
                for cell in cells_list:
                    cage_of[cell] = fc
                    total_of[cell] = total
                eqs.append(
                    _DeriveEq(fc, total, list(sol_sums(len(cells_list), 0, total)))
                )

        # Sliding-window burb equations along rows and cols (both directions).
        # These capture cage-aware sub-sums that _reduce_derive cannot reach when
        # cages span multiple units (mirrors Grid.add_equns on ROWS/COLS/reversed).
        # They are added to virtual_cages immediately (distinct=True, burb by
        # construction) AND to eqs so _reduce_derive can use them as inputs.
        seen_sw: set[frozenset[Cell]] = {eq.cells for eq in eqs}
        for line in [rows, list(reversed(rows)), cols, list(reversed(cols))]:
            for fcvr, sm in self._add_equns_line(line, cage_of, total_of):
                if fcvr not in seen_sw and fcvr not in real_cage_cell_sets:
                    seen_sw.add(fcvr)
                    sw_solns = list(sol_sums(len(fcvr), 0, sm))
                    eqs.append(_DeriveEq(fcvr, sm, sw_solns))
                    self.virtual_cages.append((fcvr, sm, True, None))

        # Burb virtual cages already derived by RREF (distinct_digits=True)
        for vcells, vtotal, distinct, _ in self.virtual_cages:
            if distinct and vcells not in seen_sw:
                seen_sw.add(vcells)
                eqs.append(
                    _DeriveEq(vcells, vtotal, list(sol_sums(len(vcells), 0, vtotal)))
                )

        # Snapshot the initial cell sets before any reductions
        initial_cell_sets: set[frozenset[Cell]] = {eq.cells for eq in eqs}

        self._reduce_derive(eqs)

        seen: set[frozenset[Cell]] = set(initial_cell_sets)
        for eq in eqs:
            if not eq.cells or not eq.solns or eq.cells in seen:
                continue
            distinct = self._is_burb(eq.cells)
            if not distinct:
                must: set[int] = set(eq.solns[0])
                for s in eq.solns[1:]:
                    must &= s
                if not must:
                    continue  # non-burb with no must: no constraint worth propagating
            seen.add(eq.cells)
            self.virtual_cages.append((eq.cells, eq.total, distinct, list(eq.solns)))
