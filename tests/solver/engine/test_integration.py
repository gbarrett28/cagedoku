"""Integration test: Grid.engine_solve wires new SolverEngine into Grid."""

from killer_sudoku.solver.grid import Grid
from tests.fixtures.minimal_puzzle import KNOWN_SOLUTION, make_trivial_spec


def test_grid_engine_solve_trivial() -> None:
    """Grid.engine_solve on trivial spec produces correct solution."""
    spec = make_trivial_spec()
    g = Grid()
    g.set_up(spec)
    alts, solns = g.engine_solve()
    assert alts == 81  # one candidate per cell
    assert solns == 0  # no cage solutions remaining (all solved)
    for r in range(9):
        for c in range(9):
            assert g.sq_poss[r][c] == {KNOWN_SOLUTION[r][c]}
