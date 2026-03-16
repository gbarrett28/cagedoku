"""Equation model for killer sudoku cages.

An Equation represents a single killer sudoku cage: a set of cells whose
digits must be distinct and sum to a given total. It pre-computes all valid
digit assignments (solutions) and derives which digits must or can appear.
"""

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from killer_sudoku.solver.types import GridLike


class NoSolnError(Exception):
    """Raised when a constraint eliminates all remaining solutions."""


@dataclass(frozen=True)
class EquationConfig:
    """Configuration for digit range used by the equation solver.

    Attributes:
        min_digit: Lowest permitted digit (inclusive). Standard sudoku: 1.
        max_digit: Highest permitted digit (inclusive). Standard sudoku: 9.
    """

    min_digit: int = 1
    max_digit: int = 9


# Module-level singleton for the standard sudoku digit range.
_DEFAULT_CONFIG: EquationConfig = EquationConfig()


def sol_sums(
    n: int, m: int, v: int, cfg: EquationConfig = _DEFAULT_CONFIG
) -> list[frozenset[int]]:
    """Return all sets of n distinct digits (each > m) that sum to v.

    Digits are drawn from cfg.min_digit..cfg.max_digit without repetition.
    The result is used by Equation.solve() to enumerate valid cage assignments.

    Args:
        n: Number of digits required in each solution.
        m: Lower bound — only digits strictly greater than m are considered.
           Pass cfg.min_digit - 1 (i.e. 0) for an unconstrained first call.
        v: Target sum.
        cfg: Digit-range configuration; defaults to standard sudoku (1–9).

    Returns:
        A list of frozensets, each containing exactly n distinct digits that
        sum to v. Returns an empty list when no valid assignment exists.
    """
    # Compute the tightest possible sum range for n digits starting above m.
    # sq accounts for the forced gap between consecutive distinct digits.
    sq = (n * (n - 1)) // 2
    lo = (n * (m + 1)) + sq
    hi = (n * cfg.max_digit) - sq
    if not (lo <= v <= hi):
        return []
    if n == 1:
        return [frozenset({v})]

    solns: list[frozenset[int]] = []
    for i in range(m + 1, min(cfg.max_digit + 1, v)):
        solns += [s | frozenset({i}) for s in sol_sums(n - 1, i, v - i, cfg)]
    return solns


class Equation:
    """A killer sudoku cage: a set of cells that must sum to a target value.

    On construction the equation enumerates all valid digit assignments
    (solutions), then derives:
      - must: digits that appear in every solution
      - poss: digits that appear in at least one solution
      - col / row / box / rgn: sudoku groups that intersect this cage

    Attributes:
        s: Set of (row, col) cell coordinates belonging to this cage.
        v: Target sum for the cage.
        region: Grid region array (shared reference from the parent Grid).
        solns: All valid digit assignments, each as a frozenset of ints.
        must: Digits that must appear in every valid assignment.
        poss: Digits that appear in at least one valid assignment.
        col: Column indices intersected by this cage.
        row: Row indices intersected by this cage.
        box: 3x3-box indices (0–8) intersected by this cage.
        rgn: Cage/region indices intersected by this cage.
    """

    def __init__(self, s: set[tuple[int, int]], v: int, grid: GridLike) -> None:
        """Initialise the equation from a cell set, target sum, and grid.

        Args:
            s: Non-empty set of (row, col) coordinates for the cage cells.
            v: The cage total that the digits must sum to.
            grid: Any object exposing a ``region`` NDArray (satisfies GridLike).

        Raises:
            ValueError: If ``s`` is empty.
            ValueError: If sol_sums produces a solution whose size disagrees
                with the number of cells (indicates an algorithmic bug).
        """
        if not s:
            raise ValueError("Equation must have at least one cell")
        self.region: npt.NDArray[np.intp] = grid.region
        self.s: set[tuple[int, int]] = s.copy()
        self.v: int = v
        # These are set by calc_mp / set_crbr called below; declare here so
        # mypy sees them as instance attributes rather than possibly-unbound.
        self.solns: list[frozenset[int]] = []
        self.must: set[int] = set()
        self.poss: set[int] = set()
        self.col: set[int] = set()
        self.row: set[int] = set()
        self.box: set[int] = set()
        self.rgn: set[int] = set()
        self.solve()
        self.calc_mp()
        self.set_crbr()

    def set_crbr(self) -> None:
        """Compute which columns, rows, 3x3 boxes, and regions overlap this cage.

        Iterates over every cell coordinate in self.s and populates
        self.col, self.row, self.box, and self.rgn accordingly.
        """
        self.col = set()
        self.row = set()
        self.box = set()
        self.rgn = set()
        for i, j in self.s:
            self.col.add(j)
            self.row.add(i)
            # Box index: top-left corner of the 3x3 block, flattened to 0-8
            self.box.add((3 * (i // 3)) + (j // 3))
            self.rgn.add(int(self.region[i][j]) - 1)

    def __le__(self, other: "Equation") -> bool:
        """Return True if this cage's cells are a subset of other's cells."""
        return self.s <= other.s

    def difference_update(self, other: "Equation") -> None:
        """Remove another cage's cells and value from this cage in-place.

        Used when a sub-cage has been resolved: its cells and digit-sum are
        subtracted from this cage, and the solution space is filtered to only
        those assignments consistent with the resolved sub-cage.

        Args:
            other: A cage whose cells are a subset of this cage's cells and
                   whose solutions have already been determined.
        """
        self.s -= other.s
        self.v -= other.v
        self.set_crbr()
        if self.s:
            # Keep only assignments that extend one of other's solutions
            new_solns: list[frozenset[int]] = [
                ss - os for os in other.solns for ss in self.solns if os <= ss
            ]
            self.solns = new_solns
        else:
            # All cells removed — cage is fully resolved; one trivial solution
            self.solns = [frozenset()]
        self.calc_mp()

    def show(self) -> str:
        """Return a human-readable description of the cage for debugging."""
        return " + ".join(str(n) for n in self.s) + " = " + str(self.v)

    def calc_mp(self) -> None:
        """Recompute must and poss from the current solution list.

        must: digits common to every solution (intersection).
        poss: digits that appear in at least one solution (union).
        When solns is empty, must retains the full digit range (no constraint
        can be inferred) and poss is empty.
        """
        self.must = set(range(1, 10))
        self.poss = set()
        for soln in self.solns:
            self.poss |= soln
            self.must &= soln

    def solve(self) -> None:
        """Populate self.solns with all valid digit assignments for this cage.

        Calls sol_sums to enumerate assignments, then validates that each
        returned set has the expected number of digits.

        Raises:
            ValueError: If any returned solution has the wrong number of digits,
                which would indicate a bug in sol_sums.
        """
        self.solns = sol_sums(len(self.s), 0, self.v)
        for sol in self.solns:
            if len(sol) != len(self.s):
                raise ValueError(
                    f"sol_sums returned a solution with {len(sol)} digits "
                    f"but cage has {len(self.s)} cells"
                )
        self.calc_mp()

    def avoid(self, a: set[int]) -> bool:
        """Eliminate solutions that intersect the forbidden digit set a.

        Filters self.solns to only those assignments that are disjoint from a
        (i.e. do not use any digit in a), then recomputes must/poss.

        Args:
            a: Set of digits to exclude from all remaining solutions.

        Returns:
            True if at least one solution was eliminated (the caller may need
            to propagate the new constraint). False if all solutions were
            already disjoint from a.

        Raises:
            NoSolnError: If every remaining solution intersects a, leaving no
                valid assignment for this cage.
        """
        disjoint = np.array([soln.isdisjoint(a) for soln in self.solns])
        if not disjoint.any():
            raise NoSolnError("No solutions remain after applying avoid constraint")
        self.solns = list(np.array(self.solns, dtype=object)[disjoint])
        self.calc_mp()
        # Return True when some solutions were eliminated (constraint was useful)
        return not bool(disjoint.all())
