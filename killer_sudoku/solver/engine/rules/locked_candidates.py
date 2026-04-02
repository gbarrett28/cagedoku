"""R10b LockedCandidates — digit in a unit confined to one cage or box.

Two patterns (both fired from a ROW, COL, or BOX trigger):

  Unit → Cage  (Cage-Line Reduction):
    When all cells in a row/col/box that carry digit d lie within a single
    cage, d is locked to the unit-cage intersection.  Since d must appear
    somewhere in the row/col/box, and all those positions are inside the
    cage, d can be eliminated from cage cells outside the unit.

  Unit → Box  (Box-Line Reduction):
    When all cells in a row or column that carry digit d lie within a single
    3×3 box, d is locked to the row/col-box intersection.  It can therefore
    be eliminated from the other cells of that box outside the row/column.

These are the unit-first counterparts to CageIntersection (cage-first) and
PointingPairs (box-first).

Fires on COUNT_DECREASED for ROW, COL, and BOX units.
"""

from __future__ import annotations

import dataclasses
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


@dataclasses.dataclass(frozen=True)
class _Match:
    """One firing of LockedCandidates."""

    digit: int
    source_unit: Unit  # the row/col/box that triggered
    carriers: frozenset[Cell]  # cells in source_unit that carry d
    target_unit: Unit  # the cage or box receiving the eliminations
    pattern: str  # "unit_cage" | "unit_box"
    eliminations: list[Elimination]


@hintable_rule
class LockedCandidates:
    """R10b: digit in a unit confined to one cage or box — eliminate from container."""

    name = "LockedCandidates"
    priority = 11
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX}
    )

    # ── internal helpers ────────────────────────────────────────────────────

    @staticmethod
    def _iter_matches(ctx: RuleContext) -> Iterator[_Match]:
        """Yield one _Match per (digit, target-unit) pair that fires."""
        assert ctx.unit is not None
        board: BoardState = ctx.board
        unit_cells = ctx.unit.cells
        unit_kind = ctx.unit.kind

        for d in range(1, 10):
            carriers = [(r, c) for r, c in unit_cells if d in board.candidates[r][c]]
            if len(carriers) < 2:
                continue

            # ── Pattern 1: Unit → Cage (Cage-Line Reduction) ─────────────────
            common_cage_ids: set[int] | None = None
            for r, c in carriers:
                cell_cages = {
                    uid
                    for uid in board.cell_unit_ids(r, c)
                    if board.units[uid].kind == UnitKind.CAGE
                }
                if common_cage_ids is None:
                    common_cage_ids = cell_cages
                else:
                    common_cage_ids &= cell_cages
                if not common_cage_ids:
                    break

            if common_cage_ids:
                for cage_uid in common_cage_ids:
                    elims = [
                        Elimination(cell=(r, c), digit=d)
                        for r, c in board.units[cage_uid].cells
                        if (r, c) not in unit_cells and d in board.candidates[r][c]
                    ]
                    if elims:
                        yield _Match(
                            digit=d,
                            source_unit=ctx.unit,
                            carriers=frozenset(carriers),
                            target_unit=board.units[cage_uid],
                            pattern="unit_cage",
                            eliminations=elims,
                        )

            # ── Pattern 2: Unit → Box (Box-Line Reduction) ────────────────────
            if unit_kind in (UnitKind.ROW, UnitKind.COL):
                rows = {r for r, _ in carriers}
                cols = {c for _, c in carriers}
                box_rows = {r // 3 for r in rows}
                box_cols = {c // 3 for c in cols}
                if len(box_rows) == 1 and len(box_cols) == 1:
                    br, bc = next(iter(box_rows)), next(iter(box_cols))
                    box_uid = board.box_unit_id(br * 3, bc * 3)
                    elims = [
                        Elimination(cell=(r, c), digit=d)
                        for r, c in board.units[box_uid].cells
                        if (r, c) not in unit_cells and d in board.candidates[r][c]
                    ]
                    if elims:
                        yield _Match(
                            digit=d,
                            source_unit=ctx.unit,
                            carriers=frozenset(carriers),
                            target_unit=board.units[box_uid],
                            pattern="unit_box",
                            eliminations=elims,
                        )

    @staticmethod
    def _build_hint(m: _Match) -> HintResult:
        """Construct a HintResult from a confirmed _Match."""
        d = m.digit
        carriers_str = ", ".join(sorted(cell_label(c) for c in m.carriers))
        source_lbl = unit_label(m.source_unit)
        target_lbl = unit_label(m.target_unit)
        elim_cells_str = ", ".join(sorted(cell_label(e.cell) for e in m.eliminations))

        if m.pattern == "unit_cage":
            explanation = (
                f"In {source_lbl}, {d} can only go in {carriers_str}. "
                f"All those cells belong to the same cage ({target_lbl}'s cage). "
                f"Since {d} must appear somewhere in {source_lbl} and all its "
                f"candidates are inside that cage, {d} can be eliminated from "
                f"{elim_cells_str} (cage cells outside {source_lbl})."
            )
            display_name = "Locked Candidates (Cage-Line)"
        else:
            explanation = (
                f"In {source_lbl}, {d} can only go in {carriers_str}. "
                f"All those cells lie within {target_lbl}. "
                f"Since {d} must appear somewhere in {source_lbl} and all its "
                f"candidates are locked to {target_lbl}, {d} can be eliminated "
                f"from {elim_cells_str} "
                f"(the other cells in {target_lbl} outside {source_lbl})."
            )
            display_name = "Locked Candidates (Box-Line)"

        return HintResult(
            rule_name="LockedCandidates",
            display_name=display_name,
            explanation=explanation,
            highlight_cells=m.carriers | {e.cell for e in m.eliminations},
            eliminations=m.eliminations,
        )

    # ── SolverRule protocol ─────────────────────────────────────────────────

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Eliminate d from any container that holds all of this unit's d-candidates."""
        seen: set[tuple[Cell, int]] = set()
        elims: list[Elimination] = []
        for m in self._iter_matches(ctx):
            for e in m.eliminations:
                key = (e.cell, e.digit)
                if key not in seen:
                    seen.add(key)
                    elims.append(e)
        return RuleResult(eliminations=elims)

    # ── Hint interface ──────────────────────────────────────────────────────

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return one HintResult per (digit, target-unit) match."""
        if not eliminations:
            return []
        hints: list[HintResult] = []
        seen: set[tuple[Cell, int]] = set()
        for m in self._iter_matches(ctx):
            new_keys = {(e.cell, e.digit) for e in m.eliminations} - seen
            if new_keys:
                seen.update(new_keys)
                hints.append(self._build_hint(m))
        return hints
