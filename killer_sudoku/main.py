"""Entry point for the killer sudoku solver.

Parses a puzzle image, extracts the cage structure, and solves the puzzle
using constraint-based deduction with MRV backtracking as a fallback.

Usage:
    python -m killer_sudoku.main --puzzle-dir <dir>
    python -m killer_sudoku.main --puzzle-dir <dir> --rework
    killer-sudoku --puzzle-dir <dir>   # if installed via pyproject.toml entry point
"""

import argparse
import logging
from pathlib import Path

import cv2

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.solver.grid import Grid, ProcessingError

_log = logging.getLogger(__name__)


def main() -> None:
    """Parse arguments, run the image pipeline, and solve the puzzle.

    Constructs all dependencies lazily (config → number recogniser → InpImage
    → Grid), solves, and displays the solution image.
    ProcessingError is caught and reported to stderr.
    """
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Killer sudoku solver: parse a puzzle image and solve it"
    )
    parser.add_argument(
        "--puzzle-dir",
        required=True,
        help="Directory containing puzzle .jpg images",
    )
    parser.add_argument(
        "--rework",
        action="store_true",
        default=False,
        help="Reprocess images even if a cached .jpk file exists",
    )
    args = parser.parse_args()

    config = ImagePipelineConfig(
        puzzle_dir=Path(args.puzzle_dir),
        rework=args.rework,
    )

    # Lazy factory method — no I/O until called here.
    num_recogniser = InpImage.make_num_recogniser()

    for filepath in sorted(config.puzzle_dir_required.glob("*.jpg")):
        _log.info("Processing %s...", filepath)

        try:
            inp = InpImage(filepath, config, num_recogniser)
            assert inp.spec is not None, inp.spec_error
        except (AssertionError, ValueError, ProcessingError) as exc:
            _log.error("  Skipping %s: image pipeline failed -- %s", filepath, exc)
            continue

        grd = Grid()
        grd.set_up(inp.spec)

        try:
            alts_sum, _solns_sum = grd.engine_solve()
        except (AssertionError, ValueError) as exc:
            _log.error("  Solve error for %s -- %s", filepath, exc)
            alts_sum = 0

        if alts_sum != 81:
            _log.info("  Incomplete (alts_sum=%d) — some cells undetermined", alts_sum)

        cv2.imshow("Solution", grd.sol_img.sol_img)
        cv2.waitKey(0)
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
