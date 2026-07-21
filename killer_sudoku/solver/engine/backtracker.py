"""MRV backtracker fallback for the solver engine.

Called when the rule-based engine stalls and cannot make further progress.
Applies MRV (Minimum Remaining Values) cell ordering with forward checking
(peer-elimination propagation + naked-single cascade) to efficiently search
for a solution.

Supports both classic sudoku (row/col/box constraints only) and killer sudoku
(row/col/box + cage sum constraints).
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from killer_sudoku.solver.engine.board_state import BoardState

Cell = tuple[int, int]

# Precomputed peer sets: peers[r][c] = frozenset of all cells sharing a row,
# column, or 3x3 box with (r, c), excluding (r, c) itself.
# This is pure constant data computed once at import time.
_PEERS: list[list[frozenset[Cell]]] = [
    [
        frozenset(
            {(r, c2) for c2 in range(9) if c2 != c}
            | {(r2, c) for r2 in range(9) if r2 != r}
            | {
                ((r // 3) * 3 + dr, (c // 3) * 3 + dc)
                for dr in range(3)
                for dc in range(3)
                if ((r // 3) * 3 + dr, (c // 3) * 3 + dc) != (r, c)
            }
        )
        for c in range(9)
    ]
    for r in range(9)
]


def mrv_backtrack(board: BoardState) -> npt.NDArray[np.intp] | None:
    """Find a solution via MRV backtracking from a partially-solved BoardState.

    Extracts cage constraints from the board spec, copies the current candidate
    sets, and searches for a valid completion.  Forward checking (peer-constraint
    propagation + naked-single cascade on each assignment) keeps the branching
    factor small.

    Args:
        board: A BoardState that the rule engine was unable to fully solve.

    Returns:
        A (9, 9) array of digits 1-9 for the unique solution, or None if no
        valid completion exists (puzzle unsolvable from this candidate state).
    """
    cage_of = [[0] * 9 for _ in range(9)]
    cage_total: dict[int, int] = {}
    cage_cells: dict[int, list[Cell]] = {}

    for r in range(9):
        for c in range(9):
            cid = int(board.spec.regions[r, c])  # 1-based cage id
            cage_of[r][c] = cid
            cage_cells.setdefault(cid, []).append((r, c))
            t = int(board.spec.cage_totals[r, c])
            if t != 0:
                cage_total[cid] = t

    cands: list[list[set[int]]] = [
        [set(board.candidates[r][c]) for c in range(9)] for r in range(9)
    ]

    grid = _search(cands, cage_of, cage_total, cage_cells)
    if grid is None:
        return None
    return np.array(grid, dtype=np.intp)


def _peers_of(r: int, c: int) -> frozenset[Cell]:
    return _PEERS[r][c]


def _cage_valid(
    cands: list[list[set[int]]],
    cid: int,
    cage_total: dict[int, int],
    cage_cells: dict[int, list[Cell]],
) -> bool:
    """Return False if the cage constraint is provably violated."""
    total = cage_total.get(cid)
    if total is None:
        return True

    cells = cage_cells[cid]
    placed_sum = 0
    remaining = 0
    for r2, c2 in cells:
        s = cands[r2][c2]
        if not s:
            return False
        if len(s) == 1:
            placed_sum += next(iter(s))
        else:
            remaining += 1

    if placed_sum > total:
        return False
    if remaining == 0:
        return placed_sum == total

    # Check that the remaining cells could still sum to (total - placed_sum).
    needed = total - placed_sum
    min_fill = sum(range(1, remaining + 1))  # 1 + 2 + ... + remaining
    max_fill = sum(range(10 - remaining, 10))  # (10-remaining) + ... + 9
    return min_fill <= needed <= max_fill


def _assign(
    cands: list[list[set[int]]],
    r: int,
    c: int,
    d: int,
    cage_of: list[list[int]],
    cage_total: dict[int, int],
    cage_cells: dict[int, list[Cell]],
) -> bool:
    """Place digit d at (r, c), propagate, and validate.

    Runs peer-elimination with naked-single cascade until quiescent.
    Validates cage-sum constraints after each placement.

    Returns False on contradiction (empty candidate set or violated cage sum).
    """
    cands[r][c] = {d}
    queue: list[tuple[int, int, int]] = [(r, c, d)]

    while queue:
        r0, c0, d0 = queue.pop()

        # Validate the cage of the placed cell.
        if not _cage_valid(cands, cage_of[r0][c0], cage_total, cage_cells):
            return False

        # Eliminate d0 from all peers, cascade naked singles.
        for r2, c2 in _peers_of(r0, c0):
            s = cands[r2][c2]
            if d0 not in s:
                continue
            s.discard(d0)
            if not s:
                return False
            if len(s) == 1:
                d_new = next(iter(s))
                queue.append((r2, c2, d_new))
                # Validate the cage of the newly placed cell.
                if not _cage_valid(cands, cage_of[r2][c2], cage_total, cage_cells):
                    return False

    return True


def _search(
    cands: list[list[set[int]]],
    cage_of: list[list[int]],
    cage_total: dict[int, int],
    cage_cells: dict[int, list[Cell]],
) -> list[list[int]] | None:
    """Recursive MRV search.  Returns a solved 9x9 grid or None on failure."""
    # MRV: find the unsolved cell with fewest candidates.
    min_count = 10
    best: Cell | None = None
    for r in range(9):
        for c in range(9):
            n = len(cands[r][c])
            if n == 0:
                return None
            if 1 < n < min_count:
                min_count = n
                best = (r, c)

    if best is None:
        # Every cell is determined — puzzle solved.
        return [[next(iter(cands[r][c])) for c in range(9)] for r in range(9)]

    r, c = best
    for d in sorted(cands[r][c]):
        # Deep-copy candidate sets for this branch.
        new_cands: list[list[set[int]]] = [[set(s) for s in row] for row in cands]
        if _assign(new_cands, r, c, d, cage_of, cage_total, cage_cells):
            result = _search(new_cands, cage_of, cage_total, cage_cells)
            if result is not None:
                return result

    return None  # All candidates exhausted — backtrack.
