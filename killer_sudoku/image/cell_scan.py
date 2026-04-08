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


def _compute_quad_sums(
    warped_gry: npt.NDArray[np.uint8],
    subres: int,
) -> npt.NDArray[np.float64]:
    """Sum per-cell ink in each of the four inner quadrants across all 81 cells.

    A border margin (subres // 6) is excluded from each cell so that
    cage-border lines do not contribute to the signal.

    Args:
        warped_gry: Perspective-corrected grayscale image, shape (9*subres, 9*subres).
        subres: Pixels per cell side.

    Returns:
        Array of shape (4,) with summed ink for [TL, TR, BL, BR] quadrants.
    """
    margin = subres // 6
    inner = subres - 2 * margin
    half_inner = inner // 2

    quad_sums: npt.NDArray[np.float64] = np.zeros(4, dtype=np.float64)
    for row in range(9):
        for col in range(9):
            y0 = row * subres + margin
            x0 = col * subres + margin
            ink = 255.0 - warped_gry[y0 : y0 + inner, x0 : x0 + inner].astype(
                np.float64
            )
            quad_sums[0] += ink[:half_inner, :half_inner].mean()  # TL
            quad_sums[1] += ink[:half_inner, half_inner:].mean()  # TR
            quad_sums[2] += ink[half_inner:, :half_inner].mean()  # BL
            quad_sums[3] += ink[half_inner:, half_inner:].mean()  # BR
    return quad_sums


# Maps dominant quadrant index (TL=0, TR=1, BL=2, BR=3) to k for np.rot90.
# np.rot90(k) rotates CCW: k=1 moves TR→TL, k=2 moves BR→TL, k=3 moves BL→TL.
_DOMINANT_TO_ROT90_K: list[int] = [0, 1, 3, 2]


def detect_rotation(
    warped_gry: npt.NDArray[np.uint8],
    subres: int,
    rotation_dominance_threshold: float,
) -> int:
    """Return the k parameter for np.roll to normalise puzzle orientation.

    Killer-sudoku cage totals always appear in one corner of their cells.
    When the source image is rotated (e.g. a landscape scan rotated 90°),
    the dominant corner of the warped image will be TR, BL, or BR instead
    of the canonical TL.  This function identifies the dominant corner and
    returns the number of corner positions to roll the grid-corner array so
    that the perspective transform maps that corner to the destination TL,
    producing a correctly-oriented warp.

    Only triggers when the dominant quadrant holds a clear majority
    (>= rotation_dominance_threshold of total ink) to avoid misclassifying
    classic puzzles or low-ink images where the distribution is too uniform
    to infer orientation.

    Args:
        warped_gry: Perspective-corrected grayscale image, shape (9*subres, 9*subres).
        subres: Pixels per cell side.
        rotation_dominance_threshold: Minimum fraction of total inner-cell ink
            that the dominant quadrant must carry for rotation to be applied.
            Genuine rotations produce fractions >= 0.65; classic/blank images
            produce ~0.25.  Default 0.50 gives a safe margin between these.

    Returns:
        k such that np.roll(corners, -k) followed by re-warping places the
        dominant ink corner at the canonical TL position.
        Returns 0 when TL is already dominant, the image is blank, or the ink
        distribution is too uniform to infer orientation.
    """
    quad_sums = _compute_quad_sums(warped_gry, subres)
    total = float(quad_sums.sum())
    if total < 1.0:
        return 0
    dominant = int(np.argmax(quad_sums))
    if dominant == 0:
        return 0  # TL already dominant — canonical orientation
    if float(quad_sums[dominant]) / total < rotation_dominance_threshold:
        return 0  # Ink too uniformly spread to reliably infer rotation
    k = _DOMINANT_TO_ROT90_K[dominant]
    _log.info(
        "Detected puzzle rotation: dominant quadrant is %s — rolling corners by %d",
        ["TL", "TR", "BL", "BR"][dominant],
        k,
    )
    return k


def detect_puzzle_type(
    warped_gry: npt.NDArray[np.uint8],
    subres: int,
    tl_fraction_threshold: float,
) -> Literal["killer", "classic"]:
    """Classify puzzle type from per-cell inner-quadrant ink distribution.

    Cage-total numbers always appear in one corner of their cells.  When
    aggregated across all 81 cells, the dominant inner quadrant carries the
    majority of cell-interior ink for killer puzzles (measured: 0.65–0.98 for
    the dominant quadrant).  Classic puzzles have pre-filled digits centred in
    cells, distributing ink roughly equally across all four inner quadrants
    (expected per-quadrant fraction ≈ 0.25).

    The dominant quadrant is not assumed to be top-left: if locate_grid returns
    corners in a non-canonical order the puzzle may be rotated, placing cage
    totals in a different corner.  Checking max(quadrant fractions) makes the
    test orientation-independent.

    A border margin (subres // 6) is excluded from each cell before computing
    quadrant ink so that cage-border lines — which vary in thickness and style
    by publisher — do not contribute to the signal.

    Args:
        warped_gry: Perspective-corrected grayscale image, shape
            (9*subres, 9*subres).
        subres: Pixels per cell side.
        tl_fraction_threshold: Minimum single-quadrant fraction of total
            inner-cell ink above which the puzzle is classified as killer.
            Measured killer minimum: 0.65; expected classic value: ~0.25.
            The default of 0.40 gives comfortable margins on both sides.

    Returns:
        "killer" if max quadrant fraction >= tl_fraction_threshold, else "classic".
    """
    quad_sums = _compute_quad_sums(warped_gry, subres)
    total = float(quad_sums.sum())
    if total < 1.0:
        return "killer"
    max_fraction = float(quad_sums.max()) / total
    return "killer" if max_fraction >= tl_fraction_threshold else "classic"
