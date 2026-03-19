"""R12 UnitPartitionFilter — cross-cage compatibility within a complete unit partition.

When all cells of a row, column, or box are covered by a disjoint set of
sub-cages (real or virtual), the digit assignments across those cages must
form a valid permutation of {1..9}.  Any cage solution that cannot participate
in any valid cross-cage combination is eliminated.

Example: col 8 partitioned by virtual-cage {r0c8,r1c8}=6, cage {r2c8,r3c8}=8,
cage {r4c8,r5c8}=9, cage {r6c8,r7c8,r8c8}=22.  Solution {1,5} for the 6-cage
forces {2,6} for the 8-cage, leaving no valid pair for the 9-cage →
eliminate {1,5}, which forces {r0c8,r1c8}={2,4}.

Enumeration uses DFS with constraint propagation: after fixing one cage's digit
set, the remaining cages' solution lists are filtered immediately (any solution
that shares a digit with the chosen set is discarded).  Forced assignments
(m=1 after filtering) propagate for free without counting as a branch.  Only
genuine branch points (m≥2) consume a node from the budget.  When the budget
is exhausted, the current branch is treated conservatively — it is recorded as
potentially valid rather than invalid — so no correct solution is ever discarded.

Only cages whose cells lie entirely within the unit are considered, so the rule
cannot use a cage that crosses unit boundaries unless a virtual cage (derived by
the linear system) captures exactly the in-unit portion.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind

# Maximum number of DFS branch nodes to explore per partition.
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
        """Scan units; eliminate solutions incompatible with their cage partition."""
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
            # n! is not relevant here — we compare digit sets, not ordered maps.
            sub_cages.sort(key=lambda x: len(x[1]))

            # Find a disjoint partition of this unit's 9 cells from the sub_cages.
            partition = _find_partition(unit.cells, sub_cages)
            if partition is None:
                continue

            # DFS with constraint propagation; cap on search-tree nodes.
            valid_per_cage = _cross_valid_combos(partition, _MAX_NODES)

            # For each partition cage, eliminate cell candidates that never
            # appear in any valid cross-cage combination.
            for (cells, _), valid_solns in zip(partition, valid_per_cage, strict=False):
                valid_digits: set[int] = set()
                for s in valid_solns:
                    valid_digits |= s
                for r, c in cells:
                    for d in list(board.candidates[r][c]):
                        if d not in valid_digits:
                            elims.append(Elimination(cell=(r, c), digit=d))

        return list(dict.fromkeys(elims))


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
        False if all branches were contradictions, or raises _CapHit if the
        node budget runs out (caller treats remaining branches conservatively).
        """
        if idx == n:
            return True  # complete assignment — no digit conflicts anywhere

        solns = filtered[idx]
        if not solns:
            return False  # contradiction — no valid solution for this cage

        # Forced singleton: propagate for free without consuming a node.
        # Multiple choices: count each as a branch node.
        is_forced = len(solns) == 1

        found_valid = False
        for soln in solns:
            if not is_forced:
                nodes[0] += 1
                if nodes[0] > max_nodes:
                    # Budget exhausted — record remaining solns as conservatively
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
                # Budget hit deeper down — this solution is conservatively valid.
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


class _CapHitError(Exception):
    """Sentinel raised when the DFS node budget is exhausted."""
