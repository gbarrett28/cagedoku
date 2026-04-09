"""Killer sudoku puzzle image parser.

PicInfo stores the extracted puzzle data (grid corners, border arrays, cage totals).
InpImage reads a puzzle image file, runs the grid location and border/number
detection pipeline, and populates a PicInfo.
"""

import dataclasses
import logging
import pickle as pk
from importlib.resources import files
from pathlib import Path
from typing import Any, Literal

import cv2
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.border_clustering import (
    BoundaryKind,
    boundary_kind,
    cluster_borders,
)
from killer_sudoku.image.cell_scan import (
    detect_puzzle_type,
    detect_rotation,
    scan_cells,
)
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid
from killer_sudoku.image.number_recognition import (
    CayenneNumber,
    contour_hier,
    get_num_contours,
    load_number_recogniser_stream,
    read_classic_digits,
    split_num,
)
from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.grid import ProcessingError
from killer_sudoku.solver.puzzle_spec import PuzzleSpec

_log = logging.getLogger(__name__)


@dataclasses.dataclass
class PicInfo:
    """Extracted puzzle data from a single image.

    Attributes:
        grid: Four corner points (4, 2) float32 for perspective transform.
        border_x: (9, 8) bool array representing horizontal inter-cell borders.
        border_y: (8, 9) bool array representing vertical inter-cell borders.
        cage_totals: (9, 9) int array of cage total per cell (0 = not a cage head).
        brdrs: (9, 9, 4) bool array of [up, right, down, left] border flags per cell.
    """

    grid: npt.NDArray[np.float32] = dataclasses.field(
        default_factory=lambda: np.zeros((4, 2), np.float32)
    )
    border_x: npt.NDArray[np.bool_] = dataclasses.field(
        default_factory=lambda: np.zeros((9, 8), bool)
    )
    border_y: npt.NDArray[np.bool_] = dataclasses.field(
        default_factory=lambda: np.zeros((8, 9), bool)
    )
    cage_totals: npt.NDArray[np.intp] = dataclasses.field(
        default_factory=lambda: np.zeros((9, 9), dtype=np.intp)
    )
    brdrs: npt.NDArray[np.bool_] = dataclasses.field(
        default_factory=lambda: np.full((9, 9, 4), True, dtype=bool)
    )


class InpImage:
    """Parses a killer sudoku puzzle image into structured cage data.

    Dependencies (num_recogniser) are passed explicitly, enabling lazy
    initialisation and clean testability.  Use the static factory method
    make_num_recogniser for production use.

    Border detection uses the format-agnostic anchored-clustering pipeline
    (Stages 3 + 4) exclusively — no trained border model is required.

    No module-level side effects: model loading is deferred to the factory method.
    """

    def __init__(
        self,
        filepath: Path,
        config: ImagePipelineConfig,
        num_recogniser: CayenneNumber,
    ) -> None:
        """Parse a puzzle image file and populate self.info with extracted data.

        Checks for a cached .jpk file alongside the image; if found and rework
        is False, loads from cache. Otherwise runs the full pipeline: grid
        location, border identification, and number recognition.

        Validation errors (invalid cage layout, digit extraction failures) are
        stored in self.spec_error rather than raised; callers must check
        self.spec_error is None before using self.spec.

        Args:
            filepath: Path to the puzzle image file.
            config: Pipeline configuration (resolution, thresholds).
            num_recogniser: Trained digit classifier.

        Raises:
            AssertionError: if grid lines or intersections cannot be found
                (no useful data has been extracted).
        """
        resolution = config.resolution
        subres = config.subres

        gry, img = get_gry_img(filepath, resolution)
        self.gry: npt.NDArray[np.uint8] = gry
        self.img: npt.NDArray[np.uint8] = img

        jpk = filepath.with_suffix(".jpk")
        if not config.rework and jpk.exists():
            self.info: PicInfo = InpImage.load_cached(jpk)
            dst_size_cached = np.array(
                [
                    [0, 0],
                    [resolution - 1, 0],
                    [resolution - 1, resolution - 1],
                    [0, resolution - 1],
                ],
                dtype=np.float32,
            )
            m_cached: npt.NDArray[np.float64] = np.asarray(
                cv2.getPerspectiveTransform(self.info.grid, dst_size_cached),
                dtype=np.float64,
            )
            self.warped_img: npt.NDArray[np.uint8] = np.asarray(
                cv2.warpPerspective(
                    img, m_cached, (resolution, resolution), flags=cv2.INTER_LINEAR
                ),
                dtype=np.uint8,
            )
            self.spec: PuzzleSpec | None = None
            self.spec_error: str | None = None
            try:
                self.spec = validate_cage_layout(
                    self.info.cage_totals, self.info.border_x, self.info.border_y
                )
            except (ValueError, ProcessingError) as exc:
                self.spec_error = str(exc)
            # Cached data is always killer (classic puzzles are not cached).
            self.puzzle_type: Literal["killer", "classic"] = "killer"
            self.given_digits: npt.NDArray[np.intp] | None = None
            return

        self.info = PicInfo()

        blk, self.info.grid = locate_grid(gry, config.grid_location)

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
            cv2.getPerspectiveTransform(self.info.grid, dst_size), dtype=np.float64
        )

        warped_blk: npt.NDArray[np.uint8] = np.asarray(
            cv2.warpPerspective(
                blk, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )
        warped_gry: npt.NDArray[np.uint8] = np.asarray(
            cv2.warpPerspective(
                gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )
        self.warped_img = np.asarray(
            cv2.warpPerspective(
                img, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )

        # Correct for rotated source images (e.g. landscape scans rotated 90°).
        # Rolling the grid corners by -k makes the dominant ink corner map to the
        # canonical TL destination, so all subsequent warps use the same corrected
        # transform and produce a consistently-oriented image.
        rotation_k = detect_rotation(
            warped_gry, subres, config.cell_scan.rotation_dominance_threshold
        )
        if rotation_k != 0:
            self.info.grid = np.roll(self.info.grid, -rotation_k, axis=0)
            m = np.asarray(
                cv2.getPerspectiveTransform(self.info.grid, dst_size),
                dtype=np.float64,
            )
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
            self.warped_img = np.asarray(
                cv2.warpPerspective(
                    img, m, (resolution, resolution), flags=cv2.INTER_LINEAR
                ),
                dtype=np.uint8,
            )

        # Detect puzzle type before running (potentially expensive) border detection.
        _cage_conf, classic_conf = scan_cells(warped_gry, subres, config.cell_scan)
        self.puzzle_type = detect_puzzle_type(
            warped_gry, subres, config.cell_scan.tl_fraction_threshold
        )
        self.spec = None
        self.spec_error = None

        if self.puzzle_type == "classic":
            # Classic path: borders are deterministic (row cages), no model needed.
            self.given_digits = read_classic_digits(
                warped_blk, num_recogniser, subres, classic_conf
            )
            self.info.border_x = np.ones((9, 8), dtype=bool)
            self.info.border_y = np.zeros((8, 9), dtype=bool)
            self.info.brdrs = InpImage._borders_to_brdrs(
                self.info.border_x, self.info.border_y
            )
            cage_totals_classic: npt.NDArray[np.intp] = np.zeros((9, 9), dtype=np.intp)
            for r_idx in range(9):
                cage_totals_classic[0, r_idx] = 45
            try:
                self.spec = validate_cage_layout(
                    cage_totals_classic,
                    self.info.border_x,
                    self.info.border_y,
                )
            except (ValueError, ProcessingError) as exc:
                self.spec_error = str(exc)
            return

        # Killer path: format-agnostic anchored-clustering border detection.
        self.given_digits = None
        self.info.border_x, self.info.border_y = self._identify_borders(
            gry, m, config, warped_blk, num_recogniser
        )
        self.info.brdrs = InpImage._borders_to_brdrs(
            self.info.border_x, self.info.border_y
        )

        try:
            cage_totals = self._build_cage_totals(
                warped_blk, num_recogniser, subres, self.info.brdrs
            )

            # Every cell belongs to exactly one cage, so cage totals must sum to 405
            # (9 rows x (1+2+...+9) = 9 x 45). A sum outside [360, 450] (+-10%) almost
            # always means the number recogniser read a cell incorrectly.
            # Fallback: if the global-threshold blk binary floods cell interiors (e.g.
            # when isblack is over-estimated), retry with adaptive thresholding of the
            # warped grayscale image.  The adaptive C value is tuned so ink pixels are
            # clearly below the local mean while flat paper background is excluded.
            total_sum = int(cage_totals.sum())
            if not (360 <= total_sum <= 450):
                fallback_c = config.number_recognition.contour_fallback_adaptive_c
                warped_blk = np.asarray(
                    cv2.adaptiveThreshold(
                        warped_gry,
                        255,
                        cv2.ADAPTIVE_THRESH_MEAN_C,
                        cv2.THRESH_BINARY_INV,
                        config.adaptive_block_size,
                        fallback_c,
                    ),
                    dtype=np.uint8,
                )
                cage_totals = self._build_cage_totals(
                    warped_blk, num_recogniser, subres, self.info.brdrs
                )
                total_sum = int(cage_totals.sum())

            self.info.cage_totals = cage_totals

            if total_sum < 360 or total_sum > 450:
                raise ProcessingError(
                    f"Cage totals sum to {total_sum}, expected 405",
                    cage_totals,
                    self.info.brdrs,
                )

            with open(jpk, "wb") as fh:
                pk.dump(self.info, fh)

            self.spec = validate_cage_layout(
                self.info.cage_totals, self.info.border_x, self.info.border_y
            )
        except (ValueError, ProcessingError) as exc:
            self.spec_error = str(exc)

    def _identify_borders(
        self,
        gry: npt.NDArray[np.uint8],
        m: npt.NDArray[np.float64],
        config: ImagePipelineConfig,
        warped_blk: npt.NDArray[np.uint8],
        num_recogniser: CayenneNumber,
    ) -> tuple[npt.NDArray[np.bool_], npt.NDArray[np.bool_]]:
        """Classify inter-cell borders using the anchored-clustering pipeline.

        Applies cell scan (Stage 3) followed by anchored border clustering
        (Stage 4).  Tries all 4 combinations of BOX/CELL group polarity and
        picks the one with the highest connectivity score (most cage regions
        containing exactly one printed cage total).  Returns early when a
        perfect score is reached (score == number of detected cage heads).

        Args:
            gry: Grayscale source image.
            m: Perspective transform matrix from locate_grid.
            config: Pipeline configuration.
            warped_blk: Warped binary digit image (ink=white) for cage-total scoring.
            num_recogniser: Digit classifier used to score polarity candidates.

        Returns:
            (border_x, border_y) hard bool arrays, shapes (9, 8) and (8, 9).
        """
        resolution = config.resolution
        subres = config.subres

        warped_gry: npt.NDArray[np.uint8] = np.asarray(
            cv2.warpPerspective(
                gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )

        cage_conf, _classic_conf = scan_cells(warped_gry, subres, config.cell_scan)

        bx_prob, by_prob = cluster_borders(
            warped_gry,
            cage_conf,
            subres,
            config.border_clustering,
            config.cell_scan.anchor_confidence_threshold,
        )

        # Compute cage_totals once -- it depends only on the image, not on borders.
        initial_bx: npt.NDArray[np.bool_] = bx_prob > 0.5
        initial_by: npt.NDArray[np.bool_] = by_prob > 0.5
        try:
            cage_totals = InpImage._build_cage_totals(
                warped_blk,
                num_recogniser,
                subres,
                InpImage._borders_to_brdrs(initial_bx, initial_by),
            )
        except Exception:
            return initial_bx, initial_by

        n_heads = int(np.count_nonzero(cage_totals))

        # Try all 4 BOX/CELL polarity combinations; pick the one with the most
        # cage regions that contain exactly one printed total (connectivity score).
        # Early-out: a perfect score means every detected cage head is uniquely
        # enclosed -- no further combinations can improve on this.
        best_bx = initial_bx
        best_by = initial_by
        best_score = InpImage._connectivity_score(initial_bx, initial_by, cage_totals)

        if best_score == n_heads:
            return best_bx, best_by

        for flip_box, flip_cell in ((True, False), (False, True), (True, True)):
            cx: npt.NDArray[np.float64] = bx_prob.copy()
            cy: npt.NDArray[np.float64] = by_prob.copy()
            for gap in range(8):
                if boundary_kind(gap) == BoundaryKind.BOX and flip_box:
                    cx[:, gap] = 1.0 - cx[:, gap]
                    cy[gap, :] = 1.0 - cy[gap, :]
                elif boundary_kind(gap) == BoundaryKind.CELL and flip_cell:
                    cx[:, gap] = 1.0 - cx[:, gap]
                    cy[gap, :] = 1.0 - cy[gap, :]
            border_x: npt.NDArray[np.bool_] = cx > 0.5
            border_y: npt.NDArray[np.bool_] = cy > 0.5
            score = InpImage._connectivity_score(border_x, border_y, cage_totals)
            _log.debug(
                "polarity flip_box=%s flip_cell=%s: connectivity=%d/%d",
                flip_box,
                flip_cell,
                score,
                n_heads,
            )
            if score > best_score:
                best_score = score
                best_bx = border_x
                best_by = border_y
                if best_score == n_heads:
                    break

        return best_bx, best_by

    @staticmethod
    def _borders_to_brdrs(
        border_x: npt.NDArray[np.bool_],
        border_y: npt.NDArray[np.bool_],
    ) -> npt.NDArray[np.bool_]:
        """Convert (9, 8) and (8, 9) border arrays to a (9, 9, 4) brdrs array.

        brdrs[row, col] = [up, right, down, left] where True means the border
        between this cell and its neighbour is a cage border.
        """
        brdrs: npt.NDArray[np.bool_] = np.full((9, 9, 4), True, dtype=bool)
        for col in range(9):
            for row in range(8):
                isbh = bool(border_x[col, row])
                isbv = bool(border_y[row, col])
                brdrs[row, col][1] = isbh
                brdrs[row + 1, col][3] = isbh
                brdrs[col, row][2] = isbv
                brdrs[col, row + 1][0] = isbv
        return brdrs

    @staticmethod
    def _connectivity_score(
        border_x: npt.NDArray[np.bool_],
        border_y: npt.NDArray[np.bool_],
        cage_totals: npt.NDArray[np.intp],
    ) -> int:
        """Count connected cage regions that contain exactly one printed total.

        Flood-fills through open (non-cage) borders using border_x[col, row_gap]
        (horizontal borders) and border_y[col_gap, row] (vertical borders).
        A well-formed cage has exactly one non-zero cage_totals cell.  The
        maximum score equals the number of cages in the puzzle (~20-30 for
        a typical killer sudoku).

        Args:
            border_x: Shape (9, 8) -- True where cage border lies between rows.
            border_y: Shape (8, 9) -- True where cage border lies between columns.
            cage_totals: Shape (9, 9), indexed [col, row] -- non-zero for cage heads.

        Returns:
            Number of cage regions with exactly one head.
        """
        visited = np.zeros((9, 9), dtype=bool)
        score = 0
        for sc in range(9):
            for sr in range(9):
                if visited[sc, sr]:
                    continue
                region: list[tuple[int, int]] = [(sc, sr)]
                visited[sc, sr] = True
                heads = 0
                i = 0
                while i < len(region):
                    c, r = region[i]
                    i += 1
                    if cage_totals[c, r] > 0:
                        heads += 1
                    # down: row r -> r+1, blocked by border_x[c, r]
                    if r + 1 < 9 and not visited[c, r + 1] and not border_x[c, r]:
                        visited[c, r + 1] = True
                        region.append((c, r + 1))
                    # up: row r -> r-1, blocked by border_x[c, r-1]
                    if r > 0 and not visited[c, r - 1] and not border_x[c, r - 1]:
                        visited[c, r - 1] = True
                        region.append((c, r - 1))
                    # right: col c -> c+1, blocked by border_y[c, r]
                    if c + 1 < 9 and not visited[c + 1, r] and not border_y[c, r]:
                        visited[c + 1, r] = True
                        region.append((c + 1, r))
                    # left: col c -> c-1, blocked by border_y[c-1, r]
                    if c > 0 and not visited[c - 1, r] and not border_y[c - 1, r]:
                        visited[c - 1, r] = True
                        region.append((c - 1, r))
                if heads == 1:
                    score += 1
        return score

    @staticmethod
    def _build_cage_totals(
        warped_blk: npt.NDArray[np.uint8],
        num_recogniser: CayenneNumber,
        subres: int,
        brdrs: npt.NDArray[np.bool_],
    ) -> npt.NDArray[np.intp]:
        """Extract cage totals from a warped binary digit image.

        Finds contours in warped_blk, classifies them as digit bounding rects,
        splits two-digit numbers, and runs the digit classifier to build the
        9x9 cage-total array.

        Args:
            warped_blk: Warped binary image (ink=white, background=black).
            num_recogniser: Loaded digit classifier.
            subres: Pixel width/height of one cell in the warped image.
            brdrs: (9, 9, 4) border flags, used to populate ProcessingError.

        Returns:
            (9, 9) int array of cage totals (0 for non-head cells).

        Raises:
            ProcessingError: if any cell contains more than 4 digit candidates.
        """
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
            chiers = contour_hier(list(zip(contours, hier_rows, strict=False)), set())
            raw_nums = get_num_contours(chiers, subres)
            for _c, br, _ds in sorted(raw_nums, key=lambda ch: ch[1][0]):
                try:
                    num_chiers, x, y = split_num(br, warped_blk, subres)
                except ValueError:
                    # Contour passed the size filter but has unexpected geometry
                    # (e.g. slightly wider than tall with no valid split point).
                    # Skip it: it is almost certainly noise, not a cage total digit.
                    continue
                bx, by, bw, bh = br
                col = (bx + bw // 2) // subres
                row = (by + bh // 2) // subres
                if col < 0 or col >= 9 or row < 0 or row >= 9:
                    # Contour centre falls outside the 9x9 grid -- skip.
                    continue
                if num_pixels[col, row] is None:
                    num_pixels[col, row] = []
                num_pixels[col, row] += num_chiers

        cage_totals: npt.NDArray[np.intp] = np.zeros(shape=(9, 9), dtype=np.intp)
        for col in range(9):
            for row in range(9):
                sums = num_pixels[row, col]
                if sums is not None:
                    ntrs = num_recogniser.get_sums(sums)
                    if len(ntrs) > 4:
                        raise ProcessingError(
                            f"Too many digits ({len(ntrs)}) in cell ({col},{row})",
                            np.zeros((9, 9), dtype=np.intp),
                            brdrs,
                        )
                    for v in ntrs:
                        if int(v) >= 0:
                            cage_totals[col, row] = (10 * cage_totals[col, row]) + int(
                                v
                            )
        return cage_totals

    @staticmethod
    def make_num_recogniser() -> CayenneNumber:
        """Load the bundled number recogniser model from the package data.

        Uses importlib.resources so the model is found whether the package
        is installed normally or as an editable install (pip install -e .).

        Returns:
            Loaded CayenneNumber classifier with RBFClassifier.
        """
        resource = files("killer_sudoku.data").joinpath("num_recogniser.npz")
        with resource.open("rb") as fh:
            return load_number_recogniser_stream(fh)

    @staticmethod
    def load_cached(jpk_path: Path) -> "PicInfo":
        """Load a cached PicInfo from a .jpk file.

        Handles two formats:
          - New format: a PicInfo dataclass instance (written by current code).
          - Old format: a plain dict with keys 'cagevals', 'brdrs', etc.
            Migrated on load: cage_totals set from cagevals, border_x/border_y
            derived from the 4-direction brdrs array.

        Provides a clean interface for training code to read cached puzzle
        data (border layout, cage totals) without knowing the serialisation
        format or the pickle import alias used inside this module.

        Args:
            jpk_path: Path to the .jpk cache file.

        Returns:
            Deserialised PicInfo.

        Raises:
            FileNotFoundError: if jpk_path does not exist.
        """
        if not jpk_path.exists():
            raise FileNotFoundError(f"Cache file not found: {jpk_path}")
        with open(jpk_path, "rb") as fh:
            raw = pk.load(fh)

        if isinstance(raw, PicInfo):
            return raw

        # Old format: plain dict. Migrate to PicInfo.
        info = PicInfo()
        if "cagevals" in raw:
            info.cage_totals = np.asarray(raw["cagevals"], dtype=np.intp)
        if "brdrs" in raw:
            old_brdrs: npt.NDArray[np.bool_] = np.asarray(raw["brdrs"], dtype=bool)
            info.brdrs = old_brdrs
            # Derive border_x[col, row] = old_brdrs[row, col][1] (right flag)
            # Derive border_y[row, col] = old_brdrs[col, row][2] (down flag)
            info.border_x = np.asarray(old_brdrs[:8, :, 1].T, dtype=bool)
            info.border_y = np.asarray(old_brdrs[:, :8, 2].T, dtype=bool)
        return info
