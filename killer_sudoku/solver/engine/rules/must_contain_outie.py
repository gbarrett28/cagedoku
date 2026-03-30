"""R4b MustContainOutie — outie must mirror the single external cell's candidates.

When a cage C has exactly one cell outside a unit U (the "outie"), and there
is exactly one external cell x in U (not in C) whose candidates are all in
C's must-contain set, then the outie's candidates are restricted to candidates(x).

Intuition: x can only take a digit from C's must-have set.  Whichever digit x
holds, unit-uniqueness blocks it from every inside cell of C (they share U with
x).  The cage still needs that digit somewhere, so it must land on the outie.
This holds for every possible value of x, so the outie's candidates ⊆ cands(x).

Example: cage {r1c6, r1c7, r1c8, r2c8} must contain {6,8,9}.  Cell r1c3 is
external to the cage but in row 1, with candidates {6,8,9}.  Three cage cells
(r1c6, r1c7, r1c8) share row 1 with r1c3; r2c8 is the sole outie.  Whichever
of {6,8,9} r1c3 holds, it is blocked from the three row-1 cage cells, so the
cage must place that digit at r2c8 → cands(r2c8) ⊆ {6,8,9}.

Fires on COUNT_DECREASED (all unit kinds) and SOLUTION_PRUNED (cage only).
"""

from __future__ import annotations

import dataclasses

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, Unit, UnitKind


@dataclasses.dataclass(frozen=True)
class _Match:
    """Internal record of one firing instance of the MustContainOutie rule."""

    cage_cells: frozenset[Cell]
    must: frozenset[int]
    unit: Unit
    outie: Cell
    external_cell: Cell
    x_cands: frozenset[int]
    eliminations: list[Elimination]


def _unit_label(unit: Unit) -> str:
    """Return a human-readable label for a unit, e.g. 'row 1', 'column 5'."""
    if unit.kind == UnitKind.ROW:
        row = unit.unit_id  # 0-based
        return f"row {row + 1}"
    if unit.kind == UnitKind.COL:
        col = unit.unit_id - 9  # 0-based
        return f"column {col + 1}"
    # BOX
    box = unit.unit_id - 18  # 0-based, reading order
    return f"box {box + 1}"


def _cell_label(cell: Cell) -> str:
    """Return rNcM notation (1-based) for a cell."""
    r, c = cell
    return f"r{r + 1}c{c + 1}"


class MustContainOutie:
    """R4b: single external cell with candidates ⊆ must-contain restricts the outie."""

    name = "MustContainOutie"
    priority = 4
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    # ── internal helpers ────────────────────────────────────────────────────

    @staticmethod
    def _find_match(
        cage_cells: frozenset[Cell],
        must: set[int],
        unit: Unit,
        board: BoardState,
    ) -> _Match | None:
        """Return a _Match if this cage/unit pair fires the rule, else None.

        Condition: exactly one cage cell is outside the unit (the outie), and
        exactly one external cell in the unit has candidates ⊆ must (the
        qualifying cell).  Returns None if either condition fails.
        """
        bs = board
        unit_cells = unit.cells
        inside = cage_cells & unit_cells
        outside = cage_cells - unit_cells
        if len(outside) != 1 or not inside:
            return None
        outie = next(iter(outside))
        outie_cands = bs.candidates[outie[0]][outie[1]]
        if not outie_cands:
            return None

        qualifying: list[Cell] = [
            (r, c)
            for r, c in unit_cells
            if (r, c) not in cage_cells
            and bs.candidates[r][c]
            and bs.candidates[r][c].issubset(must)
        ]
        if len(qualifying) != 1:
            return None

        x_r, x_c = qualifying[0]
        x_cands = bs.candidates[x_r][x_c]
        elims = [
            Elimination(cell=outie, digit=d) for d in outie_cands if d not in x_cands
        ]
        if not elims:
            return None

        return _Match(
            cage_cells=cage_cells,
            must=frozenset(must),
            unit=unit,
            outie=outie,
            external_cell=(x_r, x_c),
            x_cands=frozenset(x_cands),
            eliminations=elims,
        )

    @staticmethod
    def _build_hint(match: _Match) -> HintResult:
        """Construct a HintResult from a confirmed match."""
        cage_labels = ", ".join(sorted(_cell_label(c) for c in match.cage_cells))
        unit_lbl = _unit_label(match.unit)
        ext_lbl = _cell_label(match.external_cell)
        outie_lbl = _cell_label(match.outie)
        must_str = "{" + ", ".join(str(d) for d in sorted(match.must)) + "}"
        x_cands_str = "{" + ", ".join(str(d) for d in sorted(match.x_cands)) + "}"
        removed = sorted({e.digit for e in match.eliminations})
        removed_str = ", ".join(str(d) for d in removed)

        inside_cells = sorted(
            _cell_label(c) for c in match.cage_cells & match.unit.cells
        )
        inside_str = ", ".join(inside_cells)

        explanation = (
            f"Cage [{cage_labels}] must contain {must_str}. "
            f"Cell {ext_lbl} has candidates {x_cands_str} — all digits are in "
            f"the cage's must-contain set. "
            f"Since {ext_lbl} is in {unit_lbl} along with cage cells {inside_str}, "
            f"whichever digit {ext_lbl} holds is blocked from those cells by "
            f"{unit_lbl} uniqueness. "
            f"The cage must therefore place that digit at the outie {outie_lbl} "
            f"(the only cage cell outside {unit_lbl}). "
            f"So {outie_lbl}'s candidates are restricted to {x_cands_str}, "
            f"eliminating {removed_str}."
        )

        return HintResult(
            rule_name="MustContainOutie",
            display_name="Outie restricted by external cell",
            explanation=explanation,
            highlight_cells=match.cage_cells | {match.external_cell},
            eliminations=match.eliminations,
        )

    # ── SolverRule protocol ─────────────────────────────────────────────────

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Restrict outie candidates when one external cell qualifies.

        When triggered by a cage unit: checks each row/col/box unit the cage
        partially overlaps.  When triggered by a row/col/box: checks each cage
        that partially overlaps that unit.  Non-burb cages are skipped.
        """
        assert ctx.unit is not None
        board = ctx.board
        elims: list[Elimination] = []

        if ctx.unit.kind == UnitKind.CAGE:
            if not ctx.unit.distinct_digits:
                return []
            cage_cells = ctx.unit.cells
            cage_idx = ctx.unit.unit_id - 27
            solns = board.cage_solns[cage_idx]
            if not solns:
                return []
            must: set[int] = set(solns[0])
            for s in solns[1:]:
                must &= s
            if not must:
                return []
            seen_unit_ids: set[int] = set()
            for r, c in cage_cells:
                for uid in board.cell_unit_ids(r, c):
                    unit = board.units[uid]
                    if unit.kind == UnitKind.CAGE or uid in seen_unit_ids:
                        continue
                    seen_unit_ids.add(uid)
                    m = self._find_match(cage_cells, must, unit, board)
                    if m is not None:
                        elims.extend(m.eliminations)
        else:
            unit_cells = ctx.unit.cells
            seen_cage_ids: set[int] = set()
            for r, c in unit_cells:
                for uid in board.cell_unit_ids(r, c):
                    other = board.units[uid]
                    if other.kind != UnitKind.CAGE or not other.distinct_digits:
                        continue
                    cage_idx = other.unit_id - 27
                    if cage_idx in seen_cage_ids:
                        continue
                    seen_cage_ids.add(cage_idx)
                    solns = board.cage_solns[cage_idx]
                    if not solns:
                        continue
                    cage_must: set[int] = set(solns[0])
                    for s in solns[1:]:
                        cage_must &= s
                    if not cage_must:
                        continue
                    m = self._find_match(other.cells, cage_must, ctx.unit, board)
                    if m is not None:
                        elims.extend(m.eliminations)

        return elims

    # ── Hint interface ──────────────────────────────────────────────────────

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder — replaced with full implementation in Task 7."""
        return []

    def compute_hints(self, board: BoardState) -> list[HintResult]:
        """Return a HintResult for every distinct firing instance on this board.

        Iterates over all distinct cages and all non-cage units that partially
        overlap each cage, collecting every (cage, unit) pair where the rule
        fires.  Duplicate (outie, digit) pairs are suppressed.
        """
        bs = board
        results: list[HintResult] = []
        seen_elim_keys: set[tuple[Cell, int]] = set()

        for unit in bs.units:
            if unit.kind != UnitKind.CAGE or not unit.distinct_digits:
                continue
            cage_idx = unit.unit_id - 27
            solns = bs.cage_solns[cage_idx]
            if not solns:
                continue
            must: set[int] = set(solns[0])
            for s in solns[1:]:
                must &= s
            if not must:
                continue
            cage_cells = unit.cells
            seen_unit_ids: set[int] = set()
            for r, c in cage_cells:
                for uid in bs.cell_unit_ids(r, c):
                    other = bs.units[uid]
                    if other.kind == UnitKind.CAGE or uid in seen_unit_ids:
                        continue
                    seen_unit_ids.add(uid)
                    m = self._find_match(cage_cells, must, other, bs)
                    if m is None:
                        continue
                    # Deduplicate: only emit hints whose eliminations are new
                    new_elims = [
                        e
                        for e in m.eliminations
                        if (e.cell, e.digit) not in seen_elim_keys
                    ]
                    if not new_elims:
                        continue
                    for e in new_elims:
                        seen_elim_keys.add((e.cell, e.digit))
                    deduped = _Match(
                        cage_cells=m.cage_cells,
                        must=m.must,
                        unit=m.unit,
                        outie=m.outie,
                        external_cell=m.external_cell,
                        x_cands=m.x_cands,
                        eliminations=new_elims,
                    )
                    results.append(self._build_hint(deduped))

        return results
