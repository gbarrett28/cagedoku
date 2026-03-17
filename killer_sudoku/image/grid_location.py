"""Grid location functions for killer sudoku puzzle images.

Uses Hough line detection and linear regression to locate the 9x9 sudoku grid
in a photograph, returning the four corner points for perspective transform.
"""

import logging
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt
from sklearn import linear_model  # type: ignore[import-untyped]

from killer_sudoku.image.config import GridLocationConfig

_log = logging.getLogger(__name__)


def intersect(
    l1: tuple[float, float, float],
    l2: tuple[float, float, float],
) -> tuple[bool, float, float]:
    """Find the intersection of two lines in (rho, sin_theta, cos_theta) form.

    Represents the intersection as the solution to two linear equations derived
    from the normal-form line representation. Returns (False, 0.0, 0.0) when
    lines are parallel (singular matrix).

    Args:
        l1: First line as (rho, sin_theta, cos_theta).
        l2: Second line as (rho, sin_theta, cos_theta).

    Returns:
        (found, y, x) — found is False if lines are parallel.
    """
    rh1, sth1, cth1 = l1
    rh2, sth2, cth2 = l2
    mat = [[sth1, cth1], [sth2, cth2]]
    try:
        mat_inv: Any = np.linalg.inv(mat)
    except np.linalg.LinAlgError:
        return False, 0.0, 0.0
    result: Any = np.matmul(mat_inv, [rh1, rh2])
    coord_y: float = float(result[0])
    coord_x: float = float(result[1])
    return True, coord_y, coord_x


def draw_hough(
    img: npt.NDArray[np.uint8],
    lines: list[tuple[float, float, float]],
) -> None:
    """Draw Hough lines onto an image in-place (debug helper).

    Each line is clipped to the image boundary and drawn in red.

    Args:
        img: BGR image to draw on (modified in-place).
        lines: Lines in (rho, sin_theta, cos_theta) form.
    """
    yn, xn, _ = img.shape
    for line in lines:
        pts = []
        for ax in [(0, 0, 1), (0, 1, 0), (xn - 1, 0, 1), (yn - 1, 1, 0)]:
            ax_tuple: tuple[float, float, float] = (
                float(ax[0]),
                float(ax[1]),
                float(ax[2]),
            )
            b, y, x = intersect(line, ax_tuple)
            if b and 0 <= x < xn and 0 <= y < yn:
                pts.append((int(round(x)), int(round(y))))
        if len(pts) == 2:
            pt1, pt2 = pts
            cv2.line(img, pt1, pt2, (0, 0, 255), 1, cv2.LINE_AA)


def get_gry_img(
    f: Path,
    resolution: int,
) -> tuple[npt.NDArray[np.uint8], npt.NDArray[np.uint8]]:
    """Read a puzzle image file and prepare it for grid detection.

    Scales the image up until it meets the minimum resolution, then adds a
    black border to assist Hough line detection near the image edges.

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
    border has gaps, or a large non-grid dark region dominates the image),
    allowing the caller to fall back to Hough-line detection.

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
    img: npt.NDArray[np.uint8],
    config: GridLocationConfig,
) -> tuple[npt.NDArray[np.uint8], npt.NDArray[np.float32]]:
    """Locate the sudoku grid in a grayscale image.

    Primary strategy — contour detection:
        Thresholds the image and finds the largest quadrilateral contour.
        The outer border of the grid is a thick continuous rectangle and is
        reliably the largest connected dark region in the image, even when
        the grid occupies only a portion of the frame (e.g. portrait images
        where the puzzle sits in the upper half of the newspaper page).

    Fallback strategy — Hough-line regression:
        Applied when the contour strategy fails (no suitable quadrilateral
        found).  Applies a Hough transform, finds pairwise line intersections,
        filters out near-parallel outliers (whose intersection lies outside the
        image boundary), and fits a linear model to the major (3-cell) grid
        intersections to recover the four corner points.  Two Hough modes are
        available, controlled by config.use_hough_p.

    Returns (blk, rect) where blk is the thresholded binary image and rect is
    a (4, 2) float32 array of corner coordinates in the source image ordered
    [TL, TR, BR, BL] for use with cv2.getPerspectiveTransform.

    Args:
        gry: Grayscale source image.
        img: BGR source image (draw_hough annotates it for debug).
        config: Grid location parameters.

    Raises:
        AssertionError: if neither strategy can locate the grid.
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

    # --- Primary: contour detection -------------------------------------------
    rect = _contour_quad(blk)
    if rect is not None:
        _log.debug("locate_grid: contour strategy succeeded")
        return blk, rect

    # --- Fallback: Hough-line regression --------------------------------------
    _log.debug("locate_grid: contour strategy failed, falling back to Hough lines")
    image_size = max(gry.shape[0], gry.shape[1])
    lines: list[tuple[float, float, float]]

    if config.use_hough_p:
        # HoughLinesP: probabilistic segments with geometric length filter.
        # minLineLength is derived from the image size: a valid grid line must
        # span at least one full 3-box row (image_size * min_line_length_fraction).
        theta_p = math.pi / config.hough_theta_divisor
        min_length = int(image_size * config.min_line_length_fraction)
        segments_raw: Any = cv2.HoughLinesP(
            blk,
            config.rho,
            theta_p,
            config.hough_p_threshold,
            minLineLength=min_length,
            maxLineGap=config.max_line_gap,
        )
        assert segments_raw is not None, "HoughLinesP found no line segments"
        segments: npt.NDArray[np.float32] = np.asarray(segments_raw, dtype=np.float32)
        _log.debug("HoughLinesP found %d segments", len(segments))

        # Convert segment endpoints (x1, y1, x2, y2) to normal form
        # (rho, sin_theta, cos_theta) for use with intersect().
        # From the endpoint direction vector (dx, dy):
        #   cos_theta = -dy / L,  sin_theta = dx / L
        #   rho = x1 * cos_theta + y1 * sin_theta
        lines = []
        for [[x1, y1, x2, y2]] in segments.tolist():
            dx = x2 - x1
            dy = y2 - y1
            length = math.sqrt(dx * dx + dy * dy)
            if length == 0.0:
                continue
            cos_t = -dy / length
            sin_t = dx / length
            rho = x1 * cos_t + y1 * sin_t
            lines.append((rho, sin_t, cos_t))
    else:
        # HoughLines: classical accumulator with adaptive threshold via binary search.
        # Halve threshold until at least hough_lines_min_count lines are found.
        theta_c = math.pi / config.hough_lines_theta_divisor
        threshold = config.hough_threshold_max
        lines_rt_raw: Any = None
        while threshold >= 1:
            candidate: Any = cv2.HoughLines(blk, config.rho, theta_c, threshold)
            if candidate is not None and len(candidate) >= config.hough_lines_min_count:
                lines_rt_raw = candidate
                break
            if candidate is not None:
                lines_rt_raw = candidate  # keep as fallback
            threshold //= 2
        assert lines_rt_raw is not None, "HoughLines found no lines even at threshold=1"
        lines_rt: npt.NDArray[np.float32] = np.asarray(lines_rt_raw, dtype=np.float32)
        _log.debug("HoughLines found %d lines (threshold=%d)", len(lines_rt), threshold)

        lines = [
            (float(r), math.sin(float(t)), math.cos(float(t))) for [[r, t]] in lines_rt
        ]

    draw_hough(img, lines)

    # Compute all pairwise intersections, discarding points that lie more than
    # one image-width outside the boundary.  Near-parallel line pairs produce
    # near-singular matrix inverses with astronomically large coordinates; those
    # outliers corrupt the y0/yn range used in the grid-position binning below.
    isects: list[tuple[float, float]] = []
    margin = float(image_size)
    h, w = float(gry.shape[0]), float(gry.shape[1])
    for i, li in enumerate(lines):
        for lj in lines[:i]:
            b, y, x = intersect(li, lj)
            if b and -margin <= y <= h + margin and -margin <= x <= w + margin:
                isects.append((y, x))
    usects = sorted(set(isects))
    assert len(usects) >= 4

    y0 = min(y for y, _ in usects)
    x0 = min(x for _, x in usects)
    yn = 1 + max(y for y, _ in usects) - y0
    xn = 1 + max(x for _, x in usects) - x0

    reg_x: list[tuple[int, int]] = []
    reg_y: list[tuple[float, float]] = []
    for y, x in usects:
        m = round((9 * (x - x0)) / xn)
        n = round((9 * (y - y0)) / yn)
        if m % 3 == 0 and n % 3 == 0:
            reg_x.append((n, m))
            reg_y.append((y, x))

    regr: linear_model.LinearRegression = linear_model.LinearRegression()
    regr.fit(reg_x, reg_y)

    intercept: Any = regr.intercept_
    coef: Any = regr.coef_

    rect_hough = np.zeros((4, 2), dtype=np.float32)
    rect_hough[3] = list(reversed(np.asarray(intercept + 9 * coef[0]).tolist()))
    rect_hough[2] = list(
        reversed(np.asarray(intercept + 9 * coef[0] + 9 * coef[1]).tolist())
    )
    rect_hough[1] = list(reversed(np.asarray(intercept + 9 * coef[1]).tolist()))
    rect_hough[0] = list(reversed(np.asarray(intercept).tolist()))

    return blk, rect_hough
