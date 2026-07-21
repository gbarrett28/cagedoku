"""BoardState — all mutable solver state, single mutation point.

BoardState is constructed from a PuzzleSpec and holds:
- candidates[r][c]: set of remaining digit candidates per cell (0-based)
- counts[unit_id][digit]: how many cells in that unit still have digit as candidate
- unit_versions[unit_id]: increments on every candidate removal in that unit
- cage_solns[cage_idx]: list of remaining valid frozenset digit assignments
- units: list of Unit objects (rows 0-8, cols 9-17, boxes 18-26, cages 27+)
- regions[r][c]: 0-based cage index for cell (r, c)

Global unit ID layout:
  rows    0..8
  cols    9..17
  boxes   18..26
  cages   27..27+n_cages-1
  virtual 27+n_cages..
"""

from __future__ import annotations

import dataclasses

import numpy as np
import numpy.typing as npt

from killer_sudoku.solver.engine.linear_system import LinearSystem
from killer_sudoku.solver.engine.types import BoardEvent, Cell, Trigger, Unit, UnitKind
from killer_sudoku.solver.equation import sol_sums
from killer_sudoku.solver.puzzle_spec import PuzzleSpec


class NoSolnError(Exception):
    """Raised when a cell's candidate set would become empty."""


def _box_cells(box: int) -> frozenset[Cell]:
    r0, c0 = (box // 3) * 3, (box % 3) * 3
    return frozenset((r0 + dr, c0 + dc) for dr in range(3) for dc in range(3))


@dataclasses.dataclass
class BoardState:
    """All mutable solver state. Constructed from a validated PuzzleSpec.

    Rules read from this object but must never mutate it directly.
    All mutations go through remove_candidate() or remove_cage_solution().
    """

    spec: PuzzleSpec
    units: list[Unit]
    candidates: list[list[set[int]]]  # [9][9]
    counts: list[list[int]]  # [n_units][10]
    unit_versions: list[int]  # [n_units]
    cage_solns: list[list[frozenset[int]]]  # [n_cages][*]
    regions: npt.NDArray[np.intp]  # (9,9) 0-based cage index
    _cell_unit_ids: list[list[list[int]]]  # [9][9] -> list of unit_ids
    linear_system: LinearSystem

    def __init__(self, spec: PuzzleSpec, *, include_virtual_cages: bool = True) -> None:
        self.spec: PuzzleSpec = spec
        # Convert regions to 0-based
        self.regions = spec.regions - 1
        n_cages = int(self.regions.max()) + 1

        # Build cage cell lists (0-based cage index)
        cage_cells_list: list[list[Cell]] = [[] for _ in range(n_cages)]
        for r in range(9):
            for c in range(9):
                cage_cells_list[int(self.regions[r, c])].append((r, c))

        # Build unit list: rows 0-8, cols 9-17, boxes 18-26, real cages 27..
        self.units: list[Unit] = []
        for r in range(9):
            self.units.append(
                Unit(r, UnitKind.ROW, frozenset((r, c) for c in range(9)))
            )
        for c in range(9):
            self.units.append(
                Unit(9 + c, UnitKind.COL, frozenset((r, c) for r in range(9)))
            )
        for b in range(9):
            self.units.append(Unit(18 + b, UnitKind.BOX, _box_cells(b)))
        for idx, cells in enumerate(cage_cells_list):
            self.units.append(Unit(27 + idx, UnitKind.CAGE, frozenset(cells)))

        # Real cage solutions via sol_sums
        self.cage_solns: list[list[frozenset[int]]] = []
        for cells in cage_cells_list:
            total = 0
            for r, c in cells:
                v = int(spec.cage_totals[r, c])
                if v != 0:
                    total = v
                    break
            self.cage_solns.append(sol_sums(len(cells), 0, total))

        # LinearSystem: build now so virtual_cages are available
        self.linear_system = LinearSystem(spec)

        # Add virtual cage units from the linear system (derived sum equations).
        # Virtual cage unit IDs start at 27 + n_cages and are indexed in
        # cage_solns at offset n_cages (so cage_idx = unit_id - 27 works uniformly).
        # Burb virtual cages (distinct=True, precomp_solns=None): sol_sums is correct.
        # Non-burb virtual cages (distinct=False, precomp_solns=list): use the
        # reduce_equns-propagated solutions directly — sol_sums would wrongly
        # assume digit distinctness for cells spanning multiple units.
        # When include_virtual_cages=False (playing mode without LinearElimination
        # active), skip these so the linear system's derived constraints do not
        # leak into candidate computation via CageIntersection.
        for vcells, vtotal, distinct, precomp_solns in (
            self.linear_system.virtual_cages if include_virtual_cages else []
        ):
            vunit_id = len(self.units)
            self.units.append(Unit(vunit_id, UnitKind.CAGE, vcells, distinct))
            if precomp_solns is not None:
                self.cage_solns.append(precomp_solns)
            else:
                self.cage_solns.append(sol_sums(len(vcells), 0, vtotal))

        n_units = len(self.units)

        # Per-cell unit ID lookup — built after all units (incl. virtual cages)
        self._cell_unit_ids = [[[] for _ in range(9)] for _ in range(9)]
        for unit in self.units:
            for r, c in unit.cells:
                self._cell_unit_ids[r][c].append(unit.unit_id)

        # Candidates: start full
        self.candidates = [[set(range(1, 10)) for _ in range(9)] for _ in range(9)]

        # Counts: each digit appears in all cells of each unit initially
        self.counts = [[0] * 10 for _ in range(n_units)]
        for unit in self.units:
            for d in range(1, 10):
                self.counts[unit.unit_id][d] = len(unit.cells)

        self.unit_versions = [0] * n_units

    # --- Unit ID accessors ---

    def row_unit_id(self, r: int) -> int:
        """Unit ID for row r (0-based)."""
        return r

    def col_unit_id(self, c: int) -> int:
        """Unit ID for column c (0-based)."""
        return 9 + c

    def box_unit_id(self, r: int, c: int) -> int:
        """Unit ID for the 3×3 box containing cell (r, c)."""
        return 18 + (r // 3) * 3 + (c // 3)

    def cage_unit_id(self, r: int, c: int) -> int:
        """Unit ID for the cage containing cell (r, c)."""
        return 27 + int(self.regions[r, c])

    def cell_unit_ids(self, r: int, c: int) -> list[int]:
        """All four unit IDs for cell (r, c): row, col, box, cage."""
        return self._cell_unit_ids[r][c]

    # --- Mutation ---

    def remove_candidate(self, r: int, c: int, d: int) -> list[BoardEvent]:
        """Remove digit d from candidates[r][c]; update counts, versions, emit events.

        This is the single mutation point for candidate sets. It:
        1. Removes d from candidates[r][c]
        2. Decrements counts[unit_id][d] for all units containing (r, c)
        3. Emits COUNT_DECREASED, COUNT_HIT_TWO, COUNT_HIT_ONE as counts change
        4. Emits CELL_DETERMINED if candidates[r][c] becomes a singleton
        5. Prunes cage solutions (real and virtual) that are now impossible
        6. Raises NoSolnError if candidates[r][c] would become empty

        Returns a list of BoardEvent objects for the engine to route.
        """
        cands = self.candidates[r][c]
        if d not in cands:
            return []
        if len(cands) == 1:
            raise NoSolnError(f"Cannot remove last candidate {d} from ({r},{c})")

        cands.discard(d)
        events: list[BoardEvent] = []

        for uid in self.cell_unit_ids(r, c):
            prev = self.counts[uid][d]
            new = prev - 1
            self.counts[uid][d] = new
            self.unit_versions[uid] += 1
            events.append(BoardEvent(Trigger.COUNT_DECREASED, uid, d))
            if new == 2:
                events.append(BoardEvent(Trigger.COUNT_HIT_TWO, uid, d))
            elif new == 1:
                events.append(BoardEvent(Trigger.COUNT_HIT_ONE, uid, d))

        if len(cands) == 1:
            sole = next(iter(cands))
            events.append(BoardEvent(Trigger.CELL_DETERMINED, (r, c), sole))

        # Prune solutions for all cage units containing this cell (real + virtual)
        for uid in self.cell_unit_ids(r, c):
            if self.units[uid].kind == UnitKind.CAGE:
                cage_idx = uid - 27
                events.extend(self._prune_cage_solutions(cage_idx, r, c, d))

        return events

    def remove_cage_solution(
        self, cage_idx: int, solution: frozenset[int]
    ) -> BoardEvent:
        """Remove solution by value from cage_solns[cage_idx]; return SOLUTION_PRUNED.

        Called exclusively by _prune_cage_solutions. Rules must not call this
        directly — all mutations are mediated through remove_candidate.
        """
        self.cage_solns[cage_idx].remove(solution)
        cage_unit_id = 27 + cage_idx
        return BoardEvent(Trigger.SOLUTION_PRUNED, cage_unit_id, None)

    def _prune_cage_solutions(
        self, cage_idx: int, r: int, c: int, d: int
    ) -> list[BoardEvent]:
        """Remove cage solutions impossible given current candidates.

        When digit d has been removed from cell (r, c) in this cage, check
        whether any cage solutions now require d in a cell that no longer
        has d as a candidate. If every cell in the cage lacks d, prune all
        solutions containing d (coarse filter; fine-grained per-cell filtering
        is handled by SolutionMapFilter R4).
        """
        cage_unit = self.units[27 + cage_idx]
        if any(d in self.candidates[cr][cc] for cr, cc in cage_unit.cells):
            return []  # d is still possible somewhere in the cage
        # d is impossible in this cage — remove all solutions containing it
        to_remove = [s for s in self.cage_solns[cage_idx] if d in s]
        return [self.remove_cage_solution(cage_idx, s) for s in to_remove]

    def add_virtual_cage(
        self,
        cells: frozenset[Cell],
        total: int,
        eliminated_solns: list[frozenset[int]],
        *,
        distinct: bool = True,
    ) -> None:
        """Add a user-acknowledged virtual cage as a new cage unit.

        Computes initial solutions via sol_sums, removes eliminated_solns,
        and updates units, cage_solns, counts, unit_versions, and
        _cell_unit_ids to include the new unit.

        Args:
            cells:           0-based (row, col) pairs for the cage cells.
            total:           The cage sum constraint.
            eliminated_solns: Solution sets to exclude from cage_solns.
            distinct:        Whether the cage requires distinct digits (default True).
        """
        vunit_id = len(self.units)
        self.units.append(Unit(vunit_id, UnitKind.CAGE, cells, distinct))

        elim_sets = {frozenset(s) for s in eliminated_solns}
        solns = sol_sums(len(cells), 0, total)
        self.cage_solns.append([s for s in solns if s not in elim_sets])

        counts_row = [0] * 10
        for d in range(1, 10):
            counts_row[d] = sum(1 for r, c in cells if d in self.candidates[r][c])
        self.counts.append(counts_row)
        self.unit_versions.append(0)

        for r, c in cells:
            self._cell_unit_ids[r][c].append(vunit_id)


def validate_solution(bs: BoardState) -> list[str]:
    """Validate a fully-solved board against all killer sudoku rules.

    Returns a list of violation strings (empty if the solution is valid).
    Checks:
    - Every cell is determined (singleton candidate set)
    - Each row, column, and 3×3 box contains each digit 1-9 exactly once
    - Each real cage sums to its declared total and uses distinct digits
    """
    violations: list[str] = []

    # All cells must be determined
    for r in range(9):
        for c in range(9):
            if len(bs.candidates[r][c]) != 1:
                violations.append(
                    f"cell ({r},{c}) not determined: {bs.candidates[r][c]}"
                )

    if violations:
        return violations  # Further checks need singleton candidates

    val = [[next(iter(bs.candidates[r][c])) for c in range(9)] for r in range(9)]

    # Rows
    for r in range(9):
        if sorted(val[r]) != list(range(1, 10)):
            violations.append(f"row {r} invalid: {val[r]}")

    # Columns
    for c in range(9):
        col = [val[r][c] for r in range(9)]
        if sorted(col) != list(range(1, 10)):
            violations.append(f"col {c} invalid: {col}")

    # Boxes
    for b in range(9):
        r0, c0 = (b // 3) * 3, (b % 3) * 3
        box = [val[r0 + dr][c0 + dc] for dr in range(3) for dc in range(3)]
        if sorted(box) != list(range(1, 10)):
            violations.append(f"box {b} invalid: {box}")

    # Real cages: sum and distinct digits
    n_real = int(bs.regions.max()) + 1
    for cage_idx in range(n_real):
        unit = bs.units[27 + cage_idx]
        cage_vals = [val[r][c] for r, c in unit.cells]
        if len(cage_vals) != len(set(cage_vals)):
            violations.append(f"cage {cage_idx} has repeated digits: {cage_vals}")
        # Get declared total from cage_totals
        expected_total = 0
        for r, c in unit.cells:
            t = int(bs.spec.cage_totals[r, c])
            if t != 0:
                expected_total = t
                break
        if expected_total and sum(cage_vals) != expected_total:
            violations.append(
                f"cage {cage_idx} sums to {sum(cage_vals)}, expected {expected_total}"
            )

    return violations


def apply_initial_eliminations(bs: BoardState) -> list[BoardEvent]:
    """Apply LinearSystem initial eliminations and return all fired events.

    Called once after BoardState construction to propagate cells that the
    linear system determined at setup time (e.g. single-cell cages).
    """
    all_events: list[BoardEvent] = []
    for elim in bs.linear_system.initial_eliminations:
        r, c = elim.cell
        if elim.digit in bs.candidates[r][c] and len(bs.candidates[r][c]) > 1:
            all_events.extend(bs.remove_candidate(r, c, elim.digit))
    return all_events
