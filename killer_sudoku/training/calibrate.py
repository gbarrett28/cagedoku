"""Calibration utilities for image pipeline thresholds.

Provides data-driven calibration of empirical constants that are otherwise
set by visual inspection. Currently calibrates isblack_offset, the offset
subtracted from the histogram-valley black-tone estimate in locate_grid.
"""

import argparse
import logging
from pathlib import Path

import cv2
import numpy as np
import numpy.typing as npt

_log = logging.getLogger(__name__)


def calibrate_isblack_offset(puzzle_dir: Path, n_images: int = 20) -> int:
    """Estimate the isblack_offset constant from real puzzle images.

    locate_grid estimates the darkest-tone threshold via a histogram valley,
    then subtracts isblack_offset to tighten the mask to the grid lines.
    This function calibrates that offset by comparing the histogram-valley
    estimate to Otsu's automatically derived threshold on a sample of images.

    Algorithm:
      1. Sample up to n_images .jpg files from puzzle_dir.
      2. For each image, compute:
           a. histogram_valley: the darkest-tone bin identified by the same
              walk used in locate_grid (before subtracting any offset).
           b. otsu_threshold: the threshold from cv2.threshold with THRESH_OTSU,
              which finds the natural valley between dark (grid) and light (paper).
      3. Return int(mean(histogram_valley - otsu_threshold)) across all samples.
         A positive result means the histogram walk overshoots Otsu; use this
         value as isblack_offset to align them.

    Args:
        puzzle_dir: Directory containing puzzle .jpg images.
        n_images: Maximum number of images to sample (default 20).

    Returns:
        Recommended isblack_offset as an integer.

    Raises:
        ValueError: if no .jpg images are found in puzzle_dir.
    """
    jpg_paths = sorted(puzzle_dir.glob("*.jpg"))[:n_images]
    if not jpg_paths:
        raise ValueError(f"No .jpg images found in {puzzle_dir}")

    diffs: list[int] = []
    for path in jpg_paths:
        gry_raw = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if gry_raw is None:
            _log.warning("Could not read %s; skipping", path)
            continue
        gry: npt.NDArray[np.uint8] = np.asarray(gry_raw, dtype=np.uint8)

        # Histogram-valley estimate (same logic as locate_grid).
        blk_detect = np.reshape(np.ravel(gry), (-1, 1))
        counts: npt.NDArray[np.intp]
        bins: npt.NDArray[np.float64]
        counts, bins = np.histogram(blk_detect, bins=range(0, 257, 16))
        cm = int(np.sum(counts))
        histogram_valley = 256
        for c, b in zip(
            reversed(counts.tolist()), reversed(bins.tolist()), strict=False
        ):
            if c < cm:
                cm = c
                histogram_valley = int(b)
            else:
                break

        # Otsu's automatic threshold.
        otsu_thresh, _ = cv2.threshold(gry, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        otsu = int(otsu_thresh)

        diff = histogram_valley - otsu
        _log.debug(
            "%s: histogram_valley=%d, otsu=%d, diff=%d",
            path.name,
            histogram_valley,
            otsu,
            diff,
        )
        diffs.append(diff)

    if not diffs:
        raise ValueError("No images could be read from puzzle_dir")

    recommended = int(round(float(np.mean(diffs))))
    _log.info(
        "Calibrated isblack_offset=%d from %d images (mean diff=%.1f)",
        recommended,
        len(diffs),
        float(np.mean(diffs)),
    )
    return recommended


def main() -> None:
    """CLI entry point: calibrate isblack_offset and print the result."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Calibrate isblack_offset from puzzle images"
    )
    parser.add_argument("--rag", choices=["guardian", "observer"], required=True)
    parser.add_argument(
        "--n-images",
        type=int,
        default=20,
        help="Number of images to sample (default: 20)",
    )
    args = parser.parse_args()

    result = calibrate_isblack_offset(Path(args.rag), n_images=args.n_images)
    print(f"Recommended isblack_offset for {args.rag}: {result}")


if __name__ == "__main__":
    main()
