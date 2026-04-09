"""Grid location functions for killer sudoku puzzle images.

Uses contour detection to locate the 9x9 sudoku grid in a photograph,
returning the four corner points for perspective transform.
"""

import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.config import GridLocationConfig

_log = logging.getLogger(__name__)


def get_gry_img(
    f: Path,
    resolution: int,
) -> tuple[npt.NDArray[np.uint8], npt.NDArray[np.uint8]]:
    """Read a puzzle image file and prepare it for grid detection.

    Scales the image up until it meets the minimum resolution, then adds a
    black border to ensure contours near image edges are fully enclosed.

    Args:
        f: Path to the image file.
        resolution: Minimum pixel dimension required (9 * subres).

    Returns:
        (gry, img) — grayscale image and original BGR image with black border.
    """
    raw = cv2.imread(str(f))
    if raw is None:
        raise FileNotFoundError(f"Could not read image: {f}")
    imga: npt.NDArray[np.uint8] = np.asarray(raw, dtype=np.uint8)
    while imga.shape[0] < resolution or imga.shape[1] < resolution:
        imga = np.asarray(cv2.pyrUp(imga), dtype=np.uint8)
    blank = np.zeros((imga.shape[0] + 6, imga.shape[1] + 6, 3), np.uint8)
    img: npt.NDArray[np.uint8] = np.asarray(cv2.bitwise_not(blank), dtype=np.uint8)
    img[3 : 3 + imga.shape[0], 3 : imga.shape[1] + 3] = imga
    gry: npt.NDArray[np.uint8] = np.asarray(
        cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), dtype=np.uint8
    )
    return gry, img


def _contour_quad(
    blk: npt.NDArray[np.uint8],
    min_aspect: float = 0.5,
) -> npt.NDArray[np.float32] | None:
    """Find the grid rectangle via contour detection.

    Finds all external contours in the binary image, then scans the largest
    ones for a quadrilateral with approximately square aspect ratio.  The
    outer border of the grid is a thick continuous rectangle and is typically
    the largest connected dark region in the image.

    Corner ordering follows cv2.getPerspectiveTransform convention:
    rect[0]=TL, rect[1]=TR, rect[2]=BR, rect[3]=BL.  Corners are sorted by
    the sum (x+y) and difference (y-x) of their coordinates:
    TL has the smallest sum, BR the largest, TR the smallest difference,
    and BL the largest difference.

    Returns None when no suitable quadrilateral is found (e.g. the outer
    border has gaps, or a large non-grid dark region dominates the image).

    Args:
        blk: Binary image (255 = dark/candidate pixels, 0 = background).
        min_aspect: Minimum short-side / long-side ratio to accept as valid.

    Returns:
        (4, 2) float32 corner array [TL, TR, BR, BL], or None if not found.
    """
    contours_raw: Any
    contours_raw, _ = cv2.findContours(blk, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours: list[Any] = sorted(contours_raw, key=cv2.contourArea, reverse=True)
    for c in contours[:10]:
        peri = cv2.arcLength(c, True)
        approx: Any = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) != 4:
            continue
        pts: npt.NDArray[np.float32] = np.asarray(approx, dtype=np.float32).reshape(
            4, 2
        )
        s = pts.sum(axis=1)
        d = np.diff(pts, axis=1).ravel()  # y - x per point
        rect = np.zeros((4, 2), dtype=np.float32)
        rect[0] = pts[int(np.argmin(s))]  # TL: smallest x+y
        rect[1] = pts[int(np.argmin(d))]  # TR: smallest y-x (= largest x-y)
        rect[2] = pts[int(np.argmax(s))]  # BR: largest x+y
        rect[3] = pts[int(np.argmax(d))]  # BL: largest y-x
        w = float(np.linalg.norm(rect[1] - rect[0]))
        h = float(np.linalg.norm(rect[3] - rect[0]))
        if max(w, h) > 0 and min(w, h) / max(w, h) >= min_aspect:
            return rect
    return None


def locate_grid(
    gry: npt.NDArray[np.uint8],
    config: GridLocationConfig,
) -> tuple[npt.NDArray[np.uint8], npt.NDArray[np.float32]]:
    """Locate the sudoku grid in a grayscale image via contour detection.

    Thresholds the image and finds the largest quadrilateral contour.
    The outer border of the grid is a thick continuous rectangle and is
    reliably the largest connected dark region in the image, even when
    the grid occupies only a portion of the frame (e.g. portrait images
    where the puzzle sits in the upper half of the newspaper page).

    Returns (blk, rect) where blk is the thresholded binary image and rect is
    a (4, 2) float32 array of corner coordinates in the source image ordered
    [TL, TR, BR, BL] for use with cv2.getPerspectiveTransform.

    Args:
        gry: Grayscale source image.
        config: Grid location parameters.

    Raises:
        AssertionError: if the contour strategy cannot locate a quadrilateral.
    """
    blk_detect = np.reshape(np.ravel(gry), (-1, 1))
    counts: npt.NDArray[np.intp]
    bins: npt.NDArray[np.float64]
    counts, bins = np.histogram(blk_detect, bins=range(0, 257, 16))

    # Walk histogram bins from the bright end, stopping when count rises,
    # to identify the darkest significant tone (the grid lines).
    cm = int(np.sum(counts))
    isblack = 256
    for c, b in zip(reversed(counts.tolist()), reversed(bins.tolist()), strict=False):
        if c < cm:
            cm = c
            isblack = int(b)
        else:
            break
    isblack -= config.isblack_offset

    blk: npt.NDArray[np.uint8] = np.asarray(
        cv2.inRange(np.asarray(gry), np.array([0]), np.array([isblack])), dtype=np.uint8
    )

    rect = _contour_quad(blk)
    assert rect is not None, "locate_grid: no quadrilateral contour found"
    _log.debug("locate_grid: contour strategy succeeded")
    return blk, rect
