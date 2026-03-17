"""Step 1 of the digit training pipeline: extract raw digit images from solved puzzles.

Runs grid detection and contour extraction on each solved puzzle image to
collect a dataset of raw digit images paired with their labels (from the
existing recogniser). The resulting list of (label, pixel_image) pairs is
saved to {puzzle_dir}/numerals.pkl for use by train_number_recogniser.

Usage:
    python -m killer_sudoku.training.collect_numerals --rag guardian
    python -m killer_sudoku.training.collect_numerals --rag observer --rework
"""

import argparse
import itertools
import logging
import pickle
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid
from killer_sudoku.image.inp_image import InpImage, PicInfo  # noqa: F401
from killer_sudoku.image.number_recognition import (
    CayenneNumber,
    ContourInfo,
    contour_hier,
    get_num_contours,
    split_num,
)
from killer_sudoku.training.status import TRAINING_STATUSES, StatusStore

_log = logging.getLogger(__name__)


def _extract_cell_contours(
    filepath: Path,
    config: ImagePipelineConfig,
) -> dict[tuple[int, int], list[npt.NDArray[np.uint8]]]:
    """Extract raw contour thumbnails per cell without digit recognition.

    Runs grid location, perspective warp, contour extraction, and digit
    splitting to produce a mapping of cell coordinates to contour thumbnail
    lists.  Uses the same cell-indexing convention as InpImage (outer loop
    variable is col, inner is row).

    Args:
        filepath: Path to the puzzle .jpg image file.
        config: Pipeline configuration (resolution, thresholds).

    Returns:
        Dict mapping (col, row) to list of warped contour thumbnails for that cell.

    Raises:
        AssertionError: if grid lines or intersections cannot be found.
    """
    resolution = config.resolution
    subres = config.subres

    gry, img = get_gry_img(filepath, resolution)
    blk, grid = locate_grid(gry, img, config.grid_location)

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

    # num_pixels is written at [x//subres, y//subres] (column-major) and read
    # back as [row_var, col_var] in the output loop below; same convention as
    # InpImage.__init__.
    num_pixels: npt.NDArray[np.object_] = np.empty((9, 9), dtype=object)
    contours_raw: Any
    hiers_raw: Any
    contours_raw, hiers_raw = cv2.findContours(
        warped_blk, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
    )
    if hiers_raw is not None:
        [hier_raw] = hiers_raw
        hier_rows: list[npt.NDArray[np.int32]] = [
            np.asarray(r, dtype=np.int32) for r in hier_raw
        ]
        contours: list[npt.NDArray[np.int32]] = [
            np.asarray(c, dtype=np.int32) for c in contours_raw
        ]
        chiers: list[ContourInfo] = contour_hier(
            list(zip(contours, hier_rows, strict=False)), set()
        )
        raw_nums = get_num_contours(chiers, subres)
        for _c, br, _ds in sorted(raw_nums, key=lambda ch: ch[1][0]):
            try:
                num_chiers, x, y = split_num(br, warped_blk, subres)
            except ValueError:
                _log.debug("Skipping contour with ambiguous geometry: %s", br)
                continue
            col = x // subres
            row = y // subres
            if num_pixels[col, row] is None:
                num_pixels[col, row] = []
            num_pixels[col, row] += num_chiers

    result: dict[tuple[int, int], list[npt.NDArray[np.uint8]]] = {}
    for col in range(9):
        for row in range(9):
            cell: list[npt.NDArray[np.uint8]] | None = num_pixels[row, col]
            if cell is not None:
                result[(col, row)] = cell
    return result


def extract_raw_numerals_from_image(
    filepath: Path,
    config: ImagePipelineConfig,
    border_detector: Any,
    num_recogniser: CayenneNumber,
) -> list[tuple[int, npt.NDArray[np.uint8]]]:
    """Extract labelled digit images from a single puzzle image.

    Runs grid location, contour extraction, and number recognition to produce
    (label, pixel_image) pairs for every digit found in cage-total positions.

    Args:
        filepath: Path to the puzzle .jpg file.
        config: Pipeline configuration (newspaper, resolution, thresholds).
        border_detector: Unused; retained for call-site compatibility.
        num_recogniser: Trained digit classifier used to assign labels.

    Returns:
        List of (digit_label, warped_pixel_image) pairs.
    """
    cell_contours = _extract_cell_contours(filepath, config)
    pairs: list[tuple[int, npt.NDArray[np.uint8]]] = []
    for col in range(9):
        for row in range(9):
            sums = cell_contours.get((col, row))
            if sums is not None:
                labels = num_recogniser.get_sums(sums)
                pairs.extend(
                    (int(lbl), img_arr)
                    for lbl, img_arr in zip(labels.tolist(), sums, strict=False)
                )
    return pairs


def bootstrap_numerals(
    config: ImagePipelineConfig,
) -> list[tuple[int, npt.NDArray[np.uint8]]]:
    """Bootstrap digit labels from ground-truth cage totals in solved puzzles.

    Unlike collect_numerals, this function requires no digit recogniser.
    The cage_totals in each .jpk cache file provide ground-truth labels.
    For each TRAINING_STATUS puzzle with a .jpk file, contours are re-extracted
    from the .jpg and matched positionally to the cage total string.

    Labelling rule: if the number of contours in cell (col, row) exactly
    equals the number of digits in cage_totals[col, row], the contours are
    paired left-to-right with the digit characters.  Mismatches are skipped.

    Args:
        config: Pipeline configuration (supplies puzzle_dir, status_path, etc.).

    Returns:
        List of (digit_label, warped_pixel_image) pairs across all training puzzles.
    """
    status = StatusStore(config.status_path, config.puzzle_dir)
    numerals: list[tuple[int, npt.NDArray[np.uint8]]] = []

    for f in itertools.islice(config.puzzle_dir.glob("*.jpg"), None):
        if status[f] not in TRAINING_STATUSES:
            continue
        jpk = f.with_suffix(".jpk")
        if not jpk.exists():
            _log.debug("No .jpk cache for %s; skipping bootstrap", f)
            continue

        _log.info("Processing (bootstrap_numerals) %s...", f)
        try:
            with open(jpk, "rb") as fh:
                pic_info: PicInfo = pickle.load(fh)
            cell_contours = _extract_cell_contours(f, config)
        except (AssertionError, ValueError) as exc:
            _log.warning("Skipping %s in bootstrap: %s", f, exc)
            continue

        for col in range(9):
            for row in range(9):
                total = int(pic_info.cage_totals[col, row])
                if total == 0:
                    continue
                total_str = str(total)
                contour_imgs = cell_contours.get((col, row))
                if contour_imgs is None or len(contour_imgs) != len(total_str):
                    continue
                for digit_char, img_arr in zip(total_str, contour_imgs, strict=True):
                    numerals.append((int(digit_char), img_arr))

    _log.info("Bootstrapped %d numerals", len(numerals))
    return numerals


def collect_numerals(
    config: ImagePipelineConfig,
    border_detector: Any,
    num_recogniser: CayenneNumber,
) -> list[tuple[int, npt.NDArray[np.uint8]]]:
    """Collect labelled digit images from all solved puzzles.

    Iterates over every SOLVED puzzle in config.puzzle_dir, running the full
    contour extraction pipeline on each, and aggregates the resulting
    (label, pixel_image) pairs.

    Args:
        config: Pipeline configuration (supplies puzzle_dir, status_path, etc.).
        border_detector: Observer border model or None for Guardian.
        num_recogniser: Trained CayenneNumber classifier for assigning labels.

    Returns:
        List of (digit_label, warped_pixel_image) pairs across all solved puzzles.
    """
    status = StatusStore(config.status_path, config.puzzle_dir)
    numerals: list[tuple[int, npt.NDArray[np.uint8]]] = []

    for f in itertools.islice(config.puzzle_dir.glob("*.jpg"), None):
        if status[f] in TRAINING_STATUSES:
            _log.info("Processing (collect_numerals) %s...", f)
            pairs = extract_raw_numerals_from_image(
                f, config, border_detector, num_recogniser
            )
            numerals.extend(pairs)

    _log.info("Number of numerals: %d", len(numerals))
    return numerals


def main() -> None:
    """CLI entry point: collect digit training data and save to numerals.pkl."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Extract digit training data from solved puzzles"
    )
    parser.add_argument("--rag", choices=["guardian", "observer"], required=True)
    parser.add_argument("--rework", action="store_true", default=False)
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        default=False,
        help=(
            "Label digits from .jpk cage totals instead of recogniser predictions. "
            "Breaks the circular training dependency; no trained model needed."
        ),
    )
    args = parser.parse_args()

    config = ImagePipelineConfig(
        puzzle_dir=Path(args.rag),
        newspaper=args.rag,
        rework=args.rework,
    )

    if args.bootstrap:
        numerals = bootstrap_numerals(config)
        out_path = config.puzzle_dir / "bootstrap_numerals.pkl"
    else:
        border_detector = InpImage.make_border_detector(config)
        num_recogniser = InpImage.make_num_recogniser(config)
        numerals = collect_numerals(config, border_detector, num_recogniser)
        out_path = config.puzzle_dir / "numerals.pkl"

    with open(out_path, "wb") as fh:
        pickle.dump(numerals, fh)
    _log.info("Saved %d numerals to %s", len(numerals), out_path)


if __name__ == "__main__":
    main()
