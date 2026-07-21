"""R3 CageIntersection — must-contain digit confined to a row/col/box.

When all remaining cage solutions require digit d, and every cell within the
cage that can currently hold d lies in the same row, column, or box, then d
must be placed somewhere in that unit via this cage.  It can therefore be
eliminated from all other cells in that unit outside the cage.

This is the cage-first counterpart to LockedCandidates (unit-first): the
cage drives the confinement, and the shared unit receives the elimination.

Example: a cage must contain 7 (it appears in every remaining solution).
The only cells in the cage that still have 7 as a candidate are r1c4 and
r1c5 — both in row 1.  Therefore 7 can be removed from every other cell in
row 1 that is not part of this cage.

Fires on COUNT_DECREASED and SOLUTION_PRUNED for CAGE units.
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
    """One firing of CageIntersection: a digit d locked to a single unit."""

    digit: int
    cage_unit: Unit
    carriers: frozenset[Cell]  # cage cells that currently hold d
    shared_unit: Unit
    eliminations: list[Elimination]


@hintable_rule
class CageIntersection:
    """R3: cage must-contain digit confined to one row/col/box — eliminate outside."""

    name = "CageIntersection"
    description = (
        "When a cage's required digit is confined to cells that all lie in one row, "
        "column, or box, that digit can be removed from other cells in that unit."
    )
    priority = 2
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.CAGE})

    # ── internal helpers ────────────────────────────────────────────────────

    @staticmethod
    def _iter_matches(ctx: RuleContext) -> Iterator[_Match]:
        """Yield one _Match per (digit, shared-unit) pair that fires the rule.

        Skips non-burb virtual cages (distinct_digits=False): their must-sets
        are derived from sol_sums which assumes distinct digits — not guaranteed
        for cells spanning multiple units — so over-elimination is possible.
        """
        assert ctx.unit is not None
        if not ctx.unit.distinct_digits:
            return
        cage_cells = ctx.unit.cells
        board: BoardState = ctx.board
        cage_idx = ctx.unit.unit_id - 27
        solns = board.cage_solns[cage_idx]
        if not solns:
            return

        must: set[int] = set(solns[0])
        for s in solns[1:]:
            must &= s

        for d in must:
            carriers: list[Cell] = [
                (r, c) for r, c in cage_cells if d in board.candidates[r][c]
            ]
            if not carriers:
                continue

            # Collect the intersection of non-cage units shared by every carrier.
            shared: set[int] | None = None
            for r, c in carriers:
                non_cage = {
                    uid
                    for uid in board.cell_unit_ids(r, c)
                    if board.units[uid].kind != UnitKind.CAGE
                }
                if shared is None:
                    shared = non_cage
                else:
                    shared &= non_cage
                if not shared:
                    break

            if not shared:
                continue

            for uid in shared:
                elims = [
                    Elimination(cell=(r, c), digit=d)
                    for r, c in board.units[uid].cells
                    if (r, c) not in cage_cells and d in board.candidates[r][c]
                ]
                if elims:
                    yield _Match(
                        digit=d,
                        cage_unit=ctx.unit,
                        carriers=frozenset(carriers),
                        shared_unit=board.units[uid],
                        eliminations=elims,
                    )

    @staticmethod
    def _build_hint(m: _Match) -> HintResult:
        """Construct a HintResult from a confirmed _Match."""
        d = m.digit
        cage_labels = ", ".join(sorted(cell_label(c) for c in m.cage_unit.cells))
        carriers_str = ", ".join(sorted(cell_label(c) for c in m.carriers))
        unit_lbl = unit_label(m.shared_unit)
        elim_cells_str = ", ".join(sorted(cell_label(e.cell) for e in m.eliminations))

        explanation = (
            f"Cage [{cage_labels}] must contain {d} in every remaining solution. "
            f"The only cells in this cage that can currently hold {d} are "
            f"{carriers_str} — all within {unit_lbl}. "
            f"Since {d} must appear in the cage and all its candidates are locked to "
            f"{unit_lbl}, {d} can be eliminated from {elim_cells_str} "
            f"(the other cells in {unit_lbl} outside the cage)."
        )

        return HintResult(
            rule_name="CageIntersection",
            display_name="Cage Intersection",
            explanation=explanation,
            highlight_cells=m.carriers | {e.cell for e in m.eliminations},
            eliminations=m.eliminations,
        )

    # ── SolverRule protocol ─────────────────────────────────────────────────

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Eliminate d from external cells when all cage d-candidates share a unit.

        Non-burb virtual cages are skipped.  Deduplicates across multiple
        shared units (a carrier set may be in both a row and a box).
        """
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
        """Return one HintResult per distinct (digit, shared-unit) match.

        Multiple matches for the same eliminations are deduplicated by tracking
        which (cell, digit) pairs have already been explained.
        """
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
