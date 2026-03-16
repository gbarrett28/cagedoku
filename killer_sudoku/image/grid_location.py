"""Grid location functions for killer sudoku puzzle images.

Uses Hough line detection and linear regression to locate the 9x9 sudoku grid
in a photograph, returning the four corner points for perspective transform.
"""

import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt
from sklearn import linear_model  # type: ignore[import-untyped]

from killer_sudoku.image.config import GridLocationConfig


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


def locate_grid(
    gry: npt.NDArray[np.uint8],
    img: npt.NDArray[np.uint8],
    config: GridLocationConfig,
) -> tuple[npt.NDArray[np.uint8], npt.NDArray[np.float32]]:
    """Locate the sudoku grid in a grayscale image using Hough line detection.

    Thresholds the image to isolate the black grid lines, applies Hough
    transform, finds pairwise line intersections, and fits a linear model
    to the major (3-cell) grid intersections to recover the four corner points.

    Returns (blk, rect) where blk is the thresholded binary image used for
    detection and rect is a (4, 2) float32 array of the four corner coordinates
    in the source image (top-left, top-right, bottom-right, bottom-left order
    for use with cv2.getPerspectiveTransform).

    Args:
        gry: Grayscale source image.
        img: BGR source image (draw_hough modifies it for debug).
        config: Grid location parameters.

    Raises:
        AssertionError: if Hough lines or intersections cannot be found.
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

    theta = math.pi / config.theta_divisor
    lines_rt_raw: Any = cv2.HoughLines(blk, config.rho, theta, config.hough_threshold)
    assert lines_rt_raw is not None
    lines_rt: npt.NDArray[np.float32] = np.asarray(lines_rt_raw, dtype=np.float32)

    lines: list[tuple[float, float, float]] = [
        (float(r), math.sin(float(t)), math.cos(float(t))) for [[r, t]] in lines_rt
    ]
    draw_hough(img, lines)

    isects: list[tuple[float, float]] = []
    for i, li in enumerate(lines):
        for lj in lines[:i]:
            b, y, x = intersect(li, lj)
            if b:
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

    rect = np.zeros((4, 2), dtype=np.float32)
    rect[3] = list(reversed(np.asarray(intercept + 9 * coef[0]).tolist()))
    rect[2] = list(reversed(np.asarray(intercept + 9 * coef[0] + 9 * coef[1]).tolist()))
    rect[1] = list(reversed(np.asarray(intercept + 9 * coef[1]).tolist()))
    rect[0] = list(reversed(np.asarray(intercept).tolist()))

    return blk, rect
