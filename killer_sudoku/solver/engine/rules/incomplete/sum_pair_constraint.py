"""SumPairConstraint: narrow candidates using additive 2-cell sum constraints."""

from __future__ import annotations

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import (
    Cell,
    Elimination,
    RuleResult,
    Trigger,
    UnitKind,
)


class SumPairConstraint:
    """R7: narrow candidates using linear sum constraints.

    When two cells a and b satisfy a + b = total (a sum pair derived from
    complementary RREF rows), any candidate d for a is invalid if (total - d)
    is not in b's candidate set, and vice versa.

    Unlike delta pairs, sum pairs do not enforce digit distinctness â the two
    cells are typically non-burb (not in the same row/col/box), so repeated
    digits are permitted by the puzzle rules.  The standard uniqueness rules
    handle distinctness for burb cells independently.

    CELL_DETERMINED is handled by LinearSystem.substitute_cell, which forces
    the partner cell directly; this rule handles COUNT_DECREASED filtering.
    """

    name = "SumPairConstraint"
    priority = 5
    triggers: frozenset[Trigger] = frozenset(
        {Trigger.COUNT_DECREASED, Trigger.CELL_DETERMINED}
    )
    unit_kinds: frozenset[UnitKind] = frozenset(
        {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}
    )

    def apply(self, ctx: RuleContext) -> RuleResult:
        """Narrow candidate sets using active sum pairs touching this unit."""
        if ctx.hint == Trigger.CELL_DETERMINED:
            return RuleResult()

        assert ctx.unit is not None
        board = ctx.board
        elims: list[Elimination] = []
        seen: set[tuple[Cell, Cell, int]] = set()

        for r, c in ctx.unit.cells:
            for pair in board.linear_system._sum_pairs_by_cell.get((r, c), []):
                if pair in seen:
                    continue
                seen.add(pair)
                a, b, total = pair
                ar, ac = a
                br, bc = b
                # a candidates: keep d only if (total - d) is in b's candidates
                valid_a = {
                    total - m for m in board.candidates[br][bc] if 1 <= total - m <= 9
                }
                for d in list(board.candidates[ar][ac]):
                    if d not in valid_a:
                        elims.append(Elimination(cell=a, digit=d))
                # b candidates: keep d only if (total - d) is in a's candidates
                valid_b = {
                    total - m for m in board.candidates[ar][ac] if 1 <= total - m <= 9
                }
                for d in list(board.candidates[br][bc]):
                    if d not in valid_b:
                        elims.append(Elimination(cell=b, digit=d))
        return RuleResult(eliminations=elims)

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Return one hint per sum pair that would eliminate candidates.

        Each hint explains the algebraic sum constraint r{a}c{a} + r{b}c{b} = total
        and shows the resulting candidate eliminations.
        """
        if not eliminations:
            return []
        if ctx.hint == Trigger.CELL_DETERMINED:
            return []
        assert ctx.unit is not None
        board = ctx.board
        hints: list[HintResult] = []
        seen: set[tuple[Cell, Cell, int]] = set()

        for r, c in ctx.unit.cells:
            for pair in board.linear_system._sum_pairs_by_cell.get((r, c), []):
                if pair in seen:
                    continue
                seen.add(pair)
                a, b, total = pair
                ar, ac = a
                br, bc = b

                pair_elims: list[Elimination] = []
                valid_a = {
                    total - m for m in board.candidates[br][bc] if 1 <= total - m <= 9
                }
                for d in board.candidates[ar][ac]:
                    if d not in valid_a:
                        pair_elims.append(Elimination(cell=a, digit=d))
                valid_b = {
                    total - m for m in board.candidates[ar][ac] if 1 <= total - m <= 9
                }
                for d in board.candidates[br][bc]:
                    if d not in valid_b:
                        pair_elims.append(Elimination(cell=b, digit=d))

                if not pair_elims:
                    continue

                hints.append(
                    HintResult(
                        rule_name=self.name,
                        display_name=(
                            f"Sum: r{ar + 1}c{ac + 1} + r{br + 1}c{bc + 1} = {total}"
                        ),
                        explanation=(
                            f"The cage-sum equations show r{ar + 1}c{ac + 1} "
                            f"+ r{br + 1}c{bc + 1} = {total}. "
                            f"Each cell's candidates must be consistent with the "
                            f"other's — any digit d is ruled out if ({total} \u2212 d) "
                            f"is not a candidate in the partner cell."
                        ),
                        highlight_cells=frozenset({a, b}),
                        eliminations=pair_elims,
                    )
                )
        return hints
