"""Tests for _build_diagnostic_spec in the puzzle router."""

import numpy as np

from killer_sudoku.api.routers.puzzle import _build_diagnostic_spec


def _all_borders_on() -> tuple[np.ndarray, np.ndarray]:
    """Return border arrays with every inner border as a cage wall."""
    return np.ones((9, 8), dtype=bool), np.ones((8, 9), dtype=bool)


def _no_borders() -> tuple[np.ndarray, np.ndarray]:
    """Return border arrays with no inner cage walls (whole grid = one component)."""
    return np.zeros((9, 8), dtype=bool), np.zeros((8, 9), dtype=bool)


def test_all_borders_on_produces_81_regions() -> None:
    """With every border on, each cell is its own region."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    bx, by = _all_borders_on()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert spec.regions.shape == (9, 9)
    assert len(set(spec.regions.flatten().tolist())) == 81


def test_no_borders_produces_one_region() -> None:
    """With no borders, the entire grid is one connected component."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    bx, by = _no_borders()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert len(set(spec.regions.flatten().tolist())) == 1


def test_cage_totals_passed_through_unchanged() -> None:
    """cage_totals are stored verbatim even when geometrically invalid."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    cage_totals[0, 0] = 14  # impossible for any cage size
    bx, by = _no_borders()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert spec.cage_totals[0, 0] == 14


def test_regions_are_positive_integers() -> None:
    """Every cell has a region ID >= 1."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    bx, by = _all_borders_on()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert int(spec.regions.min()) >= 1


def test_output_border_arrays_equal_inputs() -> None:
    """border_x and border_y are stored without modification."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    bx, by = _all_borders_on()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert np.array_equal(spec.border_x, bx)
    assert np.array_equal(spec.border_y, by)
