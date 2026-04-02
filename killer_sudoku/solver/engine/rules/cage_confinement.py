r"""CageConfinement — n cages confined to n same-type units eliminate essential digit.

For n cages C₁…Cₙ and n distinct same-type units U₁…Uₙ (all rows, all columns,
or all boxes): if digit d is essential (must-contain) to every cage and every
d-candidate cell in every cage lies within ⋃ Uⱼ, then by pigeonhole d is
eliminated from (⋃ Uⱼ) \ (⋃ Cᵢ).

Reasoning: same-type units are pairwise disjoint, so ⋃ Uⱼ holds exactly n copies
of d.  The n cages each require one copy (d is essential), and all possible
placements are within those n units.  Every copy is consumed; nothing remains
outside the cages.

Parameterised by max_n (default 2).  n=1 covers the case where a single cage's
d-candidates are all in one unit (tighter than MustContain, which requires all
cage cells outside the unit to lack d-candidates).  n=2 handles pairs of cages
that together span exactly two same-type units.

Fires as a GLOBAL rule (full-board scan when the event queue drains).
"""

from __future__ import annotations

import dataclasses
from itertools import combinations

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import (
    Cell,
    Elimination,
    RuleResult,
    Trigger,
    Unit,
    UnitKind,
)


@dataclasses.dataclass(frozen=True)
class _ConfinementMatch:
    """One firing instance: n cages confined to n same-type units for digit d."""

    digit: int
    cage_cells_list: tuple[frozenset[Cell], ...]  # one entry per cage
    units: tuple[Unit, ...]  # one entry per confining unit
    eliminations: list[Elimination]


def _cell_label(cell: Cell) -> str:
    """Return rNcM notation (1-based) for a cell."""
    r, c = cell
    return f"r{r + 1}c{c + 1}"


def _unit_label(unit: Unit) -> str:
    """Return a human-readable label for a unit, e.g. 'row 1', 'column 5'."""
    if unit.kind == UnitKind.ROW:
        return f"row {unit.unit_id + 1}"
    if unit.kind == UnitKind.COL:
        return f"column {unit.unit_id - 9 + 1}"
    return f"box {unit.unit_id - 18 + 1}"


def _unit_type_label(kind: UnitKind) -> str:
    """Return the plural noun for a unit type."""
    if kind == UnitKind.ROW:
        return "rows"
    if kind == UnitKind.COL:
        return "columns"
    return "boxes"


def _type_unit_id(kind: UnitKind, r: int, c: int) -> int:
    """Return the board unit_id of the same-type unit containing cell (r, c)."""
    if kind == UnitKind.ROW:
        return r  # unit_ids 0–8
    if kind == UnitKind.COL:
        return 9 + c  # unit_ids 9–17
    return 18 + (r // 3) * 3 + (c // 3)  # unit_ids 18–26


def _build_hint(match: _ConfinementMatch) -> HintResult:
    """Construct a HintResult from a confirmed confinement match."""
    d = match.digit
    n = len(match.units)
    kind = match.units[0].kind
    unit_labels = " and ".join(_unit_label(u) for u in match.units)
    removed_cells = sorted(
        {_cell_label(e.cell) for e in match.eliminations},
        key=lambda s: (int(s[1 : s.index("c")]), int(s[s.index("c") + 1 :])),
    )
    removed_str = ", ".join(removed_cells)
    cage_descs = [
        "[" + ", ".join(sorted(_cell_label(c) for c in cells)) + "]"
        for cells in match.cage_cells_list
    ]
    cages_str = " and ".join(cage_descs)

    if n == 1:
        explanation = (
            f"Digit {d} is essential to cage {cages_str} and all its candidate "
            f"placements within the cage are confined to {unit_labels}. "
            f"Since {unit_labels} must contain exactly one {d}, "
            f"the cage accounts for it. "
            f"Eliminating {d} from {removed_str}."
        )
    else:
        unit_type = _unit_type_label(kind)
        explanation = (
            f"Digit {d} is essential to cages {cages_str}. "
            f"Every possible placement of {d} in each cage lies within "
            f"{unit_labels}. "
            f"Those {n} {unit_type} contain exactly {n} copies of {d}, "
            f"all consumed by the {n} cages by pigeonhole. "
            f"Eliminating {d} from {removed_str}."
        )

    all_cage_cells: frozenset[Cell] = frozenset().union(*match.cage_cells_list)
    return HintResult(
        rule_name="CageConfinement",
        display_name=f"Essential digit confined ({n} cage{'s' if n > 1 else ''})",
        explanation=explanation,
        highlight_cells=all_cage_cells | frozenset(e.cell for e in match.eliminations),
        eliminations=match.eliminations,
    )


class CageConfinement:
    """CageConfinement(max_n): pigeonhole elimination when n cages fill n units.

    Scans the full board for all firing n-cage groups (n ≤ max_n).  Returns
    eliminations for every (cage-group, unit-type, digit) that satisfies the
    confinement condition.  Fires as a GLOBAL rule.
    """

    name = "CageConfinement"
    priority = 12
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()

    def __init__(self, max_n: int = 2) -> None:
        self._max_n = max_n

    # ── SolverRule protocol ──────────────────────────────────────────────────

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Return all confinement eliminations for the current board state."""
        seen: set[tuple[Cell, int]] = set()
        result: list[Elimination] = []
        for m in self._find_all_matches(ctx.board):
            for e in m.eliminations:
                key = (e.cell, e.digit)
                if key not in seen:
                    seen.add(key)
                    result.append(e)
        return RuleResult(eliminations=result)

    # ── Hint interface ───────────────────────────────────────────────────────

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return one HintResult per confinement found on the board.

        GLOBAL rule: ctx.unit is None. Scans the entire board for n-cage
        confinements and returns independent hints for each.
        eliminations (from apply()) is used only to short-circuit when empty.
        """
        if not eliminations:
            return []
        return self._scan_for_hints(ctx.board)

    def _scan_for_hints(self, board: BoardState) -> list[HintResult]:
        """Scan the full board and return one HintResult per distinct confinement."""
        seen: set[tuple[Cell, int]] = set()
        results: list[HintResult] = []
        for m in self._find_all_matches(board):
            new_elims = [e for e in m.eliminations if (e.cell, e.digit) not in seen]
            if not new_elims:
                continue
            for e in new_elims:
                seen.add((e.cell, e.digit))
            deduped = _ConfinementMatch(
                digit=m.digit,
                cage_cells_list=m.cage_cells_list,
                units=m.units,
                eliminations=new_elims,
            )
            results.append(_build_hint(deduped))
        return results

    # ── Internal search ──────────────────────────────────────────────────────

    def _find_all_matches(self, board: BoardState) -> list[_ConfinementMatch]:
        """Collect all firing matches across all unit types and digits."""
        matches: list[_ConfinementMatch] = []
        for kind in (UnitKind.ROW, UnitKind.COL, UnitKind.BOX):
            for d in range(1, 10):
                matches.extend(self._search(board, kind, d))
        return matches

    def _search(
        self, board: BoardState, kind: UnitKind, d: int
    ) -> list[_ConfinementMatch]:
        """Find all firing n-cage groups for a given same-type unit kind and digit.

        For each real cage where d is essential, record which same-type units
        contain any d-candidate cell.  Then test all n-subsets of those cages
        (1 ≤ n ≤ max_n): if the union of their d-unit sets has exactly n members
        the confinement condition is met and eliminations are produced.
        """
        # cage_info[i] = (cage_cells, frozenset of same-type unit_ids for d-candidates)
        cage_info: list[tuple[frozenset[Cell], frozenset[int]]] = []
        for unit in board.units:
            if unit.kind != UnitKind.CAGE or not unit.distinct_digits:
                continue
            cage_idx = unit.unit_id - 27
            solns = board.cage_solns[cage_idx]
            if not solns:
                continue
            # d is essential iff it appears in every remaining solution
            if not all(d in s for s in solns):
                continue
            d_unit_ids: set[int] = set()
            for r, c in unit.cells:
                if d in board.candidates[r][c]:
                    d_unit_ids.add(_type_unit_id(kind, r, c))
            if not d_unit_ids:
                continue  # d already placed or fully removed from this cage
            cage_info.append((unit.cells, frozenset(d_unit_ids)))

        matches: list[_ConfinementMatch] = []
        for n in range(1, self._max_n + 1):
            for combo in combinations(range(len(cage_info)), n):
                # Pigeonhole requires disjoint cages: overlapping cells mean one
                # copy of d can satisfy multiple cages, invalidating the argument.
                combo_cells = [cage_info[i][0] for i in combo]
                all_cells_flat = [c for cells in combo_cells for c in cells]
                if len(all_cells_flat) != len(set(all_cells_flat)):
                    continue  # overlapping cells — argument unsound

                combined_uid = frozenset().union(*(cage_info[i][1] for i in combo))
                if len(combined_uid) != n:
                    continue  # cages span fewer or more units than required
                units_tuple = tuple(board.units[uid] for uid in sorted(combined_uid))
                all_cage_cells: frozenset[Cell] = frozenset().union(
                    *(cage_info[i][0] for i in combo)
                )
                unit_cells_union: frozenset[Cell] = frozenset().union(
                    *(u.cells for u in units_tuple)
                )
                elims = [
                    Elimination(cell=cell, digit=d)
                    for cell in unit_cells_union - all_cage_cells
                    if d in board.candidates[cell[0]][cell[1]]
                ]
                if not elims:
                    continue
                matches.append(
                    _ConfinementMatch(
                        digit=d,
                        cage_cells_list=tuple(cage_info[i][0] for i in combo),
                        units=units_tuple,
                        eliminations=elims,
                    )
                )
        return matches
