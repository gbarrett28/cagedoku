"""Unit tests for detect_puzzle_type and detect_rotation in cell_scan."""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from killer_sudoku.image.cell_scan import detect_puzzle_type, detect_rotation

SUBRES = 64  # Small but valid subres for fast tests
THRESHOLD = 0.50  # rotation_dominance_threshold


def _blank_warped() -> npt.NDArray[np.uint8]:
    """White (255) grid: no ink anywhere."""
    return np.full((SUBRES * 9, SUBRES * 9), 255, dtype=np.uint8)


def _killer_warped(corner: int = 0, n_cage_cells: int = 25) -> npt.NDArray[np.uint8]:
    """Grid with ink concentrated in one inner quadrant of n cells.

    corner: 0=TL, 1=TR, 2=BL, 3=BR (matches quad_sums index).
    """
    warped = _blank_warped()
    margin = SUBRES // 6
    inner = SUBRES - 2 * margin
    half_inner = inner // 2
    count = 0
    for row in range(9):
        for col in range(9):
            if count >= n_cage_cells:
                break
            y0 = row * SUBRES + margin
            x0 = col * SUBRES + margin
            ry = 0 if corner in (0, 1) else half_inner  # top or bottom half
            rx = 0 if corner in (0, 2) else half_inner  # left or right half
            warped[y0 + ry : y0 + ry + half_inner, x0 + rx : x0 + rx + half_inner] = 0
            count += 1
        if count >= n_cage_cells:
            break
    return warped


class TestDetectPuzzleType:
    def test_blank_image_is_killer(self) -> None:
        """A blank (no-ink) image defaults to killer."""
        assert detect_puzzle_type(_blank_warped(), SUBRES, 0.40) == "killer"

    def test_tl_only_ink_is_killer(self) -> None:
        """Ink concentrated in TL inner quadrant → killer."""
        assert detect_puzzle_type(_killer_warped(corner=0), SUBRES, 0.40) == "killer"

    def test_equal_quadrant_ink_is_classic(self) -> None:
        """Ink equal across all four inner quadrants → classic."""
        warped = _blank_warped()
        margin = SUBRES // 6
        inner = SUBRES - 2 * margin
        for row in range(9):
            for col in range(9):
                y0 = row * SUBRES + margin
                x0 = col * SUBRES + margin
                warped[y0 : y0 + inner, x0 : x0 + inner] = 0
        assert detect_puzzle_type(warped, SUBRES, 0.40) == "classic"

    def test_single_cage_total_cell_is_killer(self) -> None:
        """Even one TL-only cell is enough to dominate when others are blank."""
        warped = _killer_warped(corner=0, n_cage_cells=1)
        assert detect_puzzle_type(warped, SUBRES, 0.40) == "killer"

    def test_non_tl_dominant_still_killer(self) -> None:
        """Ink in TR (rotated puzzle) → still killer (max-fraction test)."""
        assert detect_puzzle_type(_killer_warped(corner=1), SUBRES, 0.40) == "killer"


class TestDetectRotation:
    def test_canonical_tl_orientation_no_rotation(self) -> None:
        """TL-dominant image returns k=0 (no rotation needed)."""
        assert detect_rotation(_killer_warped(corner=0), SUBRES, THRESHOLD) == 0

    def test_blank_image_no_rotation(self) -> None:
        """Blank image returns k=0 (insufficient ink to infer orientation)."""
        assert detect_rotation(_blank_warped(), SUBRES, THRESHOLD) == 0

    def test_tr_dominant_returns_k1(self) -> None:
        """Ink in TR inner quadrant → k=1 (roll corners -1 brings TR to TL)."""
        assert detect_rotation(_killer_warped(corner=1), SUBRES, THRESHOLD) == 1

    def test_bl_dominant_returns_k3(self) -> None:
        """Ink in BL inner quadrant → k=3 (roll corners -3 brings BL to TL)."""
        assert detect_rotation(_killer_warped(corner=2), SUBRES, THRESHOLD) == 3

    def test_br_dominant_returns_k2(self) -> None:
        """Ink in BR inner quadrant → k=2 (roll corners -2 brings BR to TL)."""
        assert detect_rotation(_killer_warped(corner=3), SUBRES, THRESHOLD) == 2

    def test_equal_quadrant_ink_suppresses_rotation(self) -> None:
        """When ink is spread equally across all four quadrants, no rotation is applied.

        Equal distribution gives each quadrant ~0.25 of total ink, well below
        the default rotation_dominance_threshold of 0.50.
        """
        warped = _blank_warped()
        margin = SUBRES // 6
        inner = SUBRES - 2 * margin
        # Fill the entire inner region of every cell — equal ink in all four quadrants
        for row in range(9):
            for col in range(9):
                y0 = row * SUBRES + margin
                x0 = col * SUBRES + margin
                warped[y0 : y0 + inner, x0 : x0 + inner] = 0
        assert detect_rotation(warped, SUBRES, THRESHOLD) == 0

    def test_threshold_suppresses_weak_tr_signal(self) -> None:
        """A threshold above the dominant fraction suppresses rotation."""
        warped = _killer_warped(corner=1)
        # Threshold of 0.50 lets a pure-TR image (fraction ≈1.0) through;
        # the threshold is exceeded, so rotation IS applied.
        assert detect_rotation(warped, SUBRES, THRESHOLD) == 1
        # A threshold > 1.0 is impossible to exceed: no rotation applied.
        assert detect_rotation(warped, SUBRES, 1.01) == 0
