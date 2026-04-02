"""Tests for killer_sudoku.image.cell_scan."""

import numpy as np

from killer_sudoku.image.cell_scan import scan_cells
from killer_sudoku.image.config import CellScanConfig

SUBRES = 128
RESOLUTION = 9 * SUBRES


def _blank_warped() -> np.ndarray:
    """Return a light-grey warped image with no content (no contours)."""
    return np.full((RESOLUTION, RESOLUTION), 200, dtype=np.uint8)


def _draw_rect(
    img: np.ndarray,
    row: int,
    col: int,
    y_off: int,
    x_off: int,
    h: int,
    w: int,
    value: int = 20,
) -> None:
    """Draw a filled rectangle at (y_off, x_off) within cell (row, col)."""
    y0 = row * SUBRES + y_off
    x0 = col * SUBRES + x_off
    img[y0 : y0 + h, x0 : x0 + w] = value


def test_blank_image_has_zero_confidence() -> None:
    """A blank (no contours) warped image yields zero confidence everywhere."""
    warped = _blank_warped()
    cage_conf, classic_conf = scan_cells(warped, SUBRES, CellScanConfig())
    assert cage_conf.shape == (9, 9)
    assert classic_conf.shape == (9, 9)
    assert float(cage_conf.max()) == 0.0
    assert float(classic_conf.max()) == 0.0


def test_small_contour_in_top_left_detected_as_cage_total() -> None:
    """A small dark contour in the top-left quadrant triggers cage_total_confidence."""
    warped = _blank_warped()
    # Draw ink-sized rect in top-left quadrant of cell (2, 3)
    # Fits within [0, subres//2) in both axes: h=16, w=20, at offset (6, 6)
    _draw_rect(warped, row=2, col=3, y_off=6, x_off=6, h=16, w=20)
    cage_conf, classic_conf = scan_cells(warped, SUBRES, CellScanConfig())
    assert cage_conf[2, 3] > 0.0, "Expected cage total detected at (2, 3)"
    assert classic_conf[2, 3] == 0.0, (
        "Small top-left contour should not trigger classic"
    )


def test_cage_total_only_in_expected_cell() -> None:
    """Detection is localised: neighbouring cells remain zero."""
    warped = _blank_warped()
    _draw_rect(warped, row=0, col=0, y_off=6, x_off=6, h=16, w=20)
    cage_conf, _ = scan_cells(warped, SUBRES, CellScanConfig())
    assert cage_conf[0, 0] > 0.0
    assert cage_conf[0, 1] == 0.0
    assert cage_conf[1, 0] == 0.0


def test_large_centred_contour_detected_as_classic_digit() -> None:
    """A large dark contour in the cell centre triggers classic_digit_confidence."""
    warped = _blank_warped()
    margin = SUBRES // 6
    # Draw a large rect in the central region of cell (4, 4)
    _draw_rect(warped, row=4, col=4, y_off=margin + 5, x_off=margin + 5, h=50, w=50)
    _, classic_conf = scan_cells(warped, SUBRES, CellScanConfig())
    assert classic_conf[4, 4] > 0.0, "Expected classic digit detected at (4, 4)"


def test_confidence_arrays_are_float64() -> None:
    """scan_cells always returns float64 arrays."""
    warped = _blank_warped()
    cage_conf, classic_conf = scan_cells(warped, SUBRES, CellScanConfig())
    assert cage_conf.dtype == np.float64
    assert classic_conf.dtype == np.float64
