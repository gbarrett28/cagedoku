"""Tests for SolverEngine."""

from killer_sudoku.solver.engine.board_state import (
    BoardState,
    apply_initial_eliminations,
)
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.solver_engine import SolverEngine
from killer_sudoku.solver.engine.types import Elimination, Trigger, UnitKind
from tests.fixtures.minimal_puzzle import make_trivial_spec


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

        def apply(self, ctx: RuleContext) -> list[Elimination]:
            calls.append(1)
            return []

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

        def apply(self, ctx: RuleContext) -> list[Elimination]:
            return []

    spec = make_trivial_spec()
    bs = BoardState(spec)
    rule = _NoopRule()
    engine = SolverEngine(bs, rules=[rule])
    engine.apply_eliminations([Elimination(cell=(0, 0), digit=5)])
    engine.solve()
    assert engine.stats["noop"].calls > 0
