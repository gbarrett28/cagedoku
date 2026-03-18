"""Grid model for killer sudoku solving.

A Grid holds the full state of a killer sudoku puzzle: the cage structure
(regions and their totals), candidate sets for each cell (sq_poss), and the
set of Equations used to reduce the search space.

The primary entry points are:
  - Grid.__init__  — create an empty grid (optionally inject SolImage)
  - Grid.set_up    — populate cages/regions from image-processing output
  - Grid.solve     — iteratively reduce candidates until no more progress
  - Grid.cheat_solve — fall back to a generic CSP solver (python-constraint)
"""

from __future__ import annotations

import dataclasses
import itertools
from collections.abc import Generator

import numpy as np
import numpy.typing as npt
from constraint import (  # type: ignore[import-untyped]
    AllDifferentConstraint,
    ExactSumConstraint,
    Problem,
)

from killer_sudoku.output.sol_image import SolImage
from killer_sudoku.solver.engine import solve as _engine_solve
from killer_sudoku.solver.engine import validate_solution as _validate_solution
from killer_sudoku.solver.equation import Equation, NoSolnError
from killer_sudoku.solver.puzzle_spec import PuzzleSpec


class ProcessingError(Exception):
    """Raised when image-processing produces an inconsistent cage layout.

    Attributes:
        msg: Human-readable description of the inconsistency.
        regions: The partially-assigned region array at the time of failure.
        brdrs: The border array passed to set_up.
    """

    def __init__(
        self,
        msg: str,
        regions: npt.NDArray[np.intp],
        brdrs: npt.NDArray[np.bool_],
    ) -> None:
        super().__init__(msg)
        self.msg: str = msg
        self.regions: npt.NDArray[np.intp] = regions
        self.brdrs: npt.NDArray[np.bool_] = brdrs


@dataclasses.dataclass(frozen=True)
class GridConfig:
    """Structural configuration for the sudoku grid.

    Attributes:
        grid_size: Number of rows/columns in the grid (standard sudoku: 9).
        box_size: Side length of each 3×3 box (standard sudoku: 3).
        row_sum: Required sum for each row, column, and box (standard: 45).
    """

    grid_size: int = 9
    box_size: int = 3
    row_sum: int = 45


# ---------------------------------------------------------------------------
# Module-level constants — pure computed values, no I/O or side effects
# ---------------------------------------------------------------------------

COLLS: str = "abcdefghi"
ROWLS: str = "123456789"

ROWS: list[set[tuple[int, int]]] = [{(i, j) for j in range(9)} for i in range(9)]
COLS: list[set[tuple[int, int]]] = [{(j, i) for j in range(9)} for i in range(9)]
BOXS: list[set[tuple[int, int]]] = [
    {((3 * (i // 3)) + (j // 3), (3 * (i % 3)) + (j % 3)) for j in range(9)}
    for i in range(9)
]


def _all_boxes_a(
    i: int, s: set[int]
) -> Generator[list[set[tuple[int, int]]], None, None]:
    """Yield every connected subset of boxes that, together with s, covers 9 boxes.

    Recursive helper for _all_boxes(); not intended for direct use.

    Args:
        i: Index of the current box being added.
        s: Set of box indices already committed on this branch.

    Yields:
        Lists of box sets (each element is one BOXS entry) that extend the
        current path to exactly 9 boxes total.
    """
    s.add(i)
    x = i // 3
    y = i % 3
    found_any = False
    candidates: list[int] = []
    if y < 2 and i + 1 not in s:
        candidates.append(i + 1)
    if y > 0 and i - 1 not in s:
        candidates.append(i - 1)
    if x < 2 and i + 3 not in s:
        candidates.append(i + 3)
    if x > 0 and i - 3 not in s:
        candidates.append(i - 3)
    for nb in candidates:
        for sub in _all_boxes_a(nb, s.copy()):
            full = [BOXS[i]] + sub
            if len(full) + len(s) == 9:
                found_any = True
                yield full
    if not found_any:
        yield []


def _all_boxes() -> list[list[set[tuple[int, int]]]]:
    """Return every connected 9-box sequence that tiles the 3×3 meta-grid.

    Used to seed the equation list with sum-45 constraints across arbitrary
    connected box combinations.

    Returns:
        A list of lists; each inner list is a sequence of 9 box sets whose
        union covers all 81 cells.
    """
    ret: list[list[set[tuple[int, int]]]] = []
    for i in range(len(BOXS)):
        ret += [seq for seq in _all_boxes_a(i, set()) if len(seq) != 0]
    return ret


BOX_SEQS: list[list[set[tuple[int, int]]]] = _all_boxes()

VARNS: list[str] = [c + r for r in ROWLS for c in COLLS]
COLNS: list[list[str]] = [[c + r for r in ROWLS] for c in COLLS]
ROWNS: list[list[str]] = [[c + r for c in COLLS] for r in ROWLS]
BOXNS: list[list[str]] = [
    [c + r for c in COLLS[i : i + 3] for r in ROWLS[j : j + 3]]
    for i in range(0, 9, 3)
    for j in range(0, 9, 3)
]

BRDR_MV: list[list[int]] = [[0, -1], [1, 0], [0, 1], [-1, 0]]


# ---------------------------------------------------------------------------
# Grid class
# ---------------------------------------------------------------------------


class Grid:
    """Full killer-sudoku puzzle state: cages, candidates, and equations.

    A Grid is built in two stages:
      1. ``__init__`` — allocates empty arrays; accepts an optional SolImage.
      2. ``set_up``   — populates cage regions and equations from image data.

    After set_up, call ``solve`` to reduce candidates iteratively, or
    ``cheat_solve`` to invoke a generic CSP solver as a fallback.

    Attributes:
        sol_img: Output image renderer; updated as numbers are placed.
        sq_poss: (9, 9) object array; each element is a set[int] of
                 remaining candidate digits for that cell.
        region: (9, 9) integer array mapping each cell to its cage index
                (1-based; 0 means unassigned). Typed as np.intp to satisfy
                the GridLike Protocol consumed by Equation.
        CAGES: List of cage cell-sets, one per distinct region value.
        VALS: Cage totals, parallel to CAGES.
        equns: Active equation list used by the solver.
        DFFS: Difference constraints of the form (cell_a, cell_b, delta)
              meaning sq_poss[cell_a] = {x − delta | x ∈ sq_poss[cell_b]}.
    """

    def __init__(self, sol_img: SolImage | None = None) -> None:
        """Initialise an empty grid, optionally with a pre-built SolImage.

        Args:
            sol_img: Output image renderer.  A default SolImage() is created
                     if None is passed.
        """
        self.sol_img: SolImage = sol_img if sol_img is not None else SolImage()
        self.sq_poss: npt.NDArray[np.object_] = np.array(
            [[set(range(1, 10)) for _ in range(9)] for _ in range(9)],
            dtype=object,
        )
        self.CAGES: list[set[tuple[int, int]]] = []
        self.VALS: list[int] = []
        self.equns: list[Equation] = []
        self.DFFS: set[tuple[tuple[int, int], tuple[int, int], int]] = set()
        self.region: npt.NDArray[np.intp] = np.zeros((9, 9), dtype=np.intp)

    # ------------------------------------------------------------------
    # Row / col / box / cage access helpers
    # ------------------------------------------------------------------

    def get_row(self, i: int, j: int) -> set[tuple[int, int]]:
        """Return the set of cells in the same row as (i, j)."""
        return ROWS[i]

    def get_col(self, i: int, j: int) -> set[tuple[int, int]]:
        """Return the set of cells in the same column as (i, j)."""
        return COLS[j]

    def get_box(self, i: int, j: int) -> set[tuple[int, int]]:
        """Return the set of cells in the same 3×3 box as (i, j)."""
        return BOXS[(3 * (i // 3)) + (j // 3)]

    def get_cge(self, i: int, j: int) -> set[tuple[int, int]]:
        """Return the cage cell-set containing (i, j)."""
        return self.CAGES[int(self.region[i][j]) - 1]

    def get_cge_val(self, i: int, j: int) -> tuple[set[tuple[int, int]], int]:
        """Return the (cage cell-set, cage total) for the cage containing (i, j)."""
        idx = self.region[i][j] - 1
        return self.CAGES[idx], self.VALS[idx]

    def is_burb(self, cvr: set[tuple[int, int]], i: int, j: int) -> bool:
        """Return True if cvr is a subset of any sudoku group containing (i, j).

        A cell set is a "burb" (sub-unit region belonging) if it fits entirely
        within a row, column, box, or cage.  Only burb equations are added to
        the constraint list.

        Args:
            cvr: Set of cells to test.
            i: Row index of any representative cell in cvr.
            j: Column index of that cell.
        """
        return (
            cvr <= self.get_row(i, j)
            or cvr <= self.get_col(i, j)
            or cvr <= self.get_box(i, j)
            or cvr <= self.get_cge(i, j)
        )

    # ------------------------------------------------------------------
    # Equation generation
    # ------------------------------------------------------------------

    def add_equns(self, line: list[set[tuple[int, int]]]) -> list[Equation]:
        """Derive sum equations by sliding a window along a sequence of groups.

        Scans line (a sequence of rows or columns) with a two-pointer
        approach: grow the covered set forward until an equation boundary is
        found, then shrink from the back.  Every non-trivial burb sub-sum is
        recorded as an Equation.

        Also records single-cell difference constraints (DFFS) where exactly
        one cell separates two overlapping covers.

        Args:
            line: Ordered list of cell sets (typically ROWS or COLS).

        Returns:
            List of Equation objects derived from the sliding window.
        """
        equns: list[Equation] = []
        rf = 0
        rb = 0
        cvr: set[tuple[int, int]] = set()
        sm = 0
        while rf < len(line):
            lmc = line[rf] - cvr
            cml = cvr - line[rf]
            if len(lmc) == 1 and len(cml) == 1:
                self.DFFS.add((lmc.copy().pop(), cml.copy().pop(), sm - 45))
            for i, j in lmc:
                if (i, j) not in cvr:
                    c, v = self.get_cge_val(i, j)
                    cvr |= c
                    sm += v
            assert sm >= 45
            rf += 1
            while rb < len(line) and line[rb] <= cvr:
                cvr -= line[rb]
                sm -= 45
                assert sm >= 0
                assert (sm == 0) == (cvr == set()), f"sm={sm}, cvr={cvr}"
                rb += 1
            rf = max(rf, rb)
            if sm != 0:
                i, j = cvr.copy().pop()
                if self.is_burb(cvr, i, j):
                    equns.append(Equation(cvr, sm, self))
        return equns

    def add_equns_r(
        self,
        box: int,
        cvr: set[tuple[int, int]],
        sm: int = 0,
        seen: set[int] | None = None,
    ) -> list[Equation]:
        """Derive equations by expanding cover recursively through adjacent boxes.

        Starting from a single box, accumulates cages into a covered set and
        subtracts completed boxes (sum 45 each).  Records any resulting
        burb equation and recurses into neighbouring boxes that overlap the cover.

        Args:
            box: Index of the box to start/continue from.
            cvr: Current set of covered cells (modified in-place per branch).
            sm: Running sum of cage totals minus completed box sums.
            seen: Set of box indices already processed on this branch.

        Returns:
            List of Equation objects found on this branch and its descendants.
        """
        if seen is None:
            seen = set()
        equns: list[Equation] = []
        for i, j in BOXS[box]:
            if (i, j) not in cvr:
                c, v = self.get_cge_val(i, j)
                cvr |= c
                sm += v
        for b in set(range(len(BOXS))) - seen:
            if BOXS[b] <= cvr:
                assert sm >= 45, f"sum={sm} box={b} cover={cvr}"
                seen.add(b)
                sm -= 45
                cvr -= BOXS[b]
        if sm != 0:
            assert cvr != set(), f"sum={sm}"
            i, j = cvr.copy().pop()
            if self.is_burb(cvr, i, j):
                equns.append(Equation(cvr, sm, self))
        bi, bj = box // 3, box % 3
        for di, dj in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            ni, nj = (bi + di, bj + dj)
            nb = (3 * ni) + nj
            if 0 <= ni < 3 and 0 <= nj < 3:
                if nb not in seen and not BOXS[nb].isdisjoint(cvr):
                    equns += self.add_equns_r(
                        box=nb, cvr=cvr.copy(), sm=sm, seen=seen.copy()
                    )
        return equns

    # ------------------------------------------------------------------
    # Grid setup
    # ------------------------------------------------------------------

    def set_up(self, spec: PuzzleSpec) -> None:
        """Populate cage structure and equations from a validated PuzzleSpec.

        Takes the pre-validated PuzzleSpec produced by validate_cage_layout:
        cage regions have already been flood-filled and all consistency checks
        have been applied. This method renders the borders and cage totals onto
        the solution image, then builds the equation list for solving.

        Args:
            spec: Validated puzzle specification from validate_cage_layout.
        """
        brdrs = spec.brdrs
        self.sol_img.draw_borders(brdrs)
        self.region = spec.regions.copy()
        for i in range(9):
            for j in range(9):
                if spec.cage_totals[i][j] != 0:
                    self.sol_img.draw_sum(i, j, int(spec.cage_totals[i][j]))
        self.CAGES = [set() for _ in np.unique(self.region)]
        self.VALS = [0 for _ in np.unique(self.region)]
        for i in range(9):
            for j in range(9):
                idx = int(self.region[i][j]) - 1
                self.CAGES[idx].add((i, j))
                self.VALS[idx] = max(self.VALS[idx], int(spec.cage_totals[i][j]))
        self.equns = [Equation(s, 45, self) for s in ROWS + COLS + BOXS]
        self.equns += [
            Equation(s, v, self) for s, v in zip(self.CAGES, self.VALS, strict=False)
        ]
        self.DFFS = set()
        self.equns += self.add_equns(ROWS)
        self.equns += self.add_equns(COLS)
        self.equns += self.add_equns(ROWS[::-1])
        self.equns += self.add_equns(COLS[::-1])
        for b in range(len(BOXS)):
            self.equns += self.add_equns_r(box=b, cvr=set())

    # ------------------------------------------------------------------
    # Candidate-set manipulation
    # ------------------------------------------------------------------

    def discard_n(self, i: int, j: int, n: int) -> bool:
        """Remove digit n from every peer of cell (i, j).

        Peers are all cells sharing the same row, column, 3×3 box, or cage.
        Does not modify sq_poss[i][j] itself.

        Args:
            i: Row index of the placed cell.
            j: Column index of the placed cell.
            n: Digit that has been placed in (i, j).

        Returns:
            True if any peer's candidate set was reduced.
        """
        reduced = False
        for k in range(9):
            if i != k:
                reduced |= n in self.sq_poss[k][j]
                self.sq_poss[k][j].discard(n)
            if j != k:
                reduced |= n in self.sq_poss[i][k]
                self.sq_poss[i][k].discard(n)
            x = (3 * (i // 3)) + (k // 3)
            y = (3 * (j // 3)) + (k % 3)
            if i != x or j != y:
                reduced |= n in self.sq_poss[x][y]
                self.sq_poss[x][y].discard(n)
        rgn = self.get_cge(i, j)
        for x, y in rgn:
            if (i, j) != (x, y):
                reduced |= n in self.sq_poss[x][y]
                self.sq_poss[x][y].discard(n)
        return reduced

    def elim_must(self) -> bool:
        """Eliminate candidates using must-contain constraints across equation pairs.

        For each pair of equations (ei, ej) whose cell sets overlap, any digit
        that ei requires but that cannot appear in ei's exclusive cells must
        not appear in ej's exclusive cells.

        Also applies difference constraints from DFFS.

        Returns:
            True if any candidate set was reduced (triggers another pass in
            the solve loop).
        """
        reduced = False
        univ: set[int] = set(range(1, 10))
        loads: list[tuple[set[tuple[int, int]], set[int]]] = (
            [(e.s, e.must) for e in self.equns]
            + [(s, univ) for s in COLS + ROWS + BOXS]
            + [(s, set()) for s in self.CAGES]
        )
        for i, (si, mi) in enumerate(loads):
            for j, (sj, _mj) in enumerate(loads):
                sij = si & sj
                if i != j and sij != set():
                    elsewhere: set[int] = set()
                    for x, y in si - sj:
                        elsewhere |= self.sq_poss[x][y]
                    sij_must = mi - elsewhere
                    for x, y in sj - si:
                        reduced |= not self.sq_poss[x][y].isdisjoint(sij_must)
                        self.sq_poss[x][y] -= sij_must
        for (pi, pj), (qi, qj), delta in self.DFFS:
            na = self.sq_poss[pi][pj] & {
                m - delta for m in self.sq_poss[qi][qj] if 1 <= m - delta <= 9
            }
            self.sq_poss[pi][pj] = na
            self.sq_poss[qi][qj] = {m + delta for m in na}
        return reduced

    # ------------------------------------------------------------------
    # Solution mapping
    # ------------------------------------------------------------------

    def sol_maps(
        self,
        ps: set[tuple[int, int]],
        vs: frozenset[int],
    ) -> list[set[tuple[int, int, int]]]:
        """Enumerate all consistent assignments of digits vs to cells ps.

        Recursively assigns digits from vs to cells in ps (sorted by fewest
        candidates first) and returns every assignment consistent with
        sq_poss.

        Args:
            ps: Cells to assign.
            vs: Multiset (frozenset) of available digits.

        Returns:
            A list of assignment sets; each element is a set of (row, col, digit)
            triples covering all cells in ps.
        """
        assert len(ps) == len(vs)
        sqs = sorted(ps, key=lambda p: len(self.sq_poss[p[0]][p[1]]))
        sqi, sqj = sqs[0]
        if len(sqs) == 1:
            v = next(iter(vs))
            return [{(sqi, sqj, v)}] if v in self.sq_poss[sqi][sqj] else []
        solns: list[set[tuple[int, int, int]]] = []
        for v in self.sq_poss[sqi][sqj] & vs:
            subsols = self.sol_maps(ps - {(sqi, sqj)}, vs - {v})
            solns += [{(sqi, sqj, v)} | m for m in subsols]
        return solns

    # ------------------------------------------------------------------
    # Equation reduction
    # ------------------------------------------------------------------

    def reduce_equns(self, equns: list[Equation]) -> list[Equation]:
        """Simplify equations by subtracting sub-equations.

        Repeatedly scans the equation list: whenever equation ei is a subset
        of ej (ei.s ⊆ ej.s), subtracts ei from ej.  Repeats until no further
        reduction is possible.

        Args:
            equns: Initial equation list (modified in-place via difference_update).

        Returns:
            Reduced, sorted list of non-trivial equations.
        """
        reduced = True
        while reduced:
            reduced = False
            equns = sorted(
                [e for e in equns if e.s != set()],
                key=lambda e: len(e.s),
            )
            for i, ei in enumerate(equns):
                for ej in itertools.islice(equns, i + 1, None):
                    if ei <= ej:
                        ej.difference_update(ei)
                        reduced = True
        return equns

    # ------------------------------------------------------------------
    # Solver
    # ------------------------------------------------------------------

    def solve(self) -> tuple[int, int]:
        """Iteratively reduce candidate sets until no further progress is made.

        Applies equation reduction, candidate intersection, single-candidate
        placement, hidden singles/pairs in rows/cols/boxes, and equation
        solution filtering.

        Returns:
            (alts_sum, solns_sum) — the total number of remaining candidates
            and the weighted solution count across all equations.  Both are
            zero if the puzzle is fully solved.

        Raises:
            NoSolnError: If the candidate or solution counts increase during
                         an iteration, indicating an inconsistency.
        """
        self.equns = self.reduce_equns(self.equns)
        self.sq_poss = np.array(
            [[set(range(1, 10)) for _ in range(9)] for _ in range(9)],
            dtype=object,
        )
        for e in self.equns:
            for i, j in e.s:
                self.sq_poss[i][j] &= e.poss
        reduced = True
        while reduced:
            reduced = self.elim_must()
        for i in range(9):
            for j in range(9):
                if len(self.sq_poss[i][j]) == 1:
                    n = next(iter(self.sq_poss[i][j]))
                    self.sol_img.draw_number(n, i, j)
                    self.discard_n(i, j, n)
        alts_sum: int = int(
            np.sum([np.sum([len(s) for s in col]) for col in self.sq_poss])
        )
        solns_sum: int = int(np.sum([len(e.solns) << len(e.s) for e in self.equns]))
        while True:
            new_equns: list[Equation] = []
            for e in self.equns:
                sm: list[set[tuple[int, int, int]]] = []
                sf: list[bool] = []
                for sl in e.solns:
                    assert len(e.s) == len(sl), f"{e.s}\n{sl}"
                    sma = self.sol_maps(e.s, sl.copy())
                    sf.append(len(sma) != 0)
                    sm += sma
                e.solns = [s for s, b in zip(e.solns, sf, strict=False) if b]
                e.calc_mp()
                new_sq_poss: list[list[set[int]]] = [
                    [set() for _ in range(9)] for _ in range(9)
                ]
                for mapping in sm:
                    for ci, cj, v in mapping:
                        new_sq_poss[ci][cj].add(v)
                for i, j in e.s:
                    self.sq_poss[i][j] &= new_sq_poss[i][j]
                    if len(self.sq_poss[i][j]) == 1:
                        n = next(iter(self.sq_poss[i][j]))
                        self.sol_img.draw_number(n, i, j)
                        self.discard_n(i, j, n)
                        new_equns.append(Equation({(i, j)}, n, self))
            for u in ROWS + COLS + BOXS:
                lu: npt.NDArray[np.intp] = np.array(list(u), dtype=np.intp)
                grid_arr: npt.NDArray[np.bool_] = np.array(
                    [
                        [num in self.sq_poss[int(ci)][int(cj)] for ci, cj in lu]
                        for num in range(1, 10)
                    ],
                    dtype=bool,
                )
                for num in range(9):
                    if np.sum(grid_arr[num, :]) == 1:
                        sq = grid_arr[num, :] == 1
                        grid_arr[:, sq] = False
                        grid_arr[num, sq] = True
                        for ci, cj in lu[sq]:
                            self.sq_poss[int(ci)][int(cj)] = {num + 1}
                            new_equns.append(
                                Equation({(int(ci), int(cj))}, num + 1, self)
                            )
                twos = [
                    (num, grid_arr[num, :])
                    for num in range(9)
                    if np.sum(grid_arr[num, :]) == 2
                ]
                for idx_i, (numi, gridi) in enumerate(twos):
                    for numj, gridj in itertools.islice(twos, idx_i):
                        if (gridi == gridj).all():
                            equn_vars: list[tuple[int, int]] = []
                            for ci, cj in lu[gridi == 1]:
                                self.sq_poss[int(ci)][int(cj)] = {
                                    numi + 1,
                                    numj + 1,
                                }
                                equn_vars.append((int(ci), int(cj)))
                            new_equns.append(
                                Equation(set(equn_vars), numi + numj + 2, self)
                            )
            if new_equns:
                self.equns = self.reduce_equns(new_equns + self.equns)
            reduceda = True
            while reduceda:
                reduceda = self.elim_must()
            old_alts_sum = alts_sum
            alts_sum = int(
                np.sum([np.sum([len(s) for s in col]) for col in self.sq_poss])
            )
            if alts_sum > old_alts_sum:
                raise NoSolnError(
                    f"candidate count increased: {old_alts_sum} -> {alts_sum}"
                )
            old_solns_sum = solns_sum
            solns_sum = int(np.sum([len(e.solns) << len(e.s) for e in self.equns]))
            if solns_sum > old_solns_sum:
                raise NoSolnError(
                    f"solution count increased: {old_solns_sum} -> {solns_sum}"
                )
            if alts_sum == old_alts_sum and solns_sum == old_solns_sum:
                break
        return alts_sum, solns_sum

    def engine_solve(self) -> tuple[int, int]:
        """Solve using the new SolverEngine.

        Builds a PuzzleSpec from the current cage layout (regions + VALS),
        runs the trigger-driven propagation engine, then synchronises sq_poss
        with the engine's final candidates and draws determined digits.

        Returns:
            (alts_sum, solns_sum) matching the existing solve() contract.
            solns_sum is always 0 — the engine fully resolves or leaves
            residual candidates without a weighted solution count.
        """
        cage_totals = np.zeros((9, 9), dtype=np.intp)
        for cage_cells, val in zip(self.CAGES, self.VALS, strict=False):
            head = min(cage_cells)
            cage_totals[head[0], head[1]] = val

        spec = PuzzleSpec(
            regions=self.region.copy(),
            cage_totals=cage_totals,
            border_x=np.zeros((9, 8), dtype=bool),
            border_y=np.zeros((8, 9), dtype=bool),
        )
        board = _engine_solve(spec)

        for r in range(9):
            for c in range(9):
                self.sq_poss[r][c] = set(board.candidates[r][c])
                if len(self.sq_poss[r][c]) == 1:
                    n = next(iter(self.sq_poss[r][c]))
                    self.sol_img.draw_number(n, r, c)

        alts_sum = int(sum(len(self.sq_poss[r][c]) for r in range(9) for c in range(9)))

        # Validate whenever the engine claims to have fully solved the puzzle.
        # An inconsistent solution indicates a rule made an incorrect deduction.
        if alts_sum == 81:
            violations = _validate_solution(board)
            if violations:
                raise AssertionError(
                    f"engine_solve produced an inconsistent solution: {violations[:3]}"
                )

        return alts_sum, 0

    # ------------------------------------------------------------------
    # CSP fallback
    # ------------------------------------------------------------------

    def cheat_solve(self) -> None:
        """Solve using a generic CSP solver (python-constraint) as a fallback.

        Constructs a constraint-satisfaction problem with AllDifferent and
        ExactSum constraints for all rows, columns, boxes, and cages, then
        extracts the solution and records it in sq_poss and sol_img.

        This method is called when the iterative solver in ``solve`` cannot
        make further progress.
        """
        cagns = [self._make_vars(vs) for vs in self.CAGES]
        ks: Problem = Problem()
        for v in VARNS:
            ks.addVariable(v, range(1, 10))
        for vs in COLNS + ROWNS + BOXNS + cagns:
            ks.addConstraint(AllDifferentConstraint(), vs)
        for cage_val, cage_vars in zip(self.VALS, cagns, strict=False):
            ks.addConstraint(ExactSumConstraint(cage_val), cage_vars)
        for vs in COLNS + ROWNS + BOXNS:
            ks.addConstraint(ExactSumConstraint(45), vs)
        s = ks.getSolution()
        for i in range(9):
            for j in range(9):
                digit = s[COLNS[i][j]]
                self.sq_poss[i][j] = {digit}
                self.sol_img.draw_number(digit, i, j)

    @staticmethod
    def _make_vars(vs: set[tuple[int, int]]) -> list[str]:
        """Convert a set of (row, col) pairs to a list of variable name strings.

        The CSP solver uses string variable names of the form column-letter +
        row-digit (e.g. 'a1', 'b3').

        Args:
            vs: Set of (row, col) cell coordinates.

        Returns:
            List of variable name strings, one per cell.
        """
        return [COLLS[i] + ROWLS[j] for i, j in vs]
