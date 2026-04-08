"""Regression tests for the fresh-image pipeline (no .jpk cache).

These tests exercise code paths that the batch-solver eval reports cannot
reach, because the eval reports use .jpk cache files that bypass puzzle-type
detection, border detection, and number recognition entirely.

Marks
-----
pipeline : tests that require guardian/ and observer/ image directories.
           Run with: pytest -m pipeline
           Skipped automatically if the directories are absent (e.g. CI).

pipeline_full : subset of pipeline that runs the full rework=True pipeline
                on every image.  Much slower (~30-40 min).
                Run with: pytest -m pipeline_full
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt
import pytest

from killer_sudoku.image.cell_scan import detect_puzzle_type
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img
from killer_sudoku.image.inp_image import InpImage

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

GUARDIAN_DIR = Path("guardian")
OBSERVER_DIR = Path("observer")
_NEWSPAPERS = [("guardian", GUARDIAN_DIR), ("observer", OBSERVER_DIR)]
_DEFAULT_SAMPLE = 20  # images per newspaper for the fast sample test


def _image_dirs_present() -> bool:
    return GUARDIAN_DIR.exists() and OBSERVER_DIR.exists()


def _sorted_jpgs(directory: Path) -> list[Path]:
    """Return .jpg paths sorted numerically by the trailing integer."""
    return sorted(
        directory.glob("*.jpg"),
        key=lambda p: int(p.stem.split("_")[-1]),
    )


def _load_eval_report(directory: Path) -> dict[str, Any]:
    report_path = directory / "eval_report.json"
    if report_path.exists():
        return dict(json.loads(report_path.read_text()))
    return {}


def _warped_gry_from_cache(
    jpg: Path, config: ImagePipelineConfig
) -> npt.NDArray[np.uint8] | None:
    """Return warped grayscale image using cached grid corners.

    Skips the expensive locate_grid step by reading the .jpk cache for the
    perspective transform corners.  Returns None if no cache exists or the
    cached grid corners are all zero (old-format cache without grid field).
    """
    jpk = jpg.with_suffix(".jpk")
    if not jpk.exists():
        return None
    info = InpImage.load_cached(jpk)
    if not info.grid.any():
        # Old-format cache: no grid corners stored.
        return None

    resolution = config.resolution
    gry, _ = get_gry_img(jpg, resolution)

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
        cv2.getPerspectiveTransform(info.grid, dst_size), dtype=np.float64
    )
    warped: npt.NDArray[np.uint8] = np.asarray(
        cv2.warpPerspective(gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR),
        dtype=np.uint8,
    )
    return warped


# ---------------------------------------------------------------------------
# Test: scan all images for classic-sudoku misdetection (fast — uses cache)
# ---------------------------------------------------------------------------


@pytest.mark.pipeline
class TestPuzzleTypeScan:
    """Scan every cached image for puzzle-type misdetection.

    Uses .jpk grid corners + get_gry_img to reproduce the exact warped_gry
    that scan_cells saw during original processing, without re-running the
    expensive locate_grid step.  Each image takes ~50 ms; 889 images run in
    under a minute.
    """

    @pytest.fixture(autouse=True)
    def require_dirs(self) -> None:
        if not _image_dirs_present():
            pytest.skip("guardian/ and observer/ directories not present")

    def _scan(self, newspaper: str, directory: Path) -> list[tuple[str, float]]:
        """Return (filename, tl_fraction) for every image detected as classic."""
        config = ImagePipelineConfig()
        threshold = config.cell_scan.tl_fraction_threshold
        offenders: list[tuple[str, float]] = []
        for jpg in _sorted_jpgs(directory):
            warped_gry = _warped_gry_from_cache(jpg, config)
            if warped_gry is None:
                continue
            detected = detect_puzzle_type(warped_gry, config.subres, threshold)
            if detected == "classic":
                offenders.append((jpg.name, threshold))
        return offenders

    def test_no_guardian_image_misdetected_as_classic(self) -> None:
        """All guardian/ images must be detected as killer sudoku."""
        offenders = self._scan("guardian", GUARDIAN_DIR)
        assert offenders == [], (
            f"{len(offenders)} guardian image(s) misdetected as classic: "
            + ", ".join(f"{name} (sum={s:.1f})" for name, s in offenders[:10])
        )

    def test_no_observer_image_misdetected_as_classic(self) -> None:
        """All observer/ images must be detected as killer sudoku."""
        offenders = self._scan("observer", OBSERVER_DIR)
        assert offenders == [], (
            f"{len(offenders)} observer image(s) misdetected as classic: "
            + ", ".join(f"{name} (sum={s:.1f})" for name, s in offenders[:10])
        )


# ---------------------------------------------------------------------------
# Test: full pipeline on a sample of images (rework=True, no cache)
# ---------------------------------------------------------------------------


@pytest.mark.pipeline
class TestPipelineSample:
    """Run the full fresh pipeline on a small sample of real images.

    Uses rework=True so the pipeline runs end-to-end (no .jpk cache).
    Checks puzzle_type, spec_error, and outcome against eval_report.json.
    Runs the first _DEFAULT_SAMPLE images from each newspaper by default.
    """

    @pytest.fixture(autouse=True)
    def require_dirs(self) -> None:
        if not _image_dirs_present():
            pytest.skip("guardian/ and observer/ directories not present")

    def _run_sample(self, directory: Path, n: int = _DEFAULT_SAMPLE) -> None:
        config = ImagePipelineConfig(rework=True)
        num_rec = InpImage.make_num_recogniser()
        eval_report = _load_eval_report(directory)
        per_image: dict[str, str] = eval_report.get("per_image", {})

        images = _sorted_jpgs(directory)[:n]
        failures: list[str] = []

        for jpg in images:
            try:
                inp = InpImage(jpg, config, num_rec)
            except AssertionError as exc:
                failures.append(f"{jpg.name}: AssertionError — {exc}")
                continue

            # All training images are killer sudoku
            if inp.puzzle_type != "killer":
                failures.append(
                    f"{jpg.name}: detected as '{inp.puzzle_type}', expected 'killer'"
                )
                continue

            # Spec outcome should match eval_report if present
            expected = per_image.get(jpg.name, "")
            if expected == "SOLVED" and inp.spec_error is not None:
                failures.append(
                    f"{jpg.name}: previously SOLVED but now spec_error="
                    f"'{inp.spec_error}'"
                )

        assert failures == [], f"{len(failures)} pipeline failure(s):\n" + "\n".join(
            failures
        )

    def test_guardian_sample(self) -> None:
        """First {_DEFAULT_SAMPLE} guardian images must process correctly."""
        self._run_sample(GUARDIAN_DIR)

    def test_observer_sample(self) -> None:
        """First {_DEFAULT_SAMPLE} observer images must process correctly."""
        self._run_sample(OBSERVER_DIR)


# ---------------------------------------------------------------------------
# Test: full pipeline across all images (slow — ~30-40 min)
# ---------------------------------------------------------------------------


@pytest.mark.pipeline
@pytest.mark.pipeline_full
class TestPipelineFull:
    """Run the full fresh pipeline on every guardian and observer image.

    Marked pipeline_full in addition to pipeline.  Not part of normal
    pipeline run; requires explicit: pytest -m pipeline_full
    """

    @pytest.fixture(autouse=True)
    def require_dirs(self) -> None:
        if not _image_dirs_present():
            pytest.skip("guardian/ and observer/ directories not present")

    @pytest.mark.parametrize("newspaper,directory", _NEWSPAPERS)
    def test_all_images(self, newspaper: str, directory: Path) -> None:
        config = ImagePipelineConfig(rework=True)
        num_rec = InpImage.make_num_recogniser()
        eval_report = _load_eval_report(directory)
        per_image: dict[str, str] = eval_report.get("per_image", {})

        failures: list[str] = []
        for jpg in _sorted_jpgs(directory):
            try:
                inp = InpImage(jpg, config, num_rec)
            except AssertionError as exc:
                failures.append(f"{jpg.name}: AssertionError — {exc}")
                continue
            if inp.puzzle_type != "killer":
                failures.append(
                    f"{jpg.name}: detected as '{inp.puzzle_type}', expected 'killer'"
                )
                continue
            expected = per_image.get(jpg.name, "")
            if expected == "SOLVED" and inp.spec_error is not None:
                failures.append(
                    f"{jpg.name}: previously SOLVED but now spec_error="
                    f"'{inp.spec_error}'"
                )

        assert failures == [], (
            f"{len(failures)} pipeline failure(s) for {newspaper}:\n"
            + "\n".join(failures)
        )
