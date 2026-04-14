"""Augment the digit training set with pre-filled digits from a classic sudoku image.

Extracts digit patches from a classic sudoku (e.g. NYT) using the same
cell-centred pipeline as read_classic_digits, augments each patch with
Gaussian noise and small translations to synthesise additional samples, and
appends the results to an existing numerals.pkl for retraining.

Ground truth is taken from the existing digit recogniser by default; use
--override to correct any misrecognised cells before appending.

Usage::

    python -m killer_sudoku.training.collect_classic_numerals \\
        --image Untitled.png \\
        --numerals guardian/numerals.pkl \\
        --n-augments 15 \\
        --override 3,3,1 \\
        --override 7,5,1
"""

from __future__ import annotations

import argparse
import logging
import pickle
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.cell_scan import detect_rotation, scan_cells
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.image.number_recognition import CayenneNumber, get_warp_from_rect

_log = logging.getLogger(__name__)


def _extract_raw_patches(
    warped_blk: npt.NDArray[np.uint8],
    classic_conf: npt.NDArray[np.float64],
    subres: int,
) -> dict[tuple[int, int], npt.NDArray[np.uint8]]:
    """Extract raw digit patches for each pre-filled cell in a classic sudoku.

    Mirrors the inner loop of read_classic_digits (number_recognition.py) but
    returns the warped patch array instead of a recognised digit label.  Each
    returned patch is (half, half) uint8, where half = subres // 2.

    Args:
        warped_blk: Warped binary image (ink=white, background=black).
        classic_conf: (9, 9) array from scan_cells; > 0 means the cell has a digit.
        subres: Pixels per cell side in warped_blk.

    Returns:
        Dict mapping (row, col) to a (half, half) uint8 patch.  Cells where
        no valid contour can be found are omitted.
    """
    half = subres // 2
    patches: dict[tuple[int, int], npt.NDArray[np.uint8]] = {}
    for r in range(9):
        for c in range(9):
            if classic_conf[r, c] == 0.0:
                continue
            y0 = r * subres + subres // 4
            x0 = c * subres + subres // 4
            crop: npt.NDArray[np.uint8] = warped_blk[y0 : y0 + half, x0 : x0 + half]
            cnts_raw: Any
            cnts_raw, _ = cv2.findContours(
                crop, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            if not cnts_raw:
                continue
            largest = max(
                (np.asarray(cnt, dtype=np.int32) for cnt in cnts_raw),
                key=cv2.contourArea,
            )
            bx, by, bw, bh = cv2.boundingRect(largest)
            if bw == 0 or bh == 0:
                continue
            # Translate bounding rect back to warped_blk coordinates.
            ax, ay = x0 + bx, y0 + by
            rect = np.array(
                [[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]],
                dtype=np.float32,
            )
            thumb = get_warp_from_rect(rect, warped_blk, res=(half, half))
            patches[(r, c)] = thumb
    return patches


def _augment_patch(
    patch: npt.NDArray[np.uint8],
    n: int,
    rng: np.random.Generator,
) -> list[npt.NDArray[np.uint8]]:
    """Generate n augmented copies of a digit patch.

    Applies a random combination of Gaussian noise, brightness scaling, and
    sub-pixel translation (+-2 px) to each copy.  The original patch is NOT
    included in the returned list.

    Args:
        patch: (H, W) uint8 binary-ish digit patch (ink=white, bg=black).
        n: Number of augmented copies to produce.
        rng: NumPy random Generator for reproducibility.

    Returns:
        List of n augmented (H, W) uint8 patches.
    """
    h, w = patch.shape
    result: list[npt.NDArray[np.uint8]] = []
    for _ in range(n):
        aug = patch.astype(np.float32)

        # Gaussian noise: sigma=12 adds visible grain without destroying ink structure.
        noise: npt.NDArray[np.float32] = np.asarray(
            rng.normal(0.0, 12.0, size=aug.shape), dtype=np.float32
        )
        aug = aug + noise

        # Brightness scaling +-10%: mimics exposure variation between photos.
        scale = float(rng.uniform(0.9, 1.1))
        aug = aug * scale

        # Random translation +-2 px: mimics OCR crop misalignment.
        dx = int(rng.integers(-2, 3))
        dy = int(rng.integers(-2, 3))
        mat = np.array([[1.0, 0.0, float(dx)], [0.0, 1.0, float(dy)]], dtype=np.float32)
        aug = np.asarray(cv2.warpAffine(aug, mat, (w, h)), dtype=np.float32)

        result.append(np.clip(aug, 0.0, 255.0).astype(np.uint8))
    return result


def collect_classic_numerals(
    image_path: Path,
    config: ImagePipelineConfig,
    num_recogniser: CayenneNumber,
    n_augments: int,
    overrides: dict[tuple[int, int], int],
    rng: np.random.Generator,
) -> list[tuple[int, npt.NDArray[np.uint8]]]:
    """Extract and augment digit patches from a classic sudoku image.

    Runs grid location and perspective warp on image_path, detects pre-filled
    cells via scan_cells, extracts per-cell digit patches, labels them with
    num_recogniser (then applies any overrides), and returns the original plus
    n_augments augmented copies of each patch.

    Args:
        image_path: Path to the classic sudoku image.
        config: Pipeline configuration.
        num_recogniser: Trained digit classifier for initial labelling.
        n_augments: Number of augmented copies per digit patch.
        overrides: Dict of (row, col) to correct_digit (0-based) to fix
            misrecognised cells before augmentation.
        rng: NumPy random Generator for augmentation.

    Returns:
        List of (label, patch) pairs: one original + n_augments augmented
        copies per detected pre-filled cell.
    """
    subres = config.subres
    resolution = config.resolution

    gry, _img = get_gry_img(image_path, resolution)
    blk, grid = locate_grid(gry, config.grid_location)

    dst_size = np.array(
        [
            [0, 0],
            [resolution - 1, 0],
            [resolution - 1, resolution - 1],
            [0, resolution - 1],
        ],
        dtype=np.float32,
    )
    m: npt.NDArray[np.float64] = np.asarray(
        cv2.getPerspectiveTransform(grid, dst_size), dtype=np.float64
    )
    warped_blk: npt.NDArray[np.uint8] = np.asarray(
        cv2.warpPerspective(blk, m, (resolution, resolution), flags=cv2.INTER_LINEAR),
        dtype=np.uint8,
    )
    warped_gry: npt.NDArray[np.uint8] = np.asarray(
        cv2.warpPerspective(gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR),
        dtype=np.uint8,
    )

    # Correct for rotated source images (same logic as InpImage.__init__).
    rotation_k = detect_rotation(
        warped_gry, subres, config.cell_scan.rotation_dominance_threshold
    )
    if rotation_k != 0:
        grid = np.roll(grid, -rotation_k, axis=0)
        m = np.asarray(cv2.getPerspectiveTransform(grid, dst_size), dtype=np.float64)
        warped_blk = np.asarray(
            cv2.warpPerspective(
                blk, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )
        warped_gry = np.asarray(
            cv2.warpPerspective(
                gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )

    _cage_conf, classic_conf = scan_cells(warped_gry, subres, config.cell_scan)

    patches = _extract_raw_patches(warped_blk, classic_conf, subres)
    _log.info("Detected %d pre-filled cells in %s", len(patches), image_path.name)

    # Label each patch; apply ground-truth overrides for known OCR errors.
    result: list[tuple[int, npt.NDArray[np.uint8]]] = []
    for (r, c), patch in sorted(patches.items()):
        if (r, c) in overrides:
            label = overrides[(r, c)]
            _log.info("  r%dc%d: override -> %d", r + 1, c + 1, label)
        else:
            labels = num_recogniser.get_sums([patch])
            label = int(labels[0])
            if label == 0:
                _log.warning(
                    "  r%dc%d: recogniser returned 0 -- skipping", r + 1, c + 1
                )
                continue
            _log.debug("  r%dc%d: recognised as %d", r + 1, c + 1, label)

        # Include the raw patch plus n_augments augmented copies.
        result.append((label, patch))
        for aug in _augment_patch(patch, n_augments, rng):
            result.append((label, aug))

    return result


def main() -> None:
    """CLI entry point: augment numerals.pkl with classic sudoku digits."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description=(
            "Augment the digit training set with pre-filled digits from a "
            "classic sudoku image."
        )
    )
    parser.add_argument(
        "--image", required=True, help="Path to the classic sudoku image"
    )
    parser.add_argument(
        "--numerals",
        required=True,
        help="Path to numerals.pkl to augment (modified in-place)",
    )
    parser.add_argument(
        "--n-augments",
        type=int,
        default=15,
        help="Augmented copies per digit patch (default: 15)",
    )
    parser.add_argument(
        "--override",
        action="append",
        default=[],
        metavar="ROW,COL,DIGIT",
        help=(
            "Override recogniser label for a cell. "
            "ROW and COL are 1-based. Can be repeated. "
            "Example: --override 3,3,1"
        ),
    )
    parser.add_argument("--seed", type=int, default=42, help="RNG seed (default: 42)")
    args = parser.parse_args()

    # Parse --override arguments: convert from 1-based to 0-based row/col.
    overrides: dict[tuple[int, int], int] = {}
    for spec in args.override:
        parts = spec.split(",")
        if len(parts) != 3:
            parser.error(f"--override must be ROW,COL,DIGIT; got: {spec!r}")
        r1, c1, d = int(parts[0]), int(parts[1]), int(parts[2])
        overrides[(r1 - 1, c1 - 1)] = d
    if overrides:
        _log.info("Ground truth overrides (0-based): %s", overrides)

    config = ImagePipelineConfig()
    num_recogniser = InpImage.make_num_recogniser()
    rng = np.random.default_rng(args.seed)

    new_pairs = collect_classic_numerals(
        image_path=Path(args.image),
        config=config,
        num_recogniser=num_recogniser,
        n_augments=args.n_augments,
        overrides=overrides,
        rng=rng,
    )

    numerals_path = Path(args.numerals)
    with open(numerals_path, "rb") as fh:
        existing: list[tuple[int, npt.NDArray[np.uint8]]] = pickle.load(fh)

    n_cells = len(new_pairs) // (args.n_augments + 1)
    _log.info(
        "Appending %d new pairs (%d cells x %d augments + originals) to %s "
        "(currently %d pairs)",
        len(new_pairs),
        n_cells,
        args.n_augments,
        numerals_path,
        len(existing),
    )
    combined = existing + new_pairs
    with open(numerals_path, "wb") as fh:
        pickle.dump(combined, fh)
    _log.info("Saved %d total pairs to %s", len(combined), numerals_path)


if __name__ == "__main__":
    main()
