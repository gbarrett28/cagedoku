"""Tests for Grid.set_up with given_digits parameter."""

from __future__ import annotations

import numpy as np

from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.grid import Grid


def _classic_spec() -> object:
    """Build a valid PuzzleSpec with 9 row cages (sum=45 each)."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    for r in range(9):
        cage_totals[0, r] = 45
    border_x = np.ones((9, 8), dtype=bool)
    border_y = np.zeros((8, 9), dtype=bool)
    return validate_cage_layout(cage_totals, border_x, border_y)


class TestGridSetUpGivenDigits:
    def test_given_digits_reduces_sq_poss_to_singleton(self) -> None:
        spec = _classic_spec()
        given = np.zeros((9, 9), dtype=np.intp)
        given[0, 0] = 7

        grd = Grid()
        grd.set_up(spec, given_digits=given)

        assert grd.sq_poss[0][0] == {7}

    def test_other_cells_keep_all_candidates(self) -> None:
        spec = _classic_spec()
        given = np.zeros((9, 9), dtype=np.intp)
        given[0, 0] = 7

        grd = Grid()
        grd.set_up(spec, given_digits=given)

        assert len(grd.sq_poss[0][1]) == 9

    def test_none_given_digits_leaves_all_candidates(self) -> None:
        spec = _classic_spec()

        grd = Grid()
        grd.set_up(spec, given_digits=None)

        for r in range(9):
            for c in range(9):
                assert len(grd.sq_poss[r][c]) == 9

    def test_multiple_given_digits(self) -> None:
        spec = _classic_spec()
        given = np.zeros((9, 9), dtype=np.intp)
        given[0, 0] = 3
        given[4, 5] = 9
        given[8, 8] = 1

        grd = Grid()
        grd.set_up(spec, given_digits=given)

        assert grd.sq_poss[0][0] == {3}
        assert grd.sq_poss[4][5] == {9}
        assert grd.sq_poss[8][8] == {1}
