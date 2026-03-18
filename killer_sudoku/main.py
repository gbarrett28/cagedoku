"""Entry point for the killer sudoku solver.

Parses a newspaper puzzle image (Guardian or Observer), extracts the cage
structure, and solves the puzzle using constraint-based deduction. Falls
back to a generic CSP solver if the human-like methods do not fully solve it.

Usage:
    python -m killer_sudoku.main --rag guardian
    python -m killer_sudoku.main --rag observer --rework
    killer-sudoku --rag guardian   # if installed via pyproject.toml entry point
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

    Constructs all dependencies lazily (config → border detector → number
    recogniser → InpImage → Grid), solves, and displays the solution image.
    Falls back to Grid.cheat_solve() when the constraint solver does not
    reach a unique solution. ProcessingError is caught and reported to stderr.
    """
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Killer sudoku solver for Guardian/Observer newspaper puzzles"
    )
    parser.add_argument(
        "--rag",
        choices=["guardian", "observer"],
        required=True,
        help="Newspaper source — determines which image directory and models to use",
    )
    parser.add_argument(
        "--rework",
        action="store_true",
        default=False,
        help="Reprocess images even if a cached .jpk file exists",
    )
    args = parser.parse_args()

    config = ImagePipelineConfig(
        puzzle_dir=Path(args.rag),
        newspaper=args.rag,
        rework=args.rework,
    )

    # Lazy factory methods — no I/O until called here.
    border_detector = InpImage.make_border_detector(config)
    num_recogniser = InpImage.make_num_recogniser(config)

    for filepath in sorted(config.puzzle_dir.glob("*.jpg")):
        _log.info("Processing %s...", filepath)

        try:
            inp = InpImage(filepath, config, border_detector, num_recogniser)
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
            _log.info("  Incomplete (alts_sum=%d), falling back to CSP...", alts_sum)
            grd.cheat_solve()

        cv2.imshow("Solution", grd.sol_img.sol_img)
        cv2.waitKey(0)
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
