"""R12 UnitPartitionFilter â cross-cage compatibility within a complete unit partition.

When all cells of a row, column, or box are covered by a disjoint set of
sub-cages (real or virtual), the digit assignments across those cages must
form a valid permutation of {1..9}.  Any cage solution that cannot participate
in any valid cross-cage combination is eliminated.

Elimination proceeds in two phases:

  Phase 1 â cage-set DFS: find which digit *sets* are valid for each partition
  cage, using constraint propagation (fixing one cage's digit set immediately
  filters conflicting solutions from remaining cages).  Forced singletons
  propagate for free; genuine branch points consume a node from the budget.
  When the budget is exhausted remaining branches are treated conservatively
  (potentially valid) so no correct solution is ever discarded.

  Phase 2 â cell-level expansion: for each valid digit-set combination, enumerate
  all assignments of those digits to the specific cells within each cage, filtered
  by cell candidates.  Non-partition cages that lie entirely within the unit but
  span multiple partition cages (cross-cages, e.g. virtual cages derived by the
  linear system) impose additional sum constraints on these cell assignments.
  Only (cell, digit) pairs that survive at least one valid complete cell
  assignment are kept.

Example: box (rows 0-2, cols 6-8) partitioned by D={r0c6,r1c6,r2c6}=22,
E={r0c7,r0c8}=11, H={r1c7,r1c8}=5, J={r2c7,r2c8}=7.  Phase 1 finds 2 valid
cage-set combinations.  The virtual cross-cage {r0c8,r1c8,r2c8}=12 â derived
from the column total minus P and V â has cells spanning E, H and J.  Phase 2
finds exactly one valid cell assignment per combination consistent with this
cross-cage sum, pinning each cell in E, H and J to at most 2 candidate digits
and propagating strongly into the column cages below.

Only cages whose cells lie entirely within the unit are considered.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

import itertools

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind

# Maximum number of DFS branch nodes to explore per partition (Phase 1).
# A node is counted each time we pick a solution for a cage that still has
# two or more valid choices (forced singletons propagate for free).
# When the budget runs out the current branch is treated as potentially valid
# (conservative: never discard a correct solution).
_MAX_NODES = 200


class UnitPartitionFilter:
    """R12: cross-cage compatibility filter for completely partitioned units."""

    name = "UnitPartitionFilter"
    priority = 12
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()  # GLOBAL

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Scan units; eliminate candidates incompatible with any valid assignment."""
        board = ctx.board
        elims: list[Elimination] = []

        for unit in board.units:
            if unit.kind not in (UnitKind.ROW, UnitKind.COL, UnitKind.BOX):
                continue

            # Collect all cage units whose cells lie entirely within this unit,
            # paired with their current (already-pruned) solution lists.
            sub_cages: list[tuple[frozenset[Cell], list[frozenset[int]]]] = []
            for other in board.units:
                if other.kind != UnitKind.CAGE:
                    continue
                if not (other.cells <= unit.cells):
                    continue
                cage_idx = other.unit_id - 27
                solns = board.cage_solns[cage_idx]
                if solns:
                    sub_cages.append((other.cells, solns))

            # Sort by m (number of solutions) ascending so the most constrained
            # cage drives the DFS first and prunes the combination tree early.
            sub_cages.sort(key=lambda x: len(x[1]))

            # Find a disjoint partition of this unit's 9 cells from the sub_cages.
            partition = _find_partition(unit.cells, sub_cages)
            if partition is None:
                continue

            # Cross-cages: cages within the unit that are NOT partition members.
            # They span cells from multiple partition cages and impose additional
            # positional sum constraints (e.g. virtual cages from the linear system).
            partition_cells = {cells for cells, _ in partition}
            cross_cages = [
                (cells, solns)
                for cells, solns in sub_cages
                if cells not in partition_cells
            ]

            # Phase 1: DFS over cage-level digit-set assignments.
            valid_per_cage = _cross_valid_combos(partition, _MAX_NODES)

            # Phase 2: Cell-level expansion, filtered by cell candidates and
            # cross-cage sum constraints.
            valid_cell_digits = _expand_cell_level(
                partition, valid_per_cage, cross_cages, board.candidates
            )

            for (r, c), valid_digits in valid_cell_digits.items():
                for d in list(board.candidates[r][c]):
                    if d not in valid_digits:
                        elims.append(Elimination(cell=(r, c), digit=d))

        return list(dict.fromkeys(elims))

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []


def _find_partition(
    remaining: frozenset[Cell],
    sub_cages: list[tuple[frozenset[Cell], list[frozenset[int]]]],
) -> list[tuple[frozenset[Cell], list[frozenset[int]]]] | None:
    """Find a disjoint cover of remaining cells using sub_cages via DFS.

    At each step picks the lexicographically smallest uncovered cell and tries
    each cage that covers it, backtracking if that choice cannot be extended to
    a full cover.  Returns the first complete partition found, or None.
    """
    if not remaining:
        return []

    target = min(remaining)
    for cells, solns in sub_cages:
        if target not in cells:
            continue
        new_remaining = remaining - cells
        # Only keep cages that don't overlap with the chosen cage
        new_sub_cages = [(c, s) for c, s in sub_cages if not (c & cells)]
        result = _find_partition(new_remaining, new_sub_cages)
        if result is not None:
            return [(cells, solns), *result]

    return None  # no cage covers target; partition impossible


def _cross_valid_combos(
    partition: list[tuple[frozenset[Cell], list[frozenset[int]]]],
    max_nodes: int,
) -> list[set[frozenset[int]]]:
    """Enumerate valid cross-cage solution combinations via DFS + propagation.

    Returns one set of valid solutions per partition cage.  A solution is
    considered valid if it participated in at least one digit-conflict-free
    combination, OR if the node budget was exhausted before that branch was
    refuted (conservative treatment).

    Args:
        partition: ordered list of (cells, solutions) for each cage in the unit.
        max_nodes: maximum DFS branch-nodes to explore before treating remaining
            branches as conservatively valid.

    Returns:
        A list (same length as partition) of sets; each set contains the
        solutions for that cage that are consistent with at least one valid
        cross-cage assignment.
    """
    n = len(partition)
    valid_per_cage: list[set[frozenset[int]]] = [set() for _ in range(n)]
    nodes = [0]  # mutable counter shared across recursive calls

    def dfs(
        idx: int,
        filtered: list[list[frozenset[int]]],
    ) -> bool:
        """Recursively assign solutions to partition[idx..n-1].

        filtered[i] is the current solution list for partition[i] after
        propagating the choices made at depth 0..idx-1.

        Returns True if at least one valid complete assignment was found,
        False if all branches were contradictions, or raises _CapHitError if the
        node budget runs out (caller treats remaining branches conservatively).
        """
        if idx == n:
            return True  # complete assignment â no digit conflicts anywhere

        solns = filtered[idx]
        if not solns:
            return False  # contradiction â no valid solution for this cage

        # Forced singleton: propagate for free without consuming a node.
        # Multiple choices: count each as a branch node.
        is_forced = len(solns) == 1

        found_valid = False
        for soln in solns:
            if not is_forced:
                nodes[0] += 1
                if nodes[0] > max_nodes:
                    # Budget exhausted â record remaining solns as conservatively
                    # valid for this cage and all downstream cages.
                    for remaining_soln in solns:
                        valid_per_cage[idx].add(remaining_soln)
                    for j in range(idx + 1, n):
                        for s in filtered[j]:
                            valid_per_cage[j].add(s)
                    raise _CapHitError

            # Propagate: filter each downstream cage's solutions.
            new_filtered = [
                [s for s in filtered[j] if not (s & soln)] if j > idx else filtered[j]
                for j in range(n)
            ]

            try:
                sub = dfs(idx + 1, new_filtered)
            except _CapHitError:
                # Budget hit deeper down â this solution is conservatively valid.
                valid_per_cage[idx].add(soln)
                raise  # propagate the cap upward

            if sub:
                valid_per_cage[idx].add(soln)
                found_valid = True

        return found_valid

    initial = [solns for _, solns in partition]
    try:
        dfs(0, initial)
    except _CapHitError:
        pass  # conservative results already recorded by the DFS

    return valid_per_cage


def _expand_cell_level(
    partition: list[tuple[frozenset[Cell], list[frozenset[int]]]],
    valid_per_cage: list[set[frozenset[int]]],
    cross_cages: list[tuple[frozenset[Cell], list[frozenset[int]]]],
    candidates: list[list[set[int]]],
) -> dict[Cell, set[int]]:
    """Expand valid cage-set combinations to valid cell-to-digit assignments.

    For each valid combination of digit sets (one per partition cage), enumerates
    all assignments of those digits to specific cells, filtered by:
      - cell candidates (the digit must be in the cell's current candidate set), and
      - cross-cage sum constraints (any non-partition cage within the unit whose
        cells are all assigned must have its digit set in its solution list).

    Returns a dict mapping each partition cell to the set of digits it can hold
    across all valid complete cell assignments.  A (cell, digit) pair is included
    only if it participates in at least one valid complete assignment.

    Args:
        partition: ordered list of (cells, _) for each cage in the partition.
        valid_per_cage: valid digit sets per cage from Phase 1.
        cross_cages: non-partition cages entirely within the unit.
        candidates: board.candidates â current candidate set per cell.
    """
    result: dict[Cell, set[int]] = {
        cell: set() for cells, _ in partition for cell in cells
    }
    n = len(partition)

    # Pre-convert cross-cage solution lists to frozensets for O(1) membership.
    cross_cage_soln_sets = [(cells, frozenset(solns)) for cells, solns in cross_cages]

    def dfs(idx: int, current: dict[Cell, int], used: frozenset[int]) -> None:
        if idx == n:
            for cell, digit in current.items():
                result[cell].add(digit)
            return

        cells, _ = partition[idx]
        cells_sorted = sorted(cells)

        for digit_set in valid_per_cage[idx]:
            if digit_set & used:
                continue  # Digit already used by an earlier cage in this combo.

            for perm in itertools.permutations(sorted(digit_set)):
                # Filter by cell candidates.
                if not all(
                    perm[i] in candidates[r][c] for i, (r, c) in enumerate(cells_sorted)
                ):
                    continue

                cell_asn: dict[Cell, int] = dict(zip(cells_sorted, perm, strict=False))
                new_current = {**current, **cell_asn}

                # Check any cross-cage whose cells are now fully assigned.
                ok = True
                for cc_cells, cc_solns in cross_cage_soln_sets:
                    if not cc_cells.issubset(new_current):
                        continue  # Not all cells assigned yet.
                    assigned = frozenset(new_current[c] for c in cc_cells)
                    if assigned not in cc_solns:
                        ok = False
                        break
                if not ok:
                    continue

                dfs(idx + 1, new_current, used | digit_set)

    dfs(0, {}, frozenset())
    return result


class _CapHitError(Exception):
    """Sentinel raised when the DFS node budget is exhausted."""
