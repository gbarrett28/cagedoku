"""Puzzle processing evaluation harness.

Runs the full image processing pipeline on all puzzles and records solve
status. Used to measure model quality and identify problematic images.

collect_status() is the main evaluation function: it processes every .jpg in
the puzzle directory, attempts to solve each puzzle, and records the outcome
('SOLVED', 'UNSOLVED', 'ProcessingError: ...', 'AssertionError: ...',
'ValueError') to status.pkl.

test_border_fun() runs the same evaluation but allows injecting a custom
border classification function, enabling comparison of border detector models.

Usage:
    python -m killer_sudoku.training.evaluate --puzzle-dir <dir>
    python -m killer_sudoku.training.evaluate --puzzle-dir <dir> --rework
"""

import argparse
import itertools
import json
import logging
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import joblib  # type: ignore[import-untyped]
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.image.number_recognition import CayenneNumber
from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.grid import Grid, ProcessingError
from killer_sudoku.training.status import StatusStore

_log = logging.getLogger(__name__)


def write_eval_report(
    puzzle_dir: Path,
    status: StatusStore,
    solved: int,
    perror: int,
    aerror: int,
    verror: int,
    total: int,
    unsolved: int = 0,
) -> Path:
    """Write a structured JSON evaluation report to {puzzle_dir}/eval_report.json.

    Captures aggregate solve/error rates and a per-image status record so that
    regressions at the individual puzzle level can be detected by --compare.

    Args:
        puzzle_dir: Directory containing puzzle images.
        status: StatusStore with current puzzle outcomes.
        solved: Count of SOLVED puzzles.
        perror: Count of ProcessingError puzzles.
        aerror: Count of AssertionError puzzles.
        verror: Count of ValueError puzzles.
        total: Total puzzles processed.
        unsolved: Count of UNSOLVED puzzles (engine made no further progress).

    Returns:
        Path to the written report file.
    """
    solve_rate = solved / total if total else 0.0
    error_rate = (perror + aerror + verror) / total if total else 0.0

    per_image = dict(status.items())

    report = {
        "timestamp": datetime.now(tz=UTC).isoformat(),
        "total": total,
        "solved": solved,
        "unsolved": unsolved,
        "processing_error": perror,
        "assertion_error": aerror,
        "value_error": verror,
        "solve_rate": round(solve_rate, 6),
        "error_rate": round(error_rate, 6),
        "per_image": per_image,
    }

    out_path = puzzle_dir / "eval_report.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    _log.info("Wrote eval report to %s", out_path)
    return out_path


def compare_reports(baseline_path: Path, current_path: Path) -> bool:
    """Compare two evaluation reports and print a diff table.

    Loads both JSON reports and prints a table of Metric / Baseline / Current /
    Delta for solve_rate and error_rate.  Any metric that regresses by more than
    0.01 (1%) is flagged as a failure.

    Also detects per-image regressions: puzzles that moved from SOLVED to
    an error status.

    Args:
        baseline_path: Path to the baseline eval_report.json.
        current_path: Path to the current eval_report.json.

    Returns:
        True if no regressions detected, False if any metric regressed > 1%.
    """
    with open(baseline_path, encoding="utf-8") as fh:
        baseline = json.load(fh)
    with open(current_path, encoding="utf-8") as fh:
        current = json.load(fh)

    metrics = ["solve_rate", "error_rate"]
    # For solve_rate: higher is better (regression = decrease).
    # For error_rate: lower is better (regression = increase).
    higher_is_better = {"solve_rate": True, "error_rate": False}

    print(f"\n{'Metric':<20} {'Baseline':>10} {'Current':>10} {'Delta':>10}")
    print("-" * 55)

    any_regression = False
    for m in metrics:
        base_val = float(baseline.get(m, 0.0))
        curr_val = float(current.get(m, 0.0))
        delta = curr_val - base_val
        sign = "+" if delta >= 0 else ""
        good = higher_is_better[m]
        is_regression = (good and delta < -0.01) or (not good and delta > 0.01)
        flag = "  ✗ REGRESSION" if is_regression else "  ✓"
        if is_regression:
            any_regression = True
        print(f"{m:<20} {base_val:>10.4f} {curr_val:>10.4f} {sign}{delta:>9.4f}{flag}")

    # Per-image regression detection.
    base_per = baseline.get("per_image", {})
    curr_per = current.get("per_image", {})
    regressions: list[str] = []
    for name, base_status in base_per.items():
        curr_status = curr_per.get(name, "")
        was_good = base_status == "SOLVED"
        now_bad = curr_status != "SOLVED" and curr_status != ""
        if was_good and now_bad:
            regressions.append(f"  {name}: {base_status} -> {curr_status}")

    if regressions:
        any_regression = True
        print(f"\nPer-image regressions ({len(regressions)}):")
        for r in regressions:
            print(r)
    else:
        print("\nNo per-image regressions.")

    return not any_regression


def _process_one_image(
    f: Path,
    config: ImagePipelineConfig,
    num_recogniser: CayenneNumber,
) -> tuple[str, str, float]:
    """Process one puzzle image and return (filename, status_string, elapsed_s).

    Designed to run in a joblib worker process.  Returns plain strings (not
    Path objects or exceptions) so the caller can update StatusStore without
    any shared mutable state between workers.  elapsed_s lets the main process
    detect images that are taking unexpectedly long.

    Args:
        f: Path to the puzzle .jpg image.
        config: Pipeline configuration.
        num_recogniser: Trained digit classifier.

    Returns:
        (f.name, status_string, elapsed_seconds) where status_string is one of
        'SOLVED', 'UNSOLVED', 'ProcessingError: ...', 'AssertionError: ...',
        or 'ValueError: ...'.
    """
    t0 = time.perf_counter()
    try:
        inp = InpImage(f, config, num_recogniser)
        assert inp.spec is not None, inp.spec_error
        grd = Grid()
        grd.set_up(inp.spec)
        alts_sum, _solns_sum = grd.engine_solve()
        status = "SOLVED" if alts_sum == 81 else "UNSOLVED"
        return f.name, status, time.perf_counter() - t0
    except ProcessingError as e:
        return f.name, f"ProcessingError: {e.msg}", time.perf_counter() - t0
    except AssertionError as e:
        return f.name, f"AssertionError: {e}", time.perf_counter() - t0
    except ValueError as e:
        return f.name, f"ValueError: {e}", time.perf_counter() - t0


def collect_status(
    config: ImagePipelineConfig,
) -> StatusStore:
    """Process all .jpg puzzles and record solve status to disk.

    For each puzzle image, runs the full InpImage pipeline then attempts to
    solve the extracted grid. Records the outcome in a StatusStore and saves
    to config.status_path.

    Status values written:
      - 'SOLVED': grid fully solved by the rule-based engine.
      - 'UNSOLVED': engine could not fully determine all cells.
      - 'ProcessingError: <msg>': image pipeline raised ProcessingError.
      - 'AssertionError: <msg>': image pipeline raised AssertionError.
      - 'ValueError: <msg>': grid setup raised ValueError.

    Args:
        config: Pipeline configuration (supplies puzzle_dir, status_path, etc.).

    Returns:
        StatusStore with updated results (already saved to disk).
    """
    num_recogniser = InpImage.make_num_recogniser()
    status = StatusStore(config.status_path, config.puzzle_dir_required)
    solved = perror = aerror = verror = unsolved = total = 0

    files = list(config.puzzle_dir_required.glob("*.jpg"))
    n_total = len(files)
    _log.info("Processing %d images with n_jobs=%d ...", n_total, config.n_jobs)

    # Dispatch all images to worker processes; results stream back as each
    # completes (unordered).  StatusStore is updated only in the main process
    # so workers never share mutable state.
    results = joblib.Parallel(n_jobs=config.n_jobs, return_as="generator_unordered")(
        joblib.delayed(_process_one_image)(f, config, num_recogniser) for f in files
    )

    timings: list[tuple[str, float]] = []
    for name, stat, elapsed in results:
        total += 1
        timings.append((name, elapsed))
        f = config.puzzle_dir_required / name
        status[f] = stat
        if stat == "SOLVED":
            solved += 1
        elif stat == "UNSOLVED":
            unsolved += 1
        elif stat.startswith("ProcessingError"):
            perror += 1
        elif stat.startswith("AssertionError"):
            aerror += 1
        else:
            verror += 1

        if total % 10 == 0 or total == n_total:
            _log.info(
                "[%d/%d] SOLVED=%d UNSOLVED=%d PE=%d AE=%d VE=%d",
                total,
                n_total,
                solved,
                unsolved,
                perror,
                aerror,
                verror,
            )

        # Periodic save so external monitors see live progress.
        if total % 50 == 0:
            status.save()

    # Timing summary: percentiles and slowest images.
    # "Slow" is defined relative to the run distribution (>= P95) so the
    # threshold adapts automatically to whatever the pipeline actually costs.
    elapsed_sorted = sorted(e for _, e in timings)
    n = len(elapsed_sorted)
    if n:
        p50 = elapsed_sorted[int(0.50 * n)]
        p90 = elapsed_sorted[int(0.90 * n)]
        p95 = elapsed_sorted[min(int(0.95 * n), n - 1)]
        p99 = elapsed_sorted[min(int(0.99 * n), n - 1)]
        _log.info(
            "Timing P50=%.1fs P90=%.1fs P95=%.1fs P99=%.1fs max=%.1fs",
            p50,
            p90,
            p95,
            p99,
            elapsed_sorted[-1],
        )
        slow = sorted(
            [(nm, el) for nm, el in timings if el >= p95], key=lambda x: -x[1]
        )
        _log.info("Slowest images (>= P95 = %.1fs):", p95)
        for nm, el in slow[:10]:
            _log.info("  %.1fs  %s", el, nm)

    status.save()
    _log.info("SOLVED          %3d", solved)
    _log.info("UNSOLVED        %3d", unsolved)
    _log.info("ProcessingError %3d", perror)
    _log.info("AssertionError  %3d", aerror)
    _log.info("ValueError      %3d", verror)
    _log.info("TOTAL           %3d", total)
    write_eval_report(
        config.puzzle_dir_required,
        status,
        solved,
        perror,
        aerror,
        verror,
        total,
        unsolved=unsolved,
    )
    return status


def test_border_fun(
    config: ImagePipelineConfig,
    status: StatusStore,
    status_pattern: re.Pattern[str],
    is_border_fn: Callable[[npt.NDArray[np.float64]], bool] | None = None,
) -> tuple[int, int, int, int, int]:
    """Evaluate a custom border detection function against matching puzzles.

    Processes all puzzles whose recorded status matches status_pattern. If
    is_border_fn is provided, uses it to rebuild the borders from the raw
    border pixel strips; otherwise uses the validated spec from InpImage directly.

    Args:
        config: Pipeline configuration.
        status: StatusStore with previously recorded solve outcomes.
        status_pattern: Only process puzzles whose status matches this pattern.
        is_border_fn: Optional function (pixel_strip -> bool) to test. If None,
            uses the pre-validated spec from InpImage directly.

    Returns:
        (aerror, unsolved, perror, solved, total) counts.
    """
    num_recogniser = InpImage.make_num_recogniser()
    solved = 0
    unsolved = 0
    perror = 0
    aerror = 0
    total = 0

    for f in itertools.islice(config.puzzle_dir_required.glob("*.jpg"), None):
        recorded = status[f]
        if not re.match(status_pattern, recorded):
            continue

        _log.info("Processing (test_border_fun) %s...", f)
        total += 1

        try:
            inp = InpImage(f, config, num_recogniser)
            grd = Grid()

            if is_border_fn is None:
                assert inp.spec is not None, inp.spec_error
                spec = inp.spec
            else:
                # Experimental border detection — build a custom brdrs array,
                # then derive the compact border_x/border_y and re-validate.
                brdrs: npt.NDArray[np.bool_] = np.full(
                    shape=(9, 9, 4), fill_value=True, dtype=bool
                )
                half = config.subres // 2
                for col in range(9):
                    for row in range(8):
                        isbh = is_border_fn(np.zeros(half, dtype=np.float64))
                        isbv = is_border_fn(np.zeros(half, dtype=np.float64))
                        brdrs[row + 0, col][1] = isbh
                        brdrs[row + 1, col][3] = isbh
                        brdrs[row, col + 0][2] = isbv
                        brdrs[row, col + 1][0] = isbv
                # Reverse-expand to compact canonical forms.
                border_x = np.asarray(brdrs[:8, :, 1].T, dtype=bool)
                border_y = np.asarray(brdrs[:8, :, 2], dtype=bool)
                spec = validate_cage_layout(inp.info.cage_totals, border_x, border_y)

            grd.set_up(spec)
            alts_sum, _solns_sum = grd.solve()
            if alts_sum != 81:
                _log.info("... unsolved (alts_sum=%d)", alts_sum)
                status[f] = "UNSOLVED"
                unsolved += 1
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

    return aerror, unsolved, perror, solved, total


def main() -> None:
    """CLI entry point: evaluate pipeline on all puzzles and record status."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Evaluate image pipeline and record solve status for all puzzles"
    )
    parser.add_argument(
        "--puzzle-dir", required=True, help="Directory of puzzle images"
    )
    parser.add_argument(
        "--rework",
        action="store_true",
        default=False,
        help="Bypass .jpk cache and reprocess all images",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        default=False,
        help="Read status.pkl and write eval_report.json without reprocessing images",
    )
    parser.add_argument(
        "--compare",
        metavar="BASELINE_JSON",
        default=None,
        help="Compare current eval_report.json to a baseline; prints diff table",
    )
    args = parser.parse_args()

    config = ImagePipelineConfig(
        puzzle_dir=Path(args.puzzle_dir),
        rework=args.rework,
    )

    if args.report_only:
        # Regenerate the report from existing status.pkl without re-running pipeline.
        status = StatusStore(config.status_path, config.puzzle_dir_required)
        counts: dict[str, int] = {
            "solved": 0,
            "perror": 0,
            "aerror": 0,
            "verror": 0,
            "total": 0,
        }
        for _name, stat in status.items():
            counts["total"] += 1
            if stat == "SOLVED":
                counts["solved"] += 1
            elif stat.startswith("ProcessingError"):
                counts["perror"] += 1
            elif stat.startswith("AssertionError"):
                counts["aerror"] += 1
            elif stat.startswith("ValueError"):
                counts["verror"] += 1
        write_eval_report(
            config.puzzle_dir_required,
            status,
            counts["solved"],
            counts["perror"],
            counts["aerror"],
            counts["verror"],
            counts["total"],
        )
        if args.compare:
            report_path = config.puzzle_dir_required / "eval_report.json"
            ok = compare_reports(Path(args.compare), report_path)
            if not ok:
                raise SystemExit(1)
        return

    if args.compare:
        # Compare the existing eval_report.json to a baseline without re-running.
        report_path = config.puzzle_dir_required / "eval_report.json"
        ok = compare_reports(Path(args.compare), report_path)
        if not ok:
            raise SystemExit(1)
        return

    collect_status(config)


if __name__ == "__main__":
    main()
