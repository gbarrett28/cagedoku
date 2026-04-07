"""Tests for killer_sudoku.image.border_detection.

Covers detect_borders_peak_count (the format-agnostic Guardian/bootstrap
border detector) using synthetic numpy images to avoid any dependency on
real photograph fixtures or trained models.
"""

from __future__ import annotations

from typing import cast
from unittest.mock import MagicMock

import numpy as np
import numpy.typing as npt

from killer_sudoku.image.border_detection import (
    BorderDecode,
    BorderPCA1D,
    detect_borders_peak_count,
)

# ---------------------------------------------------------------------------
# detect_borders_peak_count — synthetic image tests
# ---------------------------------------------------------------------------

# Parameters matching ImagePipelineConfig defaults, scaled down for speed.
# sample_fraction=4  → sample_half = subres // 4
# sample_margin=16   → margin_px   = subres // 16
# With subres=32: sample_half=8, margin_px=2, strip width=6 pixels
_SUBRES = 32
_SAMPLE_FRACTION = 4
_SAMPLE_MARGIN = 16


def _detect(
    img: npt.NDArray[np.uint8],
) -> tuple[npt.NDArray[np.bool_], npt.NDArray[np.bool_]]:
    """Call detect_borders_peak_count with the test-suite parameters."""
    return detect_borders_peak_count(img, _SUBRES, _SAMPLE_FRACTION, _SAMPLE_MARGIN)


def _blank_white_grid() -> npt.NDArray[np.uint8]:
    """All-white (255) image — adaptive threshold with no ink anywhere."""
    size = _SUBRES * 9
    return np.full((size, size), 255, dtype=np.uint8)


def _add_border_line(
    img: npt.NDArray[np.uint8],
    col: int,
    row: int,
    horizontal: bool,
) -> npt.NDArray[np.uint8]:
    """Draw a synthetic cage-border line (3 spaced dark pixels) in the strip.

    The detect_borders_peak_count algorithm samples a strip centred on each
    interior cell edge and counts peaks in the inverted strip.  Three isolated
    black pixels spaced at least 2 apart produce 3 local maxima in the inverted
    strip, satisfying ``len(peaks) > 2``.

    Args:
        img: Mutable (9*subres, 9*subres) uint8 image.
        col: Column index of the edge (0–8 for border_x / border_y).
        row: Row index of the interior edge (1–8, as used in the algorithm).
        horizontal: True to mark a horizontal border (border_x),
                    False for a vertical border (border_y).

    Returns:
        The same image, mutated in-place for convenience.
    """
    sample_half = _SUBRES // _SAMPLE_FRACTION
    margin = _SUBRES // _SAMPLE_MARGIN

    if horizontal:
        # border_x[col, row-1]: strip runs along columns; edge is between rows
        xm = ((2 * col + 1) * _SUBRES) // 2
        xb = xm + margin
        xt = xm + sample_half - margin
        yl = row * _SUBRES - sample_half
        yr = row * _SUBRES + sample_half
        # Place 3 isolated black pixels across the strip's y-span
        mid = (yl + yr) // 2
        for py in [mid - 4, mid, mid + 4]:
            if yl <= py < yr:
                for px in range(xb, xt):
                    img[px, py] = 0
    else:
        # border_y[row-1, col]: strip runs along rows; edge is between columns
        xm = ((2 * col + 1) * _SUBRES) // 2
        xb = xm + margin
        xt = xm + sample_half - margin
        yl = row * _SUBRES - sample_half
        yr = row * _SUBRES + sample_half
        mid = (yl + yr) // 2
        for py in [mid - 4, mid, mid + 4]:
            if yl <= py < yr:
                for px in range(xb, xt):
                    img[py, px] = 0

    return img


class TestDetectBordersPeakCountNoInk:
    def test_all_white_image_returns_no_horizontal_borders(self) -> None:
        warped = _blank_white_grid()
        bx, _ = _detect(warped)
        assert bx.shape == (9, 8)
        assert not np.any(bx), "Expected no borders in blank image"

    def test_all_white_image_returns_no_vertical_borders(self) -> None:
        warped = _blank_white_grid()
        _, by = _detect(warped)
        assert by.shape == (8, 9)
        assert not np.any(by), "Expected no borders in blank image"

    def test_output_shapes_are_correct(self) -> None:
        warped = _blank_white_grid()
        bx, by = _detect(warped)
        assert bx.shape == (9, 8)
        assert by.shape == (8, 9)


class TestDetectBordersPeakCountWithInk:
    def test_horizontal_border_detected(self) -> None:
        """A drawn cage-border line produces True in border_x."""
        warped = _blank_white_grid()
        _add_border_line(warped, col=0, row=1, horizontal=True)
        bx, _ = _detect(warped)
        # border_x[col, row-1]
        assert bx[0, 0], "Horizontal border at col=0,row=1 should be detected"

    def test_no_false_horizontal_border_without_ink(self) -> None:
        """Adjacent edge position (col=0,row=2) stays False when only row=1 has ink."""
        warped = _blank_white_grid()
        _add_border_line(warped, col=0, row=1, horizontal=True)
        bx, _ = _detect(warped)
        assert not bx[0, 1], "Edge (col=0,row=2) should not be falsely detected"

    def test_multiple_horizontal_borders_detected_independently(self) -> None:
        warped = _blank_white_grid()
        _add_border_line(warped, col=2, row=3, horizontal=True)
        _add_border_line(warped, col=5, row=7, horizontal=True)
        bx, _ = _detect(warped)
        assert bx[2, 2], "Border at (col=2,row=3) should be detected"
        assert bx[5, 6], "Border at (col=5,row=7) should be detected"
        # Positions without ink should remain False
        assert not bx[0, 0]

    def test_returns_bool_dtype(self) -> None:
        warped = _blank_white_grid()
        bx, by = _detect(warped)
        assert bx.dtype == bool
        assert by.dtype == bool


# ---------------------------------------------------------------------------
# BorderDecode.is_border — unit test
# ---------------------------------------------------------------------------


class TestBorderDecodeIsBorder:
    def test_classifies_samples_using_pca_and_kmeans(self) -> None:
        """is_border delegates to pca.transform + kmeans.predict."""
        pca = MagicMock()
        pca.transform.return_value = np.array([[1.0], [0.0]])

        kmeans = MagicMock()
        kmeans.predict.return_value = np.array([0, 1])

        isbrdr = {0: True, 1: False}
        bd = BorderDecode(pca=pca, kmeans=kmeans, isbrdr=isbrdr)

        samples = cast(list[npt.NDArray[np.float64]], [np.zeros(8), np.ones(8)])
        result = bd.is_border(samples)
        assert result == [True, False]


# ---------------------------------------------------------------------------
# BorderPCA1D — unit tests
# ---------------------------------------------------------------------------


class TestBorderPCA1D:
    def _make_model(self, cmp: bool = False) -> BorderPCA1D:
        vec = cast(npt.NDArray[np.float64], np.array([1.0, 0.0, 0.0, 0.0]))
        bp = cast(npt.NDArray[np.float64], np.array([0.5]))
        return BorderPCA1D(pp=vec, mm=bp, cmp=cmp)

    def _s(self, *rows: list[float]) -> list[npt.NDArray[np.float64]]:
        """Wrap float lists as properly-typed sample arrays."""
        return cast(list[npt.NDArray[np.float64]], [np.array(r) for r in rows])

    def test_project_returns_scalar_list(self) -> None:
        model = self._make_model()
        samples = self._s([1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0])
        projections = model.project(samples)
        assert len(projections) == 2
        assert abs(projections[0] - 0.5) < 1e-9  # 1*1 - 0.5
        assert abs(projections[1] - (-0.5)) < 1e-9  # 0*1 - 0.5

    def test_is_border_positive_projection_no_invert(self) -> None:
        model = self._make_model(cmp=False)
        # projection > 0 → (b > 0) != False → True (border)
        assert model.is_border(self._s([2.0, 0.0, 0.0, 0.0])) == [True]

    def test_is_border_negative_projection_no_invert(self) -> None:
        model = self._make_model(cmp=False)
        # projection < 0 → (b > 0) = False, != False → False (not border)
        assert model.is_border(self._s([0.0, 0.0, 0.0, 0.0])) == [False]

    def test_is_border_with_polarity_inversion(self) -> None:
        model = self._make_model(cmp=True)
        # cmp=True inverts: positive projection → False
        assert model.is_border(self._s([2.0, 0.0, 0.0, 0.0])) == [False]
