"""HintResult: rich output from a solver rule in coach/hint mode.

A HintResult is *not* consumed by the engine.  It is produced on demand
for the coaching layer so the UI can highlight cells, explain the logic,
and offer the user a choice to apply or dismiss the deduction.
"""

from __future__ import annotations

import dataclasses

from killer_sudoku.solver.engine.types import Cell, Elimination


@dataclasses.dataclass(frozen=True)
class HintResult:
    """Rich hint produced by a single rule application instance.

    Attributes:
        rule_name:       Internal rule identifier (e.g. "MustContainOutie").
        display_name:    Short human-readable name shown in the hint list.
        explanation:     Full plain-English explanation of why the rule fires,
                         with cell coordinates in rNcM (1-based) notation.
        highlight_cells: Every cell involved in the reasoning — used for
                         canvas highlighting.  Cage cells, the external
                         qualifying cell, and the outie are all included.
        eliminations:    The candidate removals this rule would make.
    """

    rule_name: str
    display_name: str
    explanation: str
    highlight_cells: frozenset[Cell]
    eliminations: list[Elimination]

    @property
    def elimination_count(self) -> int:
        """Number of candidate removals this hint would produce."""
        return len(self.eliminations)
