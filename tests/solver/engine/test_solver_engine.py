"""Tests for SolverEngine."""

from killer_sudoku.solver.engine import solve
from killer_sudoku.solver.engine.board_state import (
    BoardState,
    apply_initial_eliminations,
)
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules import default_rules
from killer_sudoku.solver.engine.solver_engine import SolverEngine
from killer_sudoku.solver.engine.types import Elimination, RuleResult, Trigger, UnitKind
from tests.fixtures.minimal_puzzle import KNOWN_SOLUTION, make_trivial_spec


def test_engine_init_no_crash() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    engine = SolverEngine(bs, rules=[])
    assert engine is not None


def test_engine_solve_trivial_empty_rules() -> None:
    """With no rules, trivial puzzle solved entirely by initial eliminations."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    apply_initial_eliminations(bs)
    engine = SolverEngine(bs, rules=[])
    result = engine.solve()
    # All 81 cells should be determined (one candidate each)
    total = sum(len(bs.candidates[r][c]) for r in range(9) for c in range(9))
    assert total == 81
    assert result is bs


def test_engine_apply_eliminations_idempotent() -> None:
    """Eliminating a digit not in candidates is a no-op."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    engine = SolverEngine(bs, rules=[])
    # Try to remove digit 5 from (0,0) twice — second time is a no-op
    engine.apply_eliminations([Elimination(cell=(0, 0), digit=5)])
    before = frozenset(bs.candidates[0][0])
    engine.apply_eliminations([Elimination(cell=(0, 0), digit=5)])
    assert frozenset(bs.candidates[0][0]) == before


def test_engine_routes_events_to_rule() -> None:
    """A rule subscribed to COUNT_DECREASED is called when a candidate is removed."""
    calls: list[int] = []

    class _CountRule:
        name = "counter"
        priority = 5
        triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
        unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.ROW})

        def apply(self, ctx: RuleContext) -> RuleResult:
            calls.append(1)
            return RuleResult()

    spec = make_trivial_spec()
    bs = BoardState(spec)
    engine = SolverEngine(bs, rules=[_CountRule()])
    # Remove digit 5 from (0,0) — triggers COUNT_DECREASED on row 0
    engine.apply_eliminations([Elimination(cell=(0, 0), digit=5)])
    # Drain the queue
    engine.solve()
    assert len(calls) > 0


def test_engine_stats_recorded() -> None:
    """RuleStats.calls is incremented after rule fires."""

    class _NoopRule:
        name = "noop"
        priority = 5
        triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
        unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.ROW})

        def apply(self, ctx: RuleContext) -> RuleResult:
            return RuleResult()

    spec = make_trivial_spec()
    bs = BoardState(spec)
    rule = _NoopRule()
    engine = SolverEngine(bs, rules=[rule])
    engine.apply_eliminations([Elimination(cell=(0, 0), digit=5)])
    engine.solve()
    assert engine.stats["noop"].calls > 0


def test_engine_solves_trivial_with_rules() -> None:
    """Full solve() with default rules produces correct solution for trivial spec."""
    spec = make_trivial_spec()
    board = solve(spec)
    for r in range(9):
        for c in range(9):
            assert board.candidates[r][c] == {KNOWN_SOLUTION[r][c]}


def test_engine_bootstraps_without_initial_eliminations() -> None:
    """Engine makes progress even when LinearSystem yields no initial eliminations.

    Regression test for the bootstrapping gap: if initial_eliminations is empty
    the engine used to return immediately without processing any cage units.
    The fix seeds all rules for all matching units before the main loop.
    """
    spec = make_trivial_spec()
    board = BoardState(spec)
    # Clear LinearSystem eliminations to simulate a pure cage-driven start
    board.linear_system.initial_eliminations.clear()
    engine = SolverEngine(board, rules=default_rules())
    result = engine.solve()
    # Even without LinearSystem seeding, cage propagation should determine all cells
    for r in range(9):
        for c in range(9):
            assert result.candidates[r][c] == {KNOWN_SOLUTION[r][c]}, (
                f"Cell ({r},{c}) not determined: {result.candidates[r][c]}"
            )


def test_hint_rules_buffer_pending_hints() -> None:
    """Rules in hint_rules should populate pending_hints, not apply eliminations."""
    spec = make_trivial_spec()
    board = BoardState(spec)
    rules = default_rules()
    hint_rule_names = frozenset(r.name for r in rules)
    engine = SolverEngine(board, rules=rules, hint_rules=hint_rule_names)
    engine.solve()
    assert isinstance(engine.pending_hints, list)


def test_hint_rules_empty_means_all_drain() -> None:
    """With hint_rules=frozenset(), the engine behaves as before — no pending hints."""
    spec = make_trivial_spec()
    board = BoardState(spec)
    engine = SolverEngine(board, rules=default_rules(), hint_rules=frozenset())
    engine.solve()
    assert engine.pending_hints == []
