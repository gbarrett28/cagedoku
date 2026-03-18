"""SolverEngine — main loop, apply_eliminations, trigger routing.

The engine builds a trigger → [rule] map at startup. apply_eliminations
routes BoardEvents to the work queue. The main loop pops items, skips
stale unit-scoped items via version tracking, calls rule.apply(), and
feeds returned Eliminations back through apply_eliminations.

GLOBAL rules (e.g. X-Wing) are processed through the same loop — there
is no separate run_global_rules function. When the queue contains only
GLOBAL items they are dequeued and applied normally; their eliminations
feed back into apply_eliminations to trigger further unit-scoped rules.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext, RuleStats, SolverRule
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind
from killer_sudoku.solver.engine.work_queue import SolverQueue

if TYPE_CHECKING:
    from killer_sudoku.solver.engine.types import BoardEvent


def _unit_kind(unit_id: int) -> UnitKind:
    """Determine the UnitKind from a global unit ID."""
    if unit_id < 9:
        return UnitKind.ROW
    if unit_id < 18:
        return UnitKind.COL
    if unit_id < 27:
        return UnitKind.BOX
    return UnitKind.CAGE


class SolverEngine:
    """Pull-with-dirty-tracking propagation engine.

    Constructs a trigger → [rule] map at startup. apply_eliminations routes
    BoardEvents to matching rules in the priority queue. The main loop pops
    work items, skips stale unit-scoped items, calls rule.apply(), and feeds
    eliminations back through apply_eliminations.
    """

    def __init__(self, board: BoardState, rules: list[SolverRule]) -> None:
        self.board = board
        self.queue: SolverQueue = SolverQueue()
        self.stats: dict[str, RuleStats] = {r.name: RuleStats() for r in rules}
        self._trigger_map: dict[Trigger, list[SolverRule]] = {t: [] for t in Trigger}
        for rule in rules:
            for trigger in rule.triggers:
                self._trigger_map[trigger].append(rule)

    def apply_eliminations(self, eliminations: list[Elimination]) -> None:
        """Apply eliminations to board and route resulting events to the queue.

        For CELL_DETERMINED events, also calls LinearSystem.substitute_cell
        to propagate delta-pair constraints and recursively applies any new
        eliminations produced.
        """
        for elim in eliminations:
            r, c = elim.cell
            if elim.digit not in self.board.candidates[r][c]:
                continue
            if len(self.board.candidates[r][c]) <= 1:
                continue  # would raise NoSolnError; digit not in cands anyway
            events = self.board.remove_candidate(r, c, elim.digit)
            self._route_events(events, r, c)

    def _route_events(self, events: list[BoardEvent], src_r: int, src_c: int) -> None:
        """Route BoardEvents to the work queue; handle LinearSystem substitution."""
        for event in events:
            if event.trigger == Trigger.CELL_DETERMINED:
                cell = event.payload
                assert isinstance(cell, tuple)
                val = event.hint_digit
                assert val is not None
                # Propagate through LinearSystem (substitute known value)
                new_elims = self.board.linear_system.substitute_cell(cell, val)
                if new_elims:
                    self.apply_eliminations(new_elims)
                # Route to CELL_DETERMINED rules
                for rule in self._trigger_map[Trigger.CELL_DETERMINED]:
                    self.queue.enqueue_cell(0, rule, cell, Trigger.CELL_DETERMINED, val)
            elif event.trigger == Trigger.SOLUTION_PRUNED:
                uid = event.payload
                assert isinstance(uid, int)
                for rule in self._trigger_map[Trigger.SOLUTION_PRUNED]:
                    self.queue.enqueue_unit(
                        rule.priority,
                        rule,
                        uid,
                        self.board.unit_versions[uid] - 1,
                        Trigger.SOLUTION_PRUNED,
                        None,
                    )
            else:
                uid = event.payload
                assert isinstance(uid, int)
                kind = _unit_kind(uid)
                for rule in self._trigger_map[event.trigger]:
                    if not rule.unit_kinds or kind in rule.unit_kinds:
                        self.queue.enqueue_unit(
                            rule.priority,
                            rule,
                            uid,
                            self.board.unit_versions[uid] - 1,
                            event.trigger,
                            event.hint_digit,
                        )

    def solve(self) -> BoardState:
        """Run the main loop until no progress remains. Return the board state."""
        # Enqueue GLOBAL sentinel for initial pass
        for rule in self._trigger_map[Trigger.GLOBAL]:
            self.queue.enqueue_global(rule.priority, rule)

        while not self.queue.empty():
            item = self.queue.pop()
            # CELL_DETERMINED and GLOBAL items are never version-skipped
            if item.is_stale(self.board.unit_versions):
                continue

            unit = self.board.units[item.unit_id] if item.unit_id is not None else None
            ctx = RuleContext(
                unit=unit,
                cell=item.cell,
                board=self.board,
                hint=item.trigger,
                hint_digit=item.hint_digit,
            )
            t0 = time.monotonic_ns()
            eliminations = item.rule.apply(ctx)
            elapsed = time.monotonic_ns() - t0
            self.stats[item.rule.name].record(eliminations, elapsed)
            if eliminations:
                self.apply_eliminations(eliminations)

        return self.board
