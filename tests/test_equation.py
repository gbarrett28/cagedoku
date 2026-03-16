"""Tests for killer_sudoku.solver.equation."""

import numpy as np
import numpy.typing as npt
import pytest

from killer_sudoku.solver.equation import (
    Equation,
    EquationConfig,
    NoSolnError,
    sol_sums,
)


class MockGrid:
    """Minimal GridLike stub for equation tests.

    Provides the single attribute (region) required by the GridLike protocol
    so that Equation can be constructed without a real Grid instance.
    """

    def __init__(self) -> None:
        self.region: npt.NDArray[np.intp] = np.ones((9, 9), dtype=np.intp)


# ---------------------------------------------------------------------------
# sol_sums
# ---------------------------------------------------------------------------


def test_sol_sums_known_values() -> None:
    """sol_sums returns the correct frozenset list for well-known cage totals."""
    assert sol_sums(1, 0, 5) == [frozenset({5})]
    assert sol_sums(2, 0, 3) == [frozenset({1, 2})]
    assert sol_sums(3, 0, 6) == [frozenset({1, 2, 3})]
    assert sol_sums(2, 0, 17) == [frozenset({8, 9})]
    # Impossible: single digit cannot exceed 9
    assert sol_sums(1, 0, 10) == []
    # Impossible: minimum 2-cell sum is 1+2=3
    assert sol_sums(2, 0, 2) == []


def test_sol_sums_returns_frozensets() -> None:
    """Every element returned by sol_sums is a frozenset."""
    results = sol_sums(3, 0, 15)
    assert all(isinstance(s, frozenset) for s in results)
    assert len(results) > 0


# ---------------------------------------------------------------------------
# Equation construction
# ---------------------------------------------------------------------------


def test_equation_init() -> None:
    """Equation initialises with correct value, solutions, must and poss sets."""
    grid = MockGrid()
    e = Equation({(0, 0)}, 5, grid)
    assert e.v == 5
    assert len(e.solns) == 1
    assert e.must == {5}
    assert e.poss == {5}


def test_equation_empty_raises() -> None:
    """Equation raises ValueError when constructed with an empty cell set."""
    grid = MockGrid()
    with pytest.raises(ValueError):
        Equation(set(), 5, grid)


# ---------------------------------------------------------------------------
# Equation.avoid
# ---------------------------------------------------------------------------


def test_equation_avoid_eliminates() -> None:
    """avoid() removes solutions that intersect the forbidden digit set."""
    grid = MockGrid()
    # 2-cell cage summing to 10 has solutions {1,9}, {2,8}, {3,7}, {4,6}
    e = Equation({(0, 0), (0, 1)}, 10, grid)
    initial_count = len(e.solns)
    assert initial_count > 1
    # Forbid digit 9 — removes {1,9}
    e.avoid({9})
    assert all(9 not in soln for soln in e.solns)
    assert len(e.solns) < initial_count


def test_equation_avoid_raises_when_no_solutions() -> None:
    """avoid() raises NoSolnError when all solutions are eliminated."""
    grid = MockGrid()
    # Single-cell cage: only solution is {5}
    e = Equation({(0, 0)}, 5, grid)
    with pytest.raises(NoSolnError):
        e.avoid({5})


# ---------------------------------------------------------------------------
# Equation.difference_update
# ---------------------------------------------------------------------------


def test_equation_difference_update() -> None:
    """difference_update removes resolved sub-cage cells and narrows solutions."""
    grid = MockGrid()
    # 2-cell cage summing to 3 — only solution is {1, 2}
    parent = Equation({(0, 0), (0, 1)}, 3, grid)
    assert parent.solns == [frozenset({1, 2})]

    # Resolved sub-cage: cell (0,0) = 1
    sub = Equation({(0, 0)}, 1, grid)
    parent.difference_update(sub)

    # After update only cell (0,1) remains with value 2
    assert parent.s == {(0, 1)}
    assert parent.v == 2
    assert parent.solns == [frozenset({2})]


# ---------------------------------------------------------------------------
# Equation.__le__
# ---------------------------------------------------------------------------


def test_equation_le() -> None:
    """__le__ returns True when this equation's cells are a subset of other's."""
    grid = MockGrid()
    small = Equation({(0, 0)}, 5, grid)
    # 2-cell cage summing to 9: solutions include {4,5}
    large = Equation({(0, 0), (0, 1)}, 9, grid)
    assert small <= large
    assert not (large <= small)


# ---------------------------------------------------------------------------
# EquationConfig
# ---------------------------------------------------------------------------


def test_equation_config_defaults() -> None:
    """EquationConfig defaults to standard sudoku digit range 1-9."""
    cfg = EquationConfig()
    assert cfg.min_digit == 1
    assert cfg.max_digit == 9


def test_equation_config_custom_range() -> None:
    """sol_sums respects a custom digit range from EquationConfig."""
    cfg = EquationConfig(min_digit=1, max_digit=6)
    # With digits 1-6, a 2-cell cage summing to 11 has only {5,6}
    results = sol_sums(2, 0, 11, cfg)
    assert results == [frozenset({5, 6})]
    # 2-cell cage summing to 13 is impossible with max digit 6
    assert sol_sums(2, 0, 13, cfg) == []
