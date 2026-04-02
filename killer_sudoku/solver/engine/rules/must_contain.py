"""R5 MustContain — cage must-contain digits confined to an overlap region.

When a cage's must-contain digits can only be placed in cells that all lie
within a shared row/col/box, those digits are eliminated from the rest of
that row/col/box outside the cage.

This fires on a row/col/box unit trigger: the unit finds overlapping cages
whose confined must-contain digits can be eliminated from the unit.

Relationship to CageIntersection (R3): both rules express that a cage digit
is locked to a row/col/box intersection. The difference is the trigger:
- CageIntersection fires on the CAGE unit — cage-first.
- MustContain fires on a ROW/COL/BOX unit — unit-first.
In practice they cover slightly different board states depending on which
event queue fires first. Having both improves propagation efficiency.

Fires on COUNT_DECREASED for ROW, COL, BOX, and CAGE units.
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
    """One firing of MustContain."""

    unit: Unit  # the row/col/box/cage triggering unit
    cage_unit: Unit  # the cage whose confined digits fire
    overlap: frozenset[Cell]
    confined_digits: frozenset[int]  # must-contain digits available only in overlap
    eliminations: list[Elimination]


@hintable_rule
class MustContain:
    """R5: cage must-contain digits confined to overlap → eliminate from unit."""

    name = "MustContain"
    priority = 4
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    # ── internal helpers ────────────────────────────────────────────────────

    @staticmethod
    def _iter_matches(ctx: RuleContext) -> Iterator[_Match]:
        """Yield one _Match per (cage, confined-digit-set) pair that fires.

        Non-burb virtual cages (distinct_digits=False) are skipped as the
        triggering unit: eliminating from their cells via real-cage must-sets
        is unsound because those cells span multiple units and can share digits.
        Non-burb cages still contribute as the *overlapping* cage when a real
        unit fires — in that direction the logic is safe.
        """
        assert ctx.unit is not None
        if not ctx.unit.distinct_digits:
            return
        board: BoardState = ctx.board
        unit_cells = ctx.unit.cells
        seen_cage_ids: set[int] = set()

        for r, c in unit_cells:
            for uid in board.cell_unit_ids(r, c):
                other = board.units[uid]
                if other.kind != UnitKind.CAGE:
                    continue
                cage_idx = other.unit_id - 27
                if cage_idx in seen_cage_ids:
                    continue
                seen_cage_ids.add(cage_idx)

                overlap = unit_cells & other.cells
                if not overlap or overlap == unit_cells:
                    continue

                # Digits available outside the overlap inside the cage
                other_elsewhere: set[int] = set()
                for cr, cc in other.cells - overlap:
                    other_elsewhere |= board.candidates[cr][cc]

                # must_other: digits every remaining solution requires
                solns = board.cage_solns[cage_idx]
                if not solns:
                    continue
                must_other: set[int] = set(solns[0])
                for s in solns[1:]:
                    must_other &= s

                # Confined: must-contain digits unavailable elsewhere in the cage
                confined = must_other - other_elsewhere
                if not confined:
                    continue

                elims = [
                    Elimination(cell=(er, ec), digit=d)
                    for er, ec in unit_cells - overlap
                    for d in confined
                    if d in board.candidates[er][ec]
                ]
                if elims:
                    yield _Match(
                        unit=ctx.unit,
                        cage_unit=other,
                        overlap=overlap,
                        confined_digits=frozenset(confined),
                        eliminations=elims,
                    )

    @staticmethod
    def _build_hint(m: _Match) -> HintResult:
        """Construct a HintResult from a confirmed _Match."""
        cage_labels = ", ".join(sorted(cell_label(c) for c in m.cage_unit.cells))
        overlap_str = ", ".join(sorted(cell_label(c) for c in m.overlap))
        unit_lbl = unit_label(m.unit)
        digits_str = (
            str(next(iter(m.confined_digits)))
            if len(m.confined_digits) == 1
            else "{" + ", ".join(str(d) for d in sorted(m.confined_digits)) + "}"
        )
        elim_cells_str = ", ".join(sorted(cell_label(e.cell) for e in m.eliminations))

        explanation = (
            f"Cage [{cage_labels}] must contain {digits_str} in every remaining "
            f"solution, and those digits can only be placed within the cage at "
            f"{overlap_str} — the intersection with {unit_lbl}. "
            f"Since {digits_str} must appear in the cage and is confined to "
            f"{unit_lbl}, it can be eliminated from {elim_cells_str} "
            f"(the other cells in {unit_lbl} outside the cage)."
        )

        return HintResult(
            rule_name="MustContain",
            display_name="Must Contain",
            explanation=explanation,
            highlight_cells=m.overlap | {e.cell for e in m.eliminations},
            eliminations=m.eliminations,
        )

    # ── SolverRule protocol ─────────────────────────────────────────────────

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Eliminate confined must-contain digits from the unit outside the overlap."""
        elims = [e for m in self._iter_matches(ctx) for e in m.eliminations]
        return RuleResult(eliminations=elims)

    # ── Hint interface ──────────────────────────────────────────────────────

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return one HintResult per (cage, confined-digit-set) match."""
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
