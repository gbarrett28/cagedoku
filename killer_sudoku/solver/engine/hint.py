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
        placement:       (row, col, digit) if this hint is a placement hint
                         rather than an elimination hint.  Placement hints
                         instruct the user to enter a digit in a cell rather
                         than remove a candidate.  When set, eliminations is
                         typically empty.
    """

    rule_name: str
    display_name: str
    explanation: str
    highlight_cells: frozenset[Cell]
    eliminations: list[Elimination]
    placement: tuple[int, int, int] | None = None

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

    Placement hints (hint.placement is not None) are passed through even when
    their eliminations list is empty — they instruct the user to enter a digit
    rather than remove a candidate.  Duplicate placements (same row/col/digit)
    are deduplicated across rules.

    Args:
        rules:      Ordered list of hint-producing rules to query.
        board:      Current board state.
        skip_names: Rule names to skip (e.g. always-apply rules whose
                    eliminations are already on the board).

    Returns:
        Deduplicated list of HintResult, preserving original hint order.
    """
    skip = skip_names or set()
    seen_elims: set[tuple[Cell, int]] = set()
    seen_placements: set[tuple[int, int, int]] = set()
    results: list[HintResult] = []
    for rule in rules:
        if rule.name in skip:
            continue
        for h in rule.compute_hints(board):
            new_elims = [
                e for e in h.eliminations if (e.cell, e.digit) not in seen_elims
            ]
            is_placement = h.placement is not None
            if not new_elims and not is_placement:
                continue
            if is_placement:
                assert h.placement is not None
                if h.placement in seen_placements:
                    continue
                seen_placements.add(h.placement)
            for e in new_elims:
                seen_elims.add((e.cell, e.digit))
            results.append(
                HintResult(
                    rule_name=h.rule_name,
                    display_name=h.display_name,
                    explanation=h.explanation,
                    highlight_cells=h.highlight_cells,
                    eliminations=new_elims,
                    placement=h.placement,
                )
            )
    return results
