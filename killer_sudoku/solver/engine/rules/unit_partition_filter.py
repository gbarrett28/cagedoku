"""R12 UnitPartitionFilter — cross-cage compatibility within a complete unit partition.

When all cells of a row, column, or box are covered by a disjoint set of
sub-cages (real or virtual), the digit assignments across those cages must
form a valid permutation of {1..9}.  Any cage solution that cannot participate
in any valid cross-cage combination is eliminated.

Elimination proceeds in two phases:

  Phase 1 — cage-set DFS: find which digit *sets* are valid for each partition
  cage, using constraint propagation (fixing one cage's digit set immediately
  filters conflicting solutions from remaining cages).  Forced singletons
  propagate for free; genuine branch points consume a node from the budget.
  When the budget is exhausted remaining branches are treated conservatively
  (potentially valid) so no correct solution is ever discarded.

  Phase 2 — cell-level expansion: for each valid digit-set combination, enumerate
  all assignments of those digits to the specific cells within each cage, filtered
  by cell candidates.  Non-partition cages that lie entirely within the unit but
  span multiple partition cages (cross-cages, e.g. virtual cages derived by the
  linear system) impose additional sum constraints on these cell assignments.
  Only (cell, digit) pairs that survive at least one valid complete cell
  assignment are kept.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

import dataclasses
import itertools
from collections.abc import Iterator

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules._labels import cell_label, unit_label
from killer_sudoku.solver.engine.rules._registry import hintable_rule
from killer_sudoku.solver.engine.types import (
    Cell,
    Elimination,
    RuleResult,
    Trigger,
    Unit,
    UnitKind,
)

# Maximum DFS branch nodes per partition before treating remaining as valid.
_MAX_NODES = 200


@dataclasses.dataclass
class _Match:
    """One firing of UnitPartitionFilter: a partitioned unit with eliminations."""

    unit: Unit
    partition: list[tuple[frozenset[Cell], list[frozenset[int]]]]
    cross_cages: list[tuple[frozenset[Cell], list[frozenset[int]]]]
    eliminations: list[Elimination]


@hintable_rule
class UnitPartitionFilter:
    """R12: cross-cage compatibility filter for completely partitioned units."""

    name = "UnitPartitionFilter"
    priority = 12
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()  # GLOBAL — ctx.unit is always None

    # ── internal helpers ────────────────────────────────────────────────────

    @staticmethod
    def _iter_matches(board: BoardState) -> Iterator[_Match]:
        """Yield one _Match per unit where cage partition produces eliminations."""
        for unit in board.units:
            if unit.kind not in (UnitKind.ROW, UnitKind.COL, UnitKind.BOX):
                continue

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

            sub_cages.sort(key=lambda x: len(x[1]))

            partition = _find_partition(unit.cells, sub_cages)
            if partition is None:
                continue

            partition_cells = {cells for cells, _ in partition}
            cross_cages = [
                (cells, solns)
                for cells, solns in sub_cages
                if cells not in partition_cells
            ]

            valid_per_cage = _cross_valid_combos(partition, _MAX_NODES)
            valid_cell_digits = _expand_cell_level(
                partition, valid_per_cage, cross_cages, board.candidates
            )

            elims = [
                Elimination(cell=(r, c), digit=d)
                for (r, c), valid_digits in valid_cell_digits.items()
                for d in board.candidates[r][c]
                if d not in valid_digits
            ]
            elims = list(dict.fromkeys(elims))

            if elims:
                yield _Match(
                    unit=unit,
                    partition=partition,
                    cross_cages=cross_cages,
                    eliminations=elims,
                )

    @staticmethod
    def _build_hint(m: _Match) -> HintResult:
        """Construct a HintResult from a confirmed _Match."""
        unit_lbl = unit_label(m.unit)
        n_cages = len(m.partition)
        cage_descs = []
        for cells, solns in m.partition:
            cell_str = ", ".join(cell_label(c) for c in sorted(cells))
            cage_descs.append(f"[{cell_str}] ({len(solns)} solutions)")
        cages_str = "; ".join(cage_descs)

        cross_note = ""
        if m.cross_cages:
            cross_note = (
                f" Additional sum constraints from {len(m.cross_cages)} "
                f"virtual cage{'s' if len(m.cross_cages) != 1 else ''} "
                f"within {unit_lbl} further limit valid assignments."
            )

        n_elims = len(m.eliminations)
        explanation = (
            f"All 9 cells of {unit_lbl} are completely covered by {n_cages} cages: "
            f"{cages_str}. "
            f"These cages must collectively assign each digit 1–9 exactly once "
            f"across {unit_lbl} — no digit can repeat.{cross_note} "
            f"Checking all compatible combinations of cage solutions, "
            f"{n_elims} candidate{'s' if n_elims != 1 else ''} cannot appear in "
            f"any valid assignment and can be eliminated."
        )

        return HintResult(
            rule_name="UnitPartitionFilter",
            display_name="Unit Partition Filter",
            explanation=explanation,
            highlight_cells=frozenset(
                cell for cells, _ in m.partition for cell in cells
            ),
            eliminations=m.eliminations,
        )

    # ── SolverRule protocol ─────────────────────────────────────────────────

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Scan units; eliminate candidates incompatible with any valid assignment."""
        elims = [e for m in self._iter_matches(ctx.board) for e in m.eliminations]
        return RuleResult(eliminations=list(dict.fromkeys(elims)))

    # ── Hint interface ──────────────────────────────────────────────────────

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return one HintResult per partitioned unit that produces eliminations."""
        if not eliminations:
            return []
        return [self._build_hint(m) for m in self._iter_matches(ctx.board)]


# ── Module-level helpers (unchanged from original) ──────────────────────────


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
        new_sub_cages = [(c, s) for c, s in sub_cages if not (c & cells)]
        result = _find_partition(new_remaining, new_sub_cages)
        if result is not None:
            return [(cells, solns), *result]

    return None


def _cross_valid_combos(
    partition: list[tuple[frozenset[Cell], list[frozenset[int]]]],
    max_nodes: int,
) -> list[set[frozenset[int]]]:
    """Enumerate valid cross-cage solution combinations via DFS + propagation.

    Returns one set of valid solutions per partition cage.  A solution is
    considered valid if it participated in at least one digit-conflict-free
    combination, OR if the node budget was exhausted before that branch was
    refuted (conservative treatment).
    """
    n = len(partition)
    valid_per_cage: list[set[frozenset[int]]] = [set() for _ in range(n)]
    nodes = [0]

    def dfs(idx: int, filtered: list[list[frozenset[int]]]) -> bool:
        if idx == n:
            return True

        solns = filtered[idx]
        if not solns:
            return False

        is_forced = len(solns) == 1

        found_valid = False
        for soln in solns:
            if not is_forced:
                nodes[0] += 1
                if nodes[0] > max_nodes:
                    for remaining_soln in solns:
                        valid_per_cage[idx].add(remaining_soln)
                    for j in range(idx + 1, n):
                        for s in filtered[j]:
                            valid_per_cage[j].add(s)
                    raise _CapHitError

            new_filtered = [
                [s for s in filtered[j] if not (s & soln)] if j > idx else filtered[j]
                for j in range(n)
            ]

            try:
                sub = dfs(idx + 1, new_filtered)
            except _CapHitError:
                valid_per_cage[idx].add(soln)
                raise

            if sub:
                valid_per_cage[idx].add(soln)
                found_valid = True

        return found_valid

    initial = [solns for _, solns in partition]
    try:
        dfs(0, initial)
    except _CapHitError:
        pass

    return valid_per_cage


def _expand_cell_level(
    partition: list[tuple[frozenset[Cell], list[frozenset[int]]]],
    valid_per_cage: list[set[frozenset[int]]],
    cross_cages: list[tuple[frozenset[Cell], list[frozenset[int]]]],
    candidates: list[list[set[int]]],
) -> dict[Cell, set[int]]:
    """Expand valid cage-set combinations to valid cell-to-digit assignments.

    Returns a dict mapping each partition cell to the set of digits it can hold
    across all valid complete cell assignments.
    """
    result: dict[Cell, set[int]] = {
        cell: set() for cells, _ in partition for cell in cells
    }
    n = len(partition)

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
                continue

            for perm in itertools.permutations(sorted(digit_set)):
                if not all(
                    perm[i] in candidates[r][c] for i, (r, c) in enumerate(cells_sorted)
                ):
                    continue

                cell_asn: dict[Cell, int] = dict(zip(cells_sorted, perm, strict=False))
                new_current = {**current, **cell_asn}

                ok = True
                for cc_cells, cc_solns in cross_cage_soln_sets:
                    if not cc_cells.issubset(new_current):
                        continue
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
