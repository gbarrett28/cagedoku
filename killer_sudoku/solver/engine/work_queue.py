"""WorkItem and SolverQueue — priority queue with deduplication and version tracking.

WorkItem has three forms:
- Unit-scoped (all triggers except CELL_DETERMINED, CELL_SOLVED, and GLOBAL):
    carries unit_id and unit_version for staleness detection
- Cell-scoped (CELL_DETERMINED and CELL_SOLVED):
    carries cell; never version-skipped
- GLOBAL (no unit or cell):
    never version-skipped

Deduplication keys:
- Unit-scoped: (id(rule), unit_id)  — one item per rule/unit pair
- Cell-scoped: (id(rule), cell)     — one item per rule/cell pair
- GLOBAL:      (id(rule),)           — one item per GLOBAL rule
"""

from __future__ import annotations

import dataclasses
import heapq
from typing import Any

from killer_sudoku.solver.engine.rule import SolverRule
from killer_sudoku.solver.engine.types import Cell, Trigger


@dataclasses.dataclass
class WorkItem:
    """A single unit of work for the solver engine main loop."""

    priority: int
    rule: SolverRule
    unit_id: int | None
    unit_version: int | None  # snapshot of board.unit_versions[unit_id] at enqueue
    cell: Cell | None
    trigger: Trigger
    hint_digit: int | None

    def dedup_key(self) -> tuple[Any, ...]:
        """Key used to identify duplicate items in the queue."""
        if self.trigger in (Trigger.CELL_DETERMINED, Trigger.CELL_SOLVED):
            return (id(self.rule), self.cell)
        if self.trigger == Trigger.GLOBAL:
            return (id(self.rule),)
        return (id(self.rule), self.unit_id)

    def is_stale(self, unit_versions: list[int]) -> bool:
        """True if no candidate was removed in this unit since enqueue.

        Cell-scoped (CELL_DETERMINED, CELL_SOLVED) and GLOBAL items are never
        stale — they represent a specific event (not a unit state) and must
        always be processed.
        """
        cell_scoped = (Trigger.CELL_DETERMINED, Trigger.CELL_SOLVED)
        if self.trigger in cell_scoped or self.trigger == Trigger.GLOBAL:
            return False
        if self.unit_id is None or self.unit_version is None:
            return False
        return unit_versions[self.unit_id] == self.unit_version

    def __lt__(self, other: WorkItem) -> bool:
        return (self.priority, self.rule.name) < (other.priority, other.rule.name)


class SolverQueue:
    """Min-heap priority queue with O(1) deduplication.

    When the same (rule, unit_id) pair is enqueued twice, the item with the
    lower priority wins; the newer trigger/hint replaces the older one.
    Superseded entries remain in the heap as ghosts and are discarded on pop.
    """

    def __init__(self) -> None:
        self._heap: list[WorkItem] = []
        # dedup_key -> best priority currently live in the queue
        self._best: dict[tuple[Any, ...], int] = {}

    def enqueue_unit(
        self,
        priority: int,
        rule: SolverRule,
        unit_id: int,
        unit_version: int,
        trigger: Trigger,
        hint_digit: int | None,
    ) -> None:
        """Enqueue a unit-scoped work item with deduplication."""
        key = (id(rule), unit_id)
        existing = self._best.get(key)
        if existing is not None and existing <= priority:
            return  # already have a better or equal item
        self._best[key] = priority
        heapq.heappush(
            self._heap,
            WorkItem(priority, rule, unit_id, unit_version, None, trigger, hint_digit),
        )

    def enqueue_cell(
        self,
        priority: int,
        rule: SolverRule,
        cell: Cell,
        trigger: Trigger,
        hint_digit: int | None,
    ) -> None:
        """Enqueue a cell-scoped work item with deduplication."""
        key = (id(rule), cell)
        if key in self._best:
            return  # already queued for this cell
        self._best[key] = priority
        heapq.heappush(
            self._heap,
            WorkItem(priority, rule, None, None, cell, trigger, hint_digit),
        )

    def enqueue_global(self, priority: int, rule: SolverRule) -> None:
        """Enqueue a GLOBAL work item — at most one per rule at a time."""
        key = (id(rule),)
        if key in self._best:
            return
        self._best[key] = priority
        heapq.heappush(
            self._heap,
            WorkItem(priority, rule, None, None, None, Trigger.GLOBAL, None),
        )

    def pop(self) -> WorkItem:
        """Pop the lowest-priority live item. Discards superseded ghosts."""
        while self._heap:
            item = heapq.heappop(self._heap)
            key = item.dedup_key()
            if self._best.get(key) == item.priority:
                del self._best[key]
                return item
        raise IndexError("pop from empty SolverQueue")

    def empty(self) -> bool:
        """True if no live items remain in the queue."""
        return len(self._best) == 0
