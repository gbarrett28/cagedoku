"""Tests for read_classic_digits in number_recognition."""

from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np
import numpy.typing as npt

from killer_sudoku.image.number_recognition import read_classic_digits


def _blank_warped(subres: int = 32) -> npt.NDArray[np.uint8]:
    return np.zeros((subres * 9, subres * 9), dtype=np.uint8)


def _make_recogniser(digit: int) -> MagicMock:
    rec = MagicMock()
    rec.get_sums.return_value = np.array([digit], dtype=np.intp)
    return rec


class TestReadClassicDigits:
    def test_empty_conf_returns_zeros(self) -> None:
        warped_blk = _blank_warped()
        classic_conf = np.zeros((9, 9), dtype=np.float64)
        result = read_classic_digits(warped_blk, _make_recogniser(0), 32, classic_conf)
        assert result.shape == (9, 9)
        assert not np.any(result)

    def test_single_cell_with_contour_calls_recogniser(self) -> None:
        subres = 32
        half = subres // 2
        warped_blk = _blank_warped(subres)
        # Draw a white square (contour) in the central crop of cell (0, 0)
        y0 = 0 * subres + subres // 4
        x0 = 0 * subres + subres // 4
        warped_blk[y0 + 4 : y0 + half - 4, x0 + 4 : x0 + half - 4] = 255

        classic_conf = np.zeros((9, 9), dtype=np.float64)
        classic_conf[0, 0] = 1.0
        rec = _make_recogniser(5)
        result = read_classic_digits(warped_blk, rec, subres, classic_conf)
        assert result[0, 0] == 5
        assert rec.get_sums.called

    def test_cell_with_no_contour_stays_zero(self) -> None:
        subres = 32
        warped_blk = _blank_warped(subres)
        classic_conf = np.zeros((9, 9), dtype=np.float64)
        classic_conf[1, 1] = 1.0  # No ink pixels → no contour
        result = read_classic_digits(
            warped_blk, _make_recogniser(7), subres, classic_conf
        )
        assert result[1, 1] == 0

    def test_zero_confidence_cell_skipped(self) -> None:
        subres = 32
        half = subres // 2
        warped_blk = _blank_warped(subres)
        # Draw ink in cell (2, 3) — but confidence is 0 so it should be skipped
        y0 = 2 * subres + subres // 4
        x0 = 3 * subres + subres // 4
        warped_blk[y0 + 4 : y0 + half - 4, x0 + 4 : x0 + half - 4] = 255
        classic_conf = np.zeros((9, 9), dtype=np.float64)
        rec = _make_recogniser(3)
        result = read_classic_digits(warped_blk, rec, subres, classic_conf)
        assert result[2, 3] == 0
        assert not rec.get_sums.called
