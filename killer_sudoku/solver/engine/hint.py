"""HintResult: rich output from a solver rule in coach/hint mode.

A HintResult is produced by rule.as_hints() when the rule fires in hint-only
mode.  It is buffered in engine.pending_hints and read by the coaching API.
"""

from __future__ import annotations

import dataclasses

from killer_sudoku.solver.engine.types import Cell, Elimination


@dataclasses.dataclass(frozen=True)
class HintResult:
    """Rich hint produced by a single rule application instance.

    Attributes:
        rule_name:               Internal rule identifier (e.g. "MustContainOutie").
        display_name:            Short human-readable name shown in the hint list.
        explanation:             Full plain-English explanation of why the rule fires,
                                 with cell coordinates in rNcM (1-based) notation.
        highlight_cells:         Every cell involved in the reasoning — used for
                                 canvas highlighting.  Cage cells, the external
                                 qualifying cell, and the outie are all included.
        eliminations:            The candidate removals this rule would make.
        placement:               (row, col, digit) if this hint is a placement hint
                                 rather than an elimination hint.  Placement hints
                                 instruct the user to enter a digit in a cell rather
                                 than remove a candidate.  When set, eliminations is
                                 typically empty.
        virtual_cage_suggestion: (cells, total) if this hint is a T3 virtual cage
                                 suggestion.  The hint recommends the user add this
                                 derived sum constraint via POST /virtual-cages.
                                 When set, eliminations is empty and placement is None.
    """

    rule_name: str
    display_name: str
    explanation: str
    highlight_cells: frozenset[Cell]
    eliminations: list[Elimination]
    placement: tuple[int, int, int] | None = None
    virtual_cage_suggestion: tuple[frozenset[Cell], int] | None = None

    @property
    def elimination_count(self) -> int:
        """Number of candidate removals this hint would produce."""
        return len(self.eliminations)
