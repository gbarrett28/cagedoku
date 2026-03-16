"""Tests for killer_sudoku.image.grid_location.intersect."""

import math

from killer_sudoku.image.grid_location import intersect

# Line format: (rho, sin_theta, cos_theta)
# The line equation is: rho = y * sin_theta + x * cos_theta
#
# Special cases:
#   Vertical line (theta=0):  sin=0, cos=1  ->  rho = x  (x = rho)
#   Horizontal line (theta=pi/2): sin=1, cos=0  ->  rho = y  (y = rho)


# ---------------------------------------------------------------------------
# Axis-aligned perpendicular lines
# ---------------------------------------------------------------------------


def test_intersect_axis_aligned() -> None:
    """Two axis-aligned lines at x=3 and y=4 intersect at (y=4, x=3)."""
    # x = 3: sin=0, cos=1, rho=3
    l_vertical = (3.0, 0.0, 1.0)
    # y = 4: sin=1, cos=0, rho=4
    l_horizontal = (4.0, 1.0, 0.0)
    found, y, x = intersect(l_vertical, l_horizontal)
    assert found is True
    assert math.isclose(y, 4.0, abs_tol=1e-9)
    assert math.isclose(x, 3.0, abs_tol=1e-9)


def test_intersect_perpendicular_at_origin() -> None:
    """x=0 and y=0 intersect at the origin."""
    l_x0 = (0.0, 0.0, 1.0)  # x = 0
    l_y0 = (0.0, 1.0, 0.0)  # y = 0
    found, y, x = intersect(l_x0, l_y0)
    assert found is True
    assert math.isclose(y, 0.0, abs_tol=1e-9)
    assert math.isclose(x, 0.0, abs_tol=1e-9)


# ---------------------------------------------------------------------------
# Parallel lines — no intersection
# ---------------------------------------------------------------------------


def test_intersect_parallel_horizontal() -> None:
    """Two horizontal lines (same direction) are parallel — no intersection."""
    l1 = (2.0, 1.0, 0.0)  # y = 2
    l2 = (5.0, 1.0, 0.0)  # y = 5
    found, _, _ = intersect(l1, l2)
    assert found is False


def test_intersect_parallel_vertical() -> None:
    """Two vertical lines (same direction) are parallel — no intersection."""
    l1 = (1.0, 0.0, 1.0)  # x = 1
    l2 = (7.0, 0.0, 1.0)  # x = 7
    found, _, _ = intersect(l1, l2)
    assert found is False


# ---------------------------------------------------------------------------
# Diagonal lines
# ---------------------------------------------------------------------------


def test_intersect_diagonal_known_point() -> None:
    """Two diagonal lines intersect at a known point.

    Line 1: rho=7, theta=pi/4  -> sin=cos=1/sqrt(2)
            equation: (y + x) / sqrt(2) = 7  ->  y + x = 7*sqrt(2)
    Line 2: rho=0, theta=3pi/4 -> sin=1/sqrt(2), cos=-1/sqrt(2)
            equation: (y - x) / sqrt(2) = 0  ->  y = x

    Solving: y = x and y + x = 7*sqrt(2)  ->  x = y = 7*sqrt(2)/2
    """
    s45 = math.sin(math.pi / 4)
    c45 = math.cos(math.pi / 4)
    s135 = math.sin(3 * math.pi / 4)
    c135 = math.cos(3 * math.pi / 4)

    rho1 = 7.0
    l1 = (rho1, s45, c45)

    rho2 = 0.0
    l2 = (rho2, s135, c135)

    found, y, x = intersect(l1, l2)
    assert found is True
    expected = 7.0 * math.sqrt(2) / 2
    assert math.isclose(x, expected, rel_tol=1e-6)
    assert math.isclose(y, expected, rel_tol=1e-6)


def test_intersect_returns_float_tuple() -> None:
    """intersect always returns a 3-tuple (bool, float, float)."""
    result = intersect((3.0, 0.0, 1.0), (4.0, 1.0, 0.0))
    assert len(result) == 3
    found, y, x = result
    assert isinstance(found, bool)
    assert isinstance(y, float)
    assert isinstance(x, float)
