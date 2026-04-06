"""LinearElimination â apply cells determined algebraically by the linear system.

The LinearSystem solves the cage-sum equations by Gaussian elimination.
Where the system uniquely determines a cell's value (a single-variable row),
those cells are recorded as initial_eliminations.

This rule surfaces those determinations as a proper, toggleable rule so
the coaching layer can present them as hints and they are not silently
pre-applied in playing mode.

Fires as GLOBAL: runs whenever the engine's event queue is exhausted.
After the first pass the eliminations have been applied, so subsequent
firings return nothing.
"""

from __future__ import annotations

from typing import ClassVar

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules._registry import hintable_rule
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind


@hintable_rule
class LinearElimination:
    """Apply cells determined by the cage-sum linear system.

    Fires as GLOBAL: runs whenever the engine's event queue is exhausted.

    apply() returns initial_eliminations still present in the candidate sets.
    as_hints() returns:
      T1 — placement hints (one per uniquely-determined cell)
      T3 — virtual cage suggestion hints (for RREF-derived cages not yet
           registered by the user, size 2–3 cells only)
    T1 is preferred over T3 when both are present; stratification is handled
    by get_hints() in the API layer.
    """

    name = "LinearElimination"
    description = (
        "Uses linear equations derived from cage sums to eliminate impossible digit "
        "values from cells."
    )
    priority = 1
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()
    # BoardState must be constructed with include_virtual_cages=True for the
    # linear system to function.  _make_board_and_engine() reads this flag so
    # the rule name never needs to be hardcoded outside DEFAULT_ALWAYS_APPLY_RULES.
    requires_virtual_cages: ClassVar[bool] = True

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Return initial_eliminations still present in the candidate sets."""
        return RuleResult(
            eliminations=[
                e
                for e in ctx.board.linear_system.initial_eliminations
                if e.digit in ctx.board.candidates[e.cell[0]][e.cell[1]]
            ]
        )

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return T1 placement hints and T3 virtual cage suggestion hints.

        T1: for each cell uniquely determined by the linear system (all but
        one candidate is eliminated), return a placement hint.
        T3: for each RREF-derived virtual cage of size 2-3 not yet registered
        by the user, return a virtual cage suggestion hint.
        """
        hints: list[HintResult] = []
        hints.extend(self._t1_placement_hints(ctx, eliminations))
        hints.extend(self._t3_virtual_cage_hints(ctx))
        return hints

    def _t1_placement_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """One placement hint per cell uniquely determined by initial_eliminations."""
        if not eliminations:
            return []

        # Group pending eliminations by cell
        by_cell: dict[tuple[int, int], list[int]] = {}
        for e in eliminations:
            by_cell.setdefault(e.cell, []).append(e.digit)

        hints: list[HintResult] = []
        for cell, elim_digits in by_cell.items():
            r, c = cell
            remaining = ctx.board.candidates[r][c] - set(elim_digits)
            if len(remaining) != 1:
                continue  # multiple digits still open — not a clean placement
            digit = next(iter(remaining))
            hints.append(
                HintResult(
                    rule_name=self.name,
                    display_name=f"Algebra: r{r + 1}c{c + 1} = {digit}",
                    explanation=(
                        f"The cage-sum equations (combined with row, column and box "
                        f"totals) uniquely determine r{r + 1}c{c + 1} = {digit}."
                    ),
                    highlight_cells=frozenset({cell}),
                    eliminations=[e for e in eliminations if e.cell == cell],
                    placement=(r, c, digit),
                )
            )
        return hints

    def _t3_virtual_cage_hints(self, ctx: RuleContext) -> list[HintResult]:
        """One suggestion hint per RREF-derived virtual cage not yet registered."""
        # Cells in user-added virtual cage units (beyond the spec cages).
        # With include_virtual_cages=False (coaching mode), RREF-derived virtual
        # cage units are NOT added, so any CAGE unit beyond unit_id 26+n_cages
        # was added explicitly by the user via add_virtual_cage().
        n_spec_cages = int(ctx.board.regions.max()) + 1
        user_vc_threshold = 27 + n_spec_cages
        user_vc_cell_sets: set[frozenset[tuple[int, int]]] = {
            unit.cells for unit in ctx.board.units if unit.unit_id >= user_vc_threshold
        }

        hints: list[HintResult] = []
        for vcells, vtotal, distinct, _solns in ctx.board.linear_system.virtual_cages:
            if not distinct:
                continue  # non-burb VCs can't be added as distinct=True cages
            if len(vcells) > 3 or len(vcells) < 2:
                continue
            if vcells in user_vc_cell_sets:
                continue  # user already acknowledged this cage

            cell_labels = " + ".join(f"r{r + 1}c{c + 1}" for r, c in sorted(vcells))
            hints.append(
                HintResult(
                    rule_name=self.name,
                    display_name=f"Virtual cage: {len(vcells)} cells = {vtotal}",
                    explanation=(
                        f"The cage-sum equations imply {cell_labels} = {vtotal}. "
                        f"Adding this as a virtual cage will help narrow candidates."
                    ),
                    highlight_cells=vcells,
                    eliminations=[],
                    virtual_cage_suggestion=(vcells, vtotal),
                )
            )
        return hints
