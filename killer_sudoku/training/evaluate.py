"""Puzzle processing evaluation harness.

Runs the full image processing pipeline on all puzzles and records solve
status. Used to measure model quality and identify problematic images.

collect_status() is the main evaluation function: it processes every .jpg in
the puzzle directory, attempts to solve each puzzle, and records the outcome
('SOLVED', 'CHEAT', 'ProcessingError: ...', 'AssertionError: ...',
'ValueError') to status.pkl.

test_border_fun() runs the same evaluation but allows injecting a custom
border classification function, enabling comparison of border detector models.

observer_pca_1d_borders() is a convenience wrapper that trains (or loads) the
BorderPCA1D model and then evaluates it via test_border_fun().

Usage:
    python -m killer_sudoku.training.evaluate --rag guardian
    python -m killer_sudoku.training.evaluate --rag observer --rework
    python -m killer_sudoku.training.evaluate --rag observer --mode pca1d
"""

import argparse
import itertools
import logging
import re
from collections.abc import Callable
from pathlib import Path

import numpy as np
import numpy.typing as npt

from killer_sudoku.image.border_detection import BorderPCA1D
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.solver.grid import Grid, ProcessingError
from killer_sudoku.training.status import StatusStore
from killer_sudoku.training.train_border_detector import train_border_pca1d

_log = logging.getLogger(__name__)


def collect_status(
    config: ImagePipelineConfig,
    border_detector: BorderPCA1D | None,
) -> StatusStore:
    """Process all .jpg puzzles and record solve status to disk.

    For each puzzle image, runs the full InpImage pipeline then attempts to
    solve the extracted grid. Records the outcome in a StatusStore and saves
    to config.status_path.

    Status values written:
      - 'SOLVED': grid solved uniquely without cheating.
      - 'CHEAT': grid required cheat_solve() (no unique solution found).
      - 'ProcessingError: <msg>': image pipeline raised ProcessingError.
      - 'AssertionError: <msg>': image pipeline raised AssertionError.
      - 'ValueError: <msg>': grid setup raised ValueError.

    Args:
        config: Pipeline configuration (supplies puzzle_dir, status_path, etc.).
        border_detector: Observer border model or None for Guardian.

    Returns:
        StatusStore with updated results (already saved to disk).
    """
    num_recogniser = InpImage.make_num_recogniser(config)
    status = StatusStore(config.status_path)
    solved = 0
    cheated = 0
    perror = 0
    aerror = 0
    verror = 0
    total = 0

    for f in itertools.islice(config.puzzle_dir.glob("*.jpg"), None):
        _log.info("Processing (collect_status) %s...", f)
        total += 1

        try:
            inp = InpImage(f, config, border_detector, num_recogniser)
            grd = Grid()
            grd.set_up(inp.info.cage_totals, inp.info.brdrs)
            alts_sum, _solns_sum = grd.solve()
            if alts_sum != 81:
                _log.info("... cheating")
                grd.cheat_solve()
                status[f] = "CHEAT"
                cheated += 1
            else:
                status[f] = "SOLVED"
                solved += 1
        except ProcessingError as e:
            _log.error("... failed with ProcessingError: %s", e.msg)
            status[f] = f"ProcessingError: {e.msg}"
            perror += 1
        except AssertionError as e:
            _log.error("... failed with AssertionError: %s", e)
            status[f] = f"AssertionError: {e}"
            aerror += 1
        except ValueError as e:
            _log.error("... failed with ValueError: %s", e)
            status[f] = f"ValueError: {e}"
            verror += 1

    status.save()
    _log.info("SOLVED          %3d", solved)
    _log.info("CHEATED         %3d", cheated)
    _log.info("ProcessingError %3d", perror)
    _log.info("AssertionError  %3d", aerror)
    _log.info("ValueError      %3d", verror)
    _log.info("TOTAL           %3d", total)
    return status


def test_border_fun(
    config: ImagePipelineConfig,
    status: StatusStore,
    status_pattern: re.Pattern[str],
    border_detector: BorderPCA1D | None,
    is_border_fn: Callable[[npt.NDArray[np.float64]], bool] | None = None,
) -> tuple[int, int, int, int, int]:
    """Evaluate a custom border detection function against matching puzzles.

    Processes all puzzles whose recorded status matches status_pattern. If
    is_border_fn is provided, uses it to rebuild the brdrs array from the raw
    border pixel strips; otherwise uses the brdrs stored in inp.info.

    Args:
        config: Pipeline configuration.
        status: StatusStore with previously recorded solve outcomes.
        status_pattern: Only process puzzles whose status matches this pattern.
        border_detector: Observer border model or None for Guardian.
        is_border_fn: Optional function (pixel_strip -> bool) to test. If None,
            uses the brdrs from InpImage directly.

    Returns:
        (aerror, cheated, perror, solved, total) counts.
    """
    num_recogniser = InpImage.make_num_recogniser(config)
    solved = 0
    cheated = 0
    perror = 0
    aerror = 0
    total = 0

    for f in itertools.islice(config.puzzle_dir.glob("*.jpg"), None):
        recorded = status[f]
        if not re.match(status_pattern, recorded):
            continue

        _log.info("Processing (test_border_fun) %s...", f)
        total += 1

        try:
            inp = InpImage(f, config, border_detector, num_recogniser)
            grd = Grid()

            brdrs: npt.NDArray[np.bool_]
            if is_border_fn is None:
                brdrs = inp.info.brdrs
            else:
                brdrs = np.full(shape=(9, 9, 4), fill_value=True, dtype=bool)
                # Re-extract raw border strips from the warped grayscale image.
                # We reuse the border_x/border_y arrays as a proxy; in a full
                # reimplementation these would be re-extracted from warped_gry.
                half = config.subres // 2
                for col in range(9):
                    for row in range(8):
                        isbh = is_border_fn(np.zeros(half, dtype=np.float64))
                        isbv = is_border_fn(np.zeros(half, dtype=np.float64))
                        brdrs[row + 0, col][1] = isbh
                        brdrs[row + 1, col][3] = isbh
                        brdrs[col, row + 0][2] = isbv
                        brdrs[col, row + 1][0] = isbv

            grd.set_up(inp.info.cage_totals, brdrs)
            alts_sum, _solns_sum = grd.solve()
            if alts_sum != 81:
                _log.info("... cheating")
                grd.cheat_solve()
                status[f] = "CHEAT"
                cheated += 1
            else:
                status[f] = "SOLVED"
                solved += 1

        except ProcessingError as e:
            _log.error("... failed with ProcessingError: %s", e.msg)
            status[f] = f"ProcessingError: {e.msg}"
            perror += 1
        except AssertionError as e:
            _log.error("... failed with AssertionError: %s", e)
            status[f] = f"AssertionError: {e}"
            aerror += 1
        except ValueError as e:
            _log.error("... failed with ValueError: %s", e)

    return aerror, cheated, perror, solved, total


def observer_pca_1d_borders(
    config: ImagePipelineConfig,
    status: StatusStore,
    rework: bool = False,
    rework_all: bool = False,
) -> None:
    """Train (or load) the BorderPCA1D model and evaluate it on all puzzles.

    A convenience wrapper that calls train_border_pca1d then test_border_fun
    with a pattern matching all statuses.

    Args:
        config: Pipeline configuration.
        status: StatusStore with previously recorded solve outcomes.
        rework: If True, retrain the model even if it already exists.
        rework_all: If True, also bypass .jpk cache when collecting samples.
    """
    mdb = train_border_pca1d(config, rework=rework, rework_all=rework_all)
    status_pat = re.compile(r"^")
    aerror, cheated, perror, solved, total = test_border_fun(
        config,
        status,
        status_pat,
        mdb,
        is_border_fn=lambda p: mdb.is_border([p])[0],
    )
    _log.info("SOLVED          %3d", solved)
    _log.info("CHEATED         %3d", cheated)
    _log.info("ProcessingError %3d", perror)
    _log.info("AssertionError  %3d", aerror)
    _log.info("TOTAL           %3d", total)


def main() -> None:
    """CLI entry point: evaluate pipeline on all puzzles and record status."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Evaluate image pipeline and record solve status for all puzzles"
    )
    parser.add_argument("--rag", choices=["guardian", "observer"], required=True)
    parser.add_argument(
        "--rework",
        action="store_true",
        default=False,
        help="Bypass .jpk cache and reprocess all images",
    )
    parser.add_argument(
        "--mode",
        choices=["status", "pca1d"],
        default="status",
        help="Evaluation mode: status=collect_status, pca1d=observer_pca_1d_borders",
    )
    args = parser.parse_args()

    config = ImagePipelineConfig(
        puzzle_dir=Path(args.rag),
        newspaper=args.rag,
        rework=args.rework,
    )
    border_detector = InpImage.make_border_detector(config)

    if args.mode == "pca1d":
        if args.rag == "guardian":
            _log.info("pca1d mode is only applicable to Observer puzzles.")
            return
        status = StatusStore(config.status_path)
        observer_pca_1d_borders(config, status, rework=args.rework)
    else:
        collect_status(config, border_detector)


if __name__ == "__main__":
    main()
