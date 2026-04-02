"""R2 HiddenSingle â a digit with count=1 in a unit must go in that one cell.

Fires on COUNT_HIT_ONE. hint_digit narrows search to the triggered digit.
Returns Eliminations removing all other candidates from the sole remaining cell.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind


class HiddenSingle:
    """R2: when exactly one cell in a unit can hold a digit, place it there.

    For ROW, COL, and BOX units: every digit 1-9 appears exactly once, so
    count=1 for digit d forces the sole remaining cell to d.

    For CAGE units: the rule is stricter. count=1 is necessary but not
    sufficient â d must also appear in EVERY feasible cage solution. If any
    solution omits d, d is not required in the cage and cannot be forced.
    """

    name = "HiddenSingle"
    priority = 1
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_HIT_ONE})
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Find the sole cell that can hold hint_digit; eliminate all others from it."""
        assert ctx.unit is not None
        assert ctx.hint_digit is not None
        d = ctx.hint_digit

        # For CAGE units, d is only forced if it appears in ALL feasible solutions.
        # Count=1 alone is insufficient: d may not be required in the cage at all.
        # Non-burb virtual cages (distinct_digits=False) are always skipped: their
        # sol_sums assume distinct digits which is not guaranteed, so their must
        # sets are unreliable and cannot be used to force cell assignments.
        if ctx.unit.kind == UnitKind.CAGE:
            if not ctx.unit.distinct_digits:
                return RuleResult()
            cage_idx = ctx.unit.unit_id - 27
            solns = ctx.board.cage_solns[cage_idx]
            if not solns or not all(d in soln for soln in solns):
                return RuleResult()

        sole = next(
            ((r, c) for r, c in ctx.unit.cells if d in ctx.board.candidates[r][c]),
            None,
        )
        if sole is None:
            return RuleResult()
        r, c = sole
        return RuleResult(
            eliminations=[
                Elimination(cell=(r, c), digit=other)
                for other in ctx.board.candidates[r][c]
                if other != d
            ]
        )

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
