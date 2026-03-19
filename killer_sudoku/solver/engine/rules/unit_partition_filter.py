"""R12 UnitPartitionFilter — cross-cage compatibility within a complete unit partition.

When all cells of a row, column, or box are covered by a disjoint set of
sub-cages (real or virtual), the digit assignments across those cages must
form a valid permutation of {1..9}.  Any cage solution that cannot participate
in any valid cross-cage combination is eliminated.

Example: col 8 partitioned by virtual-cage {r0c8,r1c8}=6, cage {r2c8,r3c8}=8,
cage {r4c8,r5c8}=9, cage {r6c8,r7c8,r8c8}=22.  Solution {1,5} for the 6-cage
forces {2,6} for the 8-cage, leaving no valid pair for the 9-cage →
eliminate {1,5}, which forces {r0c8,r1c8}={2,4}.

This is equivalent to limited backtracking over cage solutions: each partition
cage is a branch point, and the enumeration only considers combinations within
the local unit — not a global search.  A cage with k solutions requires at most
k "leaves" to check, which is human-tractable when k is small.

Only cages whose cells lie entirely within the unit are considered, so the rule
cannot use a cage that crosses unit boundaries unless a virtual cage (derived by
the linear system) captures exactly the in-unit portion.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

import itertools
import math

from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind

# Maximum number of cross-cage combinations to enumerate per partition.
# Protects against combinatorial explosion on large partitions.
_MAX_COMBOS = 500


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

            # Sort by m × n! (solutions × factorial(cells)) ascending so the
            # most constrained cage drives the DFS first and prunes early.
            sub_cages.sort(key=lambda x: len(x[1]) * math.factorial(len(x[0])))

            # Find a disjoint partition of this unit's 9 cells from the sub_cages.
            partition = _find_partition(unit.cells, sub_cages)
            if partition is None:
                continue

            # Skip partitions whose enumeration space exceeds the cap.
            n_combos = 1
            for _, solns in partition:
                n_combos *= len(solns)
                if n_combos > _MAX_COMBOS:
                    break
            if n_combos > _MAX_COMBOS:
                continue

            # Enumerate all cross-cage solution combinations.
            # A combination is valid iff no digit appears in more than one cage.
            solution_lists = [solns for _, solns in partition]
            valid_per_cage: list[set[frozenset[int]]] = [set() for _ in partition]

            for combo in itertools.product(*solution_lists):
                combined: set[int] = set()
                ok = True
                for s in combo:
                    if combined & s:  # digit conflict between cage assignments
                        ok = False
                        break
                    combined |= s
                if ok:
                    for i, s in enumerate(combo):
                        valid_per_cage[i].add(s)

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
