"""Locates digit bounding rects without warping them.

Task 4 applies stretch or letterbox geometry afterward, independently.
"""

import dataclasses
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt
from scipy.signal import find_peaks

from killer_sudoku.image.number_recognition import (
    contour_hier,
    contour_is_number,
    get_num_contours,
)


@dataclasses.dataclass(frozen=True)
class DigitRect:
    row: int
    col: int
    rect: npt.NDArray[np.float32]  # (4, 2) source corners, order matches get_warp_from_rect


def _split_rect(
    br: tuple[int, int, int, int], warped_blk: npt.NDArray[np.uint8], subres: int
) -> list[npt.NDArray[np.float32]]:
    """Split a bounding rect that may contain 1-2 digits into per-digit source quads.

    Mirrors split_num's peak-finding logic but returns source quads instead of
    pre-warped thumbnails.
    """
    x, y, w, h = br
    ys = np.argmax(warped_blk[y : y + h, x : x + w], axis=0)
    peaks, _ = find_peaks(ys, height=4)
    valid_peaks = [
        p
        for p in peaks.tolist()
        if contour_is_number((x, y, p, h), subres)
        and contour_is_number((x + p, y, w - p, h), subres)
    ]

    rects: list[tuple[int, int, int, int]] = []
    if not valid_peaks:
        rects.append((x, y, w, h))
    else:
        sp = valid_peaks[-1]
        rects.append((x, y, sp, h))
        rects.append((x + sp, y, w - sp, h))

    return [
        np.array([[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]], dtype=np.float32)
        for rx, ry, rw, rh in rects
    ]


def locate_cage_total_rects(
    warped_blk: npt.NDArray[np.uint8], subres: int
) -> list[DigitRect]:
    """Locate every cage-total digit's source rect, grouped by (row, col) cell."""
    contours_raw: Any
    hiers_raw: Any
    contours_raw, hiers_raw = cv2.findContours(
        warped_blk, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
    )
    out: list[DigitRect] = []
    if hiers_raw is not None:
        [hier_raw] = hiers_raw
        hier_rows: list[npt.NDArray[np.int32]] = [
            np.asarray(row, dtype=np.int32) for row in hier_raw
        ]
        contours: list[npt.NDArray[np.int32]] = [
            np.asarray(c, dtype=np.int32) for c in contours_raw
        ]
        chiers = contour_hier(list(zip(contours, hier_rows, strict=False)), set())
        raw_nums = get_num_contours(chiers, subres)

        for _c, br, _ds in sorted(raw_nums, key=lambda ch: ch[1][0]):
            bx, by, bw, bh = br
            col = (bx + bw // 2) // subres
            row = (by + bh // 2) // subres
            if not (0 <= col < 9 and 0 <= row < 9):
                continue
            for rect in _split_rect(br, warped_blk, subres):
                out.append(DigitRect(row=row, col=col, rect=rect))
    return out


def locate_classic_digit_rects(
    warped_blk: npt.NDArray[np.uint8], subres: int, classic_conf: npt.NDArray[np.bool_]
) -> list[DigitRect]:
    """Locate every pre-filled classic-sudoku digit's source rect."""
    out: list[DigitRect] = []
    for r in range(9):
        for c in range(9):
            if not classic_conf[r, c]:
                continue
            half = subres // 2
            y0 = r * subres + subres // 4
            x0 = c * subres + subres // 4
            patch = warped_blk[y0 : y0 + half, x0 : x0 + half]
            cnts_raw, _ = cv2.findContours(patch, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not cnts_raw:
                continue
            largest = max((np.asarray(cnt) for cnt in cnts_raw), key=cv2.contourArea)
            bx, by, bw, bh = cv2.boundingRect(largest)
            if bw == 0 or bh == 0:
                continue
            ax, ay = x0 + bx, y0 + by
            rect = np.array(
                [[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]], dtype=np.float32
            )
            out.append(DigitRect(row=r, col=c, rect=rect))
    return out
