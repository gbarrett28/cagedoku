"""R1a NakedSingle — recognise a cell reduced to a single candidate.

Fires on CELL_DETERMINED.  Returns no eliminations — the engine has
already reduced candidates[r][c] to a singleton.  This rule exists as
a named concept so the coaching layer can generate a placement hint:
"cell (r,c) has only one remaining candidate (d) — place d there."

Peer eliminations that follow placement are handled by CellSolutionElimination
(R1b), which fires on CELL_SOLVED after NakedSingle acknowledges the cell.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind


class NakedSingle:
    """R1a: named recognition of a cell determined by a single candidate."""

    name = "NakedSingle"
    priority = 0
    triggers: frozenset[Trigger] = frozenset({Trigger.CELL_DETERMINED})
    unit_kinds: frozenset[UnitKind] = frozenset()  # cell-scoped

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """No eliminations — recognition only.  Peer cleanup is R1b's job."""
        return []

    def compute_hints(self, board: BoardState) -> list[HintResult]:
        """Return one placement hint per naked single on the board.

        A placement hint tells the user to enter the sole remaining candidate
        in a cell.  Unlike elimination hints, placement hints do not require
        SolvedCellElimination to be hint-only — they remain useful even when
        peer eliminations have already been applied automatically.
        """
        hints: list[HintResult] = []
        for r in range(9):
            for c in range(9):
                if len(board.candidates[r][c]) != 1:
                    continue
                d = next(iter(board.candidates[r][c]))
                hints.append(
                    HintResult(
                        rule_name=self.name,
                        display_name="Naked Single",
                        explanation=(
                            f"Cell r{r + 1}c{c + 1} has only one remaining"
                            f" candidate: {d}. Place {d} there."
                        ),
                        highlight_cells=frozenset({(r, c)}),
                        eliminations=[],
                        placement=(r, c, d),
                    )
                )
        return hints
