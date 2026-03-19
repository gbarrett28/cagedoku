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
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind
from killer_sudoku.solver.engine.work_queue import SolverQueue
from killer_sudoku.solver.equation import sol_sums

if TYPE_CHECKING:
    from killer_sudoku.solver.engine.types import BoardEvent


def _filter_sum_range(
    cells: list[Cell],
    total: int,
    candidates: list[list[set[int]]],
) -> list[Elimination]:
    """Return eliminations for a non-burb sum constraint using range filtering.

    For each cell and each candidate digit, checks whether the digit can
    participate in an assignment summing to total given the current candidate
    ranges of the other cells.  Does NOT assume digit distinctness — safe for
    non-burb cell sets where cells may legally share a digit.
    """
    elims: list[Elimination] = []
    for i, (r, c) in enumerate(cells):
        others = [cells[j] for j in range(len(cells)) if j != i]
        min_others = sum(
            min(candidates[or_][oc]) for or_, oc in others if candidates[or_][oc]
        )
        max_others = sum(
            max(candidates[or_][oc]) for or_, oc in others if candidates[or_][oc]
        )
        for d in list(candidates[r][c]):
            if not (min_others + d <= total <= max_others + d):
                elims.append(Elimination(cell=(r, c), digit=d))
    return elims


def _filter_sum_constraint(
    cells: list[Cell],
    total: int,
    candidates: list[list[set[int]]],
) -> list[Elimination]:
    """Return eliminations for a newly-derived burb sum constraint.

    Computes all k-digit combinations summing to total (via sol_sums), maps
    each against current candidates using backtracking, and eliminates any
    (cell, digit) pair absent from every feasible assignment.

    Only call this for burb cell sets (single row/col/box), which guarantee
    digit distinctness — the required precondition for sol_sums.
    """
    solns = sol_sums(len(cells), 0, total)
    if not solns:
        return []

    # Sort most-constrained first for backtracking efficiency
    cand_union = frozenset().union(*solns)
    sorted_cells = sorted(
        cells, key=lambda rc: len(candidates[rc[0]][rc[1]] & cand_union)
    )

    per_cell_possible: dict[Cell, set[int]] = {c: set() for c in cells}

    def _bt(idx: int, remaining: set[int]) -> bool:
        if idx == len(sorted_cells):
            return True
        r, c = sorted_cells[idx]
        found = False
        for d in list(candidates[r][c] & remaining):
            remaining.discard(d)
            if _bt(idx + 1, remaining):
                per_cell_possible[(r, c)].add(d)
                found = True
            remaining.add(d)
        return found

    for soln in solns:
        _bt(0, set(soln))

    elims: list[Elimination] = []
    for cell in cells:
        r, c = cell
        for d in list(candidates[r][c]):
            if d not in per_cell_possible.get(cell, set()):
                elims.append(Elimination(cell=cell, digit=d))
    return elims


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
        """Route BoardEvents to the work queue; handle LinearSystem substitution.

        GLOBAL rules are re-scheduled on every board change so they get another
        pass after lower-priority rules have reduced the candidate set further.
        The deduplication in enqueue_global ensures at most one pending entry
        per rule at any time.
        """
        for event in events:
            if event.trigger == Trigger.CELL_DETERMINED:
                cell = event.payload
                assert isinstance(cell, tuple)
                val = event.hint_digit
                assert val is not None
                # Propagate through LinearSystem delta pairs (substitute known value)
                new_elims = self.board.linear_system.substitute_cell(cell, val)
                if new_elims:
                    self.apply_eliminations(new_elims)
                # Dynamic RREF: reduce live rows and emit new sum constraints.
                # This replicates the old solver's reduce_equns feedback loop:
                # each determined cell can tighten multi-cell sum equations,
                # producing new virtual cage constraints not derivable at startup.
                new_constraints = self.board.linear_system.substitute_live_rows(
                    cell, val
                )
                for vcells, vtotal, distinct in new_constraints:
                    cell_list = list(vcells)
                    if len(cell_list) == 1:
                        # Single-cell constraint: directly determine the cell
                        lone = cell_list[0]
                        lr, lc = lone
                        for d in range(1, 10):
                            if d != vtotal and d in self.board.candidates[lr][lc]:
                                self.apply_eliminations(
                                    [Elimination(cell=lone, digit=d)]
                                )
                    elif distinct:
                        # Burb sum constraint: full sol_sums backtracking filter
                        sum_elims = _filter_sum_constraint(
                            cell_list, vtotal, self.board.candidates
                        )
                        if sum_elims:
                            self.apply_eliminations(sum_elims)
                    else:
                        # Non-burb sum constraint: range-only filter (no distinctness)
                        sum_elims = _filter_sum_range(
                            cell_list, vtotal, self.board.candidates
                        )
                        if sum_elims:
                            self.apply_eliminations(sum_elims)
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

            # Re-schedule all GLOBAL rules whenever the board changes so they
            # can exploit new patterns created by lower-priority rule cascades.
            for rule in self._trigger_map[Trigger.GLOBAL]:
                self.queue.enqueue_global(rule.priority, rule)

    def _seed_initial_state(self) -> None:
        """Enqueue rules for all units to process the initial puzzle state.

        The engine is event-driven: rules only fire in response to candidate
        removals. Without this seed, puzzles with no LinearSystem initial
        eliminations would never trigger any rule. Seeding with unit_version=-1
        ensures no item is ever considered stale (unit_versions start at 0).

        Only COUNT_DECREASED and SOLUTION_PRUNED triggers are seeded. Triggers
        that require a specific hint_digit (COUNT_HIT_ONE, COUNT_HIT_TWO) and
        cell-level triggers (CELL_DETERMINED, GLOBAL) are not seeded here — they
        fire naturally as eliminations propagate from the seeded rules.
        """
        seed_triggers = frozenset({Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED})
        for unit in self.board.units:
            for trigger in seed_triggers:
                for rule in self._trigger_map[trigger]:
                    if not rule.unit_kinds or unit.kind in rule.unit_kinds:
                        self.queue.enqueue_unit(
                            rule.priority,
                            rule,
                            unit.unit_id,
                            -1,
                            trigger,
                            None,
                        )

    def solve(self) -> BoardState:
        """Run the main loop until no progress remains. Return the board state."""
        # Seed all rules for all matching units (initial state propagation)
        self._seed_initial_state()
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
