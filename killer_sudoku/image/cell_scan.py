"""Stage 3: lightweight per-cell classification for cage totals and classic digits.

Runs before border detection to produce cage_total_confidence scores used to
anchor border clustering in Stage 4.  A binary (0.0 / 1.0) score is returned
for each cell in the PoC implementation; continuous confidence is straightforward
to add once basic detection is validated.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

import cv2
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.config import CellScanConfig

_log = logging.getLogger(__name__)


def scan_cells(
    warped_gry: npt.NDArray[np.uint8],
    subres: int,
    config: CellScanConfig,
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Scan all 81 cells for cage totals and classic pre-filled digits.

    For each cell, checks for small contours in the top-left quadrant
    (cage total indicator) and large centred contours (classic sudoku
    pre-filled digit).

    Args:
        warped_gry: Perspective-corrected grayscale image, shape
            (9*subres, 9*subres).
        subres: Pixels per cell side.
        config: Cell scan parameters.

    Returns:
        (cage_total_confidence, classic_digit_confidence), each shape (9, 9)
        with values in {0.0, 1.0} for the PoC implementation.
    """
    cage_conf: npt.NDArray[np.float64] = np.zeros((9, 9), dtype=np.float64)
    classic_conf: npt.NDArray[np.float64] = np.zeros((9, 9), dtype=np.float64)

    half = subres // 2
    min_w = subres // 16
    max_w = subres // 2
    min_h = subres // 8
    max_h = subres // 2
    block_size = max(3, (half // 4) | 1)

    classic_min = int(subres * config.classic_min_size_fraction)
    margin = subres // 6
    patch_size = subres - 2 * margin
    classic_block = max(3, (patch_size // 4) | 1)

    for row in range(9):
        for col in range(9):
            y0 = row * subres
            x0 = col * subres

            # --- Cage total detection (top-left quadrant) ---
            patch_tl = warped_gry[y0 : y0 + half, x0 : x0 + half]
            blk_tl: npt.NDArray[np.uint8] = np.asarray(
                cv2.adaptiveThreshold(
                    patch_tl,
                    255,
                    cv2.ADAPTIVE_THRESH_MEAN_C,
                    cv2.THRESH_BINARY_INV,
                    block_size,
                    2,
                ),
                dtype=np.uint8,
            )
            contours_tl: Any
            contours_tl, _ = cv2.findContours(
                blk_tl, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            for c in contours_tl:
                _bx, _by, bw, bh = cv2.boundingRect(c)
                if min_w <= bw < max_w and min_h <= bh < max_h:
                    cage_conf[row, col] = 1.0
                    break

            # --- Classic digit detection (central region) ---
            patch_c = warped_gry[
                y0 + margin : y0 + subres - margin,
                x0 + margin : x0 + subres - margin,
            ]
            blk_c: npt.NDArray[np.uint8] = np.asarray(
                cv2.adaptiveThreshold(
                    patch_c,
                    255,
                    cv2.ADAPTIVE_THRESH_MEAN_C,
                    cv2.THRESH_BINARY_INV,
                    classic_block,
                    2,
                ),
                dtype=np.uint8,
            )
            contours_c: Any
            contours_c, _ = cv2.findContours(
                blk_c, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            for c in contours_c:
                _bx, _by, bw, bh = cv2.boundingRect(c)
                if bw >= classic_min or bh >= classic_min:
                    classic_conf[row, col] = 1.0
                    break

    return cage_conf, classic_conf


def detect_puzzle_type(
    classic_conf: npt.NDArray[np.float64],
    threshold: float,
) -> Literal["killer", "classic"]:
    """Classify a puzzle as classic or killer from cell-scan confidence.

    Sums classic_digit_confidence across all 81 cells.  A classic puzzle
    typically has 20-35 given digits (confidence 1.0 each); a killer has none.

    Args:
        classic_conf: (9, 9) float array from scan_cells.
        threshold: Minimum sum to classify as classic.

    Returns:
        "classic" if sum(classic_conf) > threshold, else "killer".
    """
    return "classic" if float(classic_conf.sum()) > threshold else "killer"
