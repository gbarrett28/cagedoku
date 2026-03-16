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
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.image.number_recognition import (
    CayenneNumber,
    ContourInfo,
    contour_hier,
    get_num_contours,
    split_num,
)
from killer_sudoku.training.status import StatusStore

_log = logging.getLogger(__name__)


def extract_raw_numerals_from_image(
    filepath: Path,
    config: ImagePipelineConfig,
    border_detector: Any,
    num_recogniser: CayenneNumber,
) -> list[tuple[int, npt.NDArray[np.uint8]]]:
    """Extract labelled digit images from a single puzzle image.

    Runs the full pipeline (grid location, border detection, contour extraction,
    number recognition) and returns (label, pixel_image) pairs for every digit
    found in cage-total positions.

    Args:
        filepath: Path to the puzzle .jpg file.
        config: Pipeline configuration (newspaper, resolution, thresholds).
        border_detector: Observer border model, or None for Guardian.
        num_recogniser: Trained digit classifier used to assign labels.

    Returns:
        List of (digit_label, warped_pixel_image) pairs.
    """
    resolution = config.resolution
    subres = config.subres

    gry, img = get_gry_img(filepath, resolution)
    blk, _grid = locate_grid(gry, img, config.grid_location)

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
        cv2.getPerspectiveTransform(_grid, dst_size), dtype=np.float64
    )

    warped_blk: npt.NDArray[np.uint8] = np.asarray(
        cv2.warpPerspective(blk, m, (resolution, resolution), flags=cv2.INTER_LINEAR),
        dtype=np.uint8,
    )

    num_pixels: npt.NDArray[np.object_] = np.empty((9, 9), dtype=object)
    contours_raw: Any
    hiers_raw: Any
    contours_raw, hiers_raw = cv2.findContours(
        warped_blk, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
    )

    if hiers_raw is not None:
        [hier_raw] = hiers_raw
        hier_rows: list[npt.NDArray[np.int32]] = [
            np.asarray(row, dtype=np.int32) for row in hier_raw
        ]
        contours: list[npt.NDArray[np.int32]] = [
            np.asarray(c, dtype=np.int32) for c in contours_raw
        ]
        chiers: list[ContourInfo] = contour_hier(
            list(zip(contours, hier_rows, strict=False)), set()
        )
        raw_nums = get_num_contours(chiers, subres)
        for _c, br, _ds in sorted(raw_nums, key=lambda ch: ch[1][0]):
            num_chiers, x, y = split_num(br, warped_blk, subres)
            col = x // subres
            row = y // subres
            if num_pixels[col, row] is None:
                num_pixels[col, row] = []
            num_pixels[col, row] += num_chiers

    pairs: list[tuple[int, npt.NDArray[np.uint8]]] = []
    for col in range(9):
        for row in range(9):
            sums = num_pixels[row, col]
            if sums is not None:
                labels = num_recogniser.get_sums(sums)
                pairs.extend(
                    (int(lbl), img_arr)
                    for lbl, img_arr in zip(labels.tolist(), sums, strict=False)
                )
    return pairs


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
    status = StatusStore(config.status_path)
    numerals: list[tuple[int, npt.NDArray[np.uint8]]] = []

    for f in itertools.islice(config.puzzle_dir.glob("*.jpg"), None):
        if status[f] == "SOLVED":
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
    args = parser.parse_args()

    config = ImagePipelineConfig(
        puzzle_dir=Path(args.rag),
        newspaper=args.rag,
        rework=args.rework,
    )
    border_detector = InpImage.make_border_detector(config)
    num_recogniser = InpImage.make_num_recogniser(config)

    numerals = collect_numerals(config, border_detector, num_recogniser)

    out_path = config.puzzle_dir / "numerals.pkl"
    with open(out_path, "wb") as fh:
        pickle.dump(numerals, fh)
    _log.info("Saved %d numerals to %s", len(numerals), out_path)


if __name__ == "__main__":
    main()
