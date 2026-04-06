"""R10 PointingPairs — digit in a box confined to one row or column.

When all cells within a 3×3 box that carry digit d lie in the same row
(or same column), d is locked to the box-row (or box-col) intersection.
It can therefore be eliminated from the rest of that row (or column)
outside the box.

This is the box-first counterpart to LockedCandidates (row/col-first).
Both are "locking" techniques: when a digit is confined to an intersection
of two units, it can be eliminated from the rest of each unit.

Example: in box 5 (rows 3–5, cols 3–5), digit 4 only appears as a candidate
in r3c4 and r3c5.  Both are in row 3, so 4 can be removed from every other
cell in row 3 that is outside box 5.

Fires on COUNT_DECREASED for BOX units.
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
    """One firing of PointingPairs."""

    digit: int
    box_unit: Unit
    carriers: frozenset[Cell]  # box cells that carry d
    line_unit: Unit  # the row or column they all share
    eliminations: list[Elimination]


@hintable_rule
class PointingPairs:
    """R10: digit confined to one row/col within a box — eliminate from the rest."""

    name = "PointingPairs"
    description = (
        "When a digit in a box is confined to one row or column, it can be removed "
        "from other cells in that row or column outside the box."
    )
    priority = 9
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.BOX})

    # ── internal helpers ────────────────────────────────────────────────────

    @staticmethod
    def _iter_matches(ctx: RuleContext) -> Iterator[_Match]:
        """Yield one _Match per (digit, line) pair where box d-cells share a line."""
        assert ctx.unit is not None
        board: BoardState = ctx.board
        box_cells = ctx.unit.cells

        for d in range(1, 10):
            carriers = [(r, c) for r, c in box_cells if d in board.candidates[r][c]]
            if len(carriers) < 2:
                continue
            rows = {r for r, _ in carriers}
            cols = {c for _, c in carriers}

            if len(rows) == 1:
                row = next(iter(rows))
                line_uid = board.row_unit_id(row)
                elims = [
                    Elimination(cell=(r, c), digit=d)
                    for r, c in board.units[line_uid].cells
                    if (r, c) not in box_cells and d in board.candidates[r][c]
                ]
                if elims:
                    yield _Match(
                        digit=d,
                        box_unit=ctx.unit,
                        carriers=frozenset(carriers),
                        line_unit=board.units[line_uid],
                        eliminations=elims,
                    )

            elif len(cols) == 1:
                col = next(iter(cols))
                col_uid = board.col_unit_id(col)
                elims = [
                    Elimination(cell=(r, c), digit=d)
                    for r, c in board.units[col_uid].cells
                    if (r, c) not in box_cells and d in board.candidates[r][c]
                ]
                if elims:
                    yield _Match(
                        digit=d,
                        box_unit=ctx.unit,
                        carriers=frozenset(carriers),
                        line_unit=board.units[col_uid],
                        eliminations=elims,
                    )

    @staticmethod
    def _build_hint(m: _Match) -> HintResult:
        """Construct a HintResult from a confirmed _Match."""
        d = m.digit
        carriers_str = ", ".join(sorted(cell_label(c) for c in m.carriers))
        box_lbl = unit_label(m.box_unit)
        line_lbl = unit_label(m.line_unit)
        elim_cells_str = ", ".join(sorted(cell_label(e.cell) for e in m.eliminations))

        explanation = (
            f"In {box_lbl}, {d} can only go in {carriers_str}. "
            f"All those cells lie in {line_lbl}, so {d} is locked to the "
            f"intersection of {box_lbl} and {line_lbl}. "
            f"Therefore {d} can be eliminated from {elim_cells_str} "
            f"(the other cells in {line_lbl} outside {box_lbl})."
        )

        return HintResult(
            rule_name="PointingPairs",
            display_name="Pointing Pairs",
            explanation=explanation,
            highlight_cells=m.carriers | {e.cell for e in m.eliminations},
            eliminations=m.eliminations,
        )

    # ── SolverRule protocol ─────────────────────────────────────────────────

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Eliminate pointing-pair digits from the row/col outside the box."""
        elims = [e for m in self._iter_matches(ctx) for e in m.eliminations]
        return RuleResult(eliminations=elims)

    # ── Hint interface ──────────────────────────────────────────────────────

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return one HintResult per (digit, line) match."""
        if not eliminations:
            return []
        return [self._build_hint(m) for m in self._iter_matches(ctx) if m.eliminations]
