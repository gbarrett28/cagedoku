"""Tests for RuleStats."""

from killer_sudoku.solver.engine.rule import RuleStats
from killer_sudoku.solver.engine.types import Elimination


def test_rulestats_hit_rate_zero_calls() -> None:
    s = RuleStats()
    assert s.hit_rate == 0.0


def test_rulestats_hit_rate() -> None:
    s = RuleStats(calls=4, progress=2, eliminations=5, elapsed_ns=1000)
    assert s.hit_rate == 0.5


def test_rulestats_utility() -> None:
    s = RuleStats(calls=2, progress=2, eliminations=4, elapsed_ns=2000)
    # utility = (4/2) / (2000/2) = 2.0 / 1000.0 = 0.002
    assert abs(s.utility - 0.002) < 1e-9


def test_rulestats_record() -> None:
    s = RuleStats()
    s.record([Elimination(cell=(0, 0), digit=5)], elapsed_ns=500)
    assert s.calls == 1
    assert s.progress == 1
    assert s.eliminations == 1
    assert s.elapsed_ns == 500
