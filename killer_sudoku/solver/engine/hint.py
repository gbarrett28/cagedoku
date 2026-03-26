"""HintResult: rich output from a solver rule in coach/hint mode.

A HintResult is *not* consumed by the engine.  It is produced on demand
for the coaching layer so the UI can highlight cells, explain the logic,
and offer the user a choice to apply or dismiss the deduction.
"""

from __future__ import annotations

import dataclasses
from typing import Protocol, runtime_checkable

from killer_sudoku.solver.engine.board_state import BoardState
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


@runtime_checkable
class HintableRule(Protocol):
    """A solver rule that can produce coaching hints."""

    name: str

    def compute_hints(self, board: BoardState) -> list[HintResult]:
        """Return all currently applicable hints for the given board state."""
        ...


def collect_hints(
    rules: list[HintableRule],
    board: BoardState,
    *,
    skip_names: set[str] | None = None,
) -> list[HintResult]:
    """Gather hints from all supplied rules, deduplicating by (cell, digit).

    Rules are queried in order; when the same (cell, digit) elimination is
    produced by multiple rules only the first explanation is kept.  If a hint's
    eliminations are entirely covered by earlier rules it is dropped.

    Args:
        rules:      Ordered list of hint-producing rules to query.
        board:      Current board state.
        skip_names: Rule names to skip (e.g. always-apply rules whose
                    eliminations are already on the board).

    Returns:
        Deduplicated list of HintResult, preserving original hint order.
    """
    skip = skip_names or set()
    seen: set[tuple[Cell, int]] = set()
    results: list[HintResult] = []
    for rule in rules:
        if rule.name in skip:
            continue
        for h in rule.compute_hints(board):
            new_elims = [e for e in h.eliminations if (e.cell, e.digit) not in seen]
            if not new_elims:
                continue
            for e in new_elims:
                seen.add((e.cell, e.digit))
            results.append(
                HintResult(
                    rule_name=h.rule_name,
                    display_name=h.display_name,
                    explanation=h.explanation,
                    highlight_cells=h.highlight_cells,
                    eliminations=new_elims,
                )
            )
    return results
