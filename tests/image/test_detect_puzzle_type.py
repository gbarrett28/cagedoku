"""Unit tests for detect_puzzle_type in cell_scan."""

from __future__ import annotations

import numpy as np

from killer_sudoku.image.cell_scan import detect_puzzle_type


class TestDetectPuzzleType:
    def test_zero_confidence_is_killer(self) -> None:
        conf = np.zeros((9, 9), dtype=np.float64)
        assert detect_puzzle_type(conf, 10.0) == "killer"

    def test_low_confidence_sum_is_killer(self) -> None:
        conf = np.zeros((9, 9), dtype=np.float64)
        conf[0, 0] = 1.0  # sum = 1.0, below threshold 10.0
        assert detect_puzzle_type(conf, 10.0) == "killer"

    def test_high_confidence_sum_is_classic(self) -> None:
        conf = np.zeros((9, 9), dtype=np.float64)
        conf[:2, :] = 1.0  # 18 cells, sum = 18.0 > 10.0
        assert detect_puzzle_type(conf, 10.0) == "classic"

    def test_sum_exactly_at_threshold_is_killer(self) -> None:
        # Threshold is strictly greater-than, so equal → killer
        conf = np.zeros((9, 9), dtype=np.float64)
        conf[0, :] = 1.0  # 9 cells
        conf[1, 0] = 1.0  # 10th cell → sum = 10.0, equal to threshold
        assert abs(float(conf.sum()) - 10.0) < 1e-9
        assert detect_puzzle_type(conf, 10.0) == "killer"

    def test_custom_threshold(self) -> None:
        conf = np.zeros((9, 9), dtype=np.float64)
        conf[0, 0] = 5.0
        assert detect_puzzle_type(conf, 4.0) == "classic"
        assert detect_puzzle_type(conf, 6.0) == "killer"
