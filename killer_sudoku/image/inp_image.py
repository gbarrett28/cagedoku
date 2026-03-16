"""Killer sudoku puzzle image parser.

PicInfo stores the extracted puzzle data (grid corners, border arrays, cage totals).
InpImage reads a puzzle image file, runs the grid location and border/number
detection pipeline, and populates a PicInfo.
"""

import dataclasses
import pickle as pk
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt
from scipy.signal import find_peaks

from killer_sudoku.image.border_detection import (
    BorderPCA1D,
    load_observer_border_detector,
)
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid
from killer_sudoku.image.number_recognition import (
    CayenneNumber,
    contour_hier,
    get_num_contours,
    load_number_recogniser,
    split_num,
)
from killer_sudoku.solver.grid import ProcessingError


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


def _process_sample_guardian(s: npt.NDArray[np.uint8]) -> int:
    """Count peaks in the inverted sample for Guardian border detection.

    Guardian puzzles use peak-counting on the adaptive-threshold image row/column
    to identify borders (more than 2 peaks indicates a cage border is present).

    Args:
        s: 1D pixel sample from the adaptive-threshold image.

    Returns:
        Number of peaks detected.
    """
    peaks: npt.NDArray[np.intp]
    peaks, _ = find_peaks(~s, height=32)
    return int(len(peaks))


def _process_sample_observer(s: npt.NDArray[np.uint8]) -> int:
    """Count rising edges in the binary sample for Observer border detection.

    Observer puzzles use edge-counting (transitions from 0 to 1 in the binary
    sample) to identify borders. More than 2 edges indicates a cage border.

    Args:
        s: 1D binary pixel sample.

    Returns:
        Number of rising edges detected.
    """
    sl = s[1:]
    sr = s[:-1]
    se = sl & ~sr
    return int(np.count_nonzero(se))


class InpImage:
    """Parses a killer sudoku puzzle image into structured cage data.

    Dependencies (border_detector, num_recogniser) are passed explicitly,
    enabling lazy initialisation and clean testability. Use the static factory
    methods make_border_detector and make_num_recogniser for production use.

    No module-level side effects: model loading is deferred to factory methods.
    """

    def __init__(
        self,
        filepath: Path,
        config: ImagePipelineConfig,
        border_detector: BorderPCA1D | None,
        num_recogniser: CayenneNumber,
    ) -> None:
        """Parse a puzzle image file and populate self.info with extracted data.

        Checks for a cached .jpk file alongside the image; if found and rework
        is False, loads from cache. Otherwise runs the full pipeline: grid
        location, border identification, and number recognition.

        Args:
            filepath: Path to the puzzle image file.
            config: Pipeline configuration (newspaper, resolution, thresholds).
            border_detector: Observer border model, or None for Guardian.
            num_recogniser: Trained digit classifier.

        Raises:
            AssertionError: if grid lines or intersections cannot be found.
            ValueError: if digit geometry is inconsistent during number extraction.
            ProcessingError: if number extraction yields too many values per cell.
        """
        resolution = config.resolution
        subres = config.subres

        gry, img = get_gry_img(filepath, resolution)
        self.gry: npt.NDArray[np.uint8] = gry
        self.img: npt.NDArray[np.uint8] = img

        jpk = filepath.with_suffix(".jpk")
        if not config.rework and jpk.exists():
            with open(jpk, "rb") as fh:
                self.info: PicInfo = pk.load(fh)
            return

        self.info = PicInfo()

        blk, self.info.grid = locate_grid(gry, img, config.grid_location)

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

        self.info.border_x, self.info.border_y = self._identify_borders(
            gry, m, config, border_detector
        )

        brdrs: npt.NDArray[np.bool_] = np.full(
            shape=(9, 9, 4), fill_value=True, dtype=bool
        )
        for col in range(9):
            for row in range(8):
                isbh = bool(self.info.border_x[col, row])
                isbv = bool(self.info.border_y[row, col])
                brdrs[row + 0, col][1] = isbh
                brdrs[row + 1, col][3] = isbh
                brdrs[col, row + 0][2] = isbv
                brdrs[col, row + 1][0] = isbv
        self.info.brdrs = brdrs

        warped_blk: npt.NDArray[np.uint8] = np.asarray(
            cv2.warpPerspective(
                blk, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
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
            chiers = contour_hier(list(zip(contours, hier_rows, strict=False)), set())
            raw_nums = get_num_contours(chiers, subres)
            for _c, br, _ds in sorted(raw_nums, key=lambda ch: ch[1][0]):
                num_chiers, x, y = split_num(br, warped_blk, subres)
                col = x // subres
                row = y // subres
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
                            self.info.brdrs,
                        )
                    for v in ntrs:
                        if int(v) >= 0:
                            cage_totals[col, row] = (10 * cage_totals[col, row]) + int(
                                v
                            )
        self.info.cage_totals = cage_totals

        with open(jpk, "wb") as fh:
            pk.dump(self.info, fh)

    def _identify_borders(
        self,
        gry: npt.NDArray[np.uint8],
        m: npt.NDArray[np.float64],
        config: ImagePipelineConfig,
        border_detector: BorderPCA1D | None,
    ) -> tuple[npt.NDArray[np.bool_], npt.NDArray[np.bool_]]:
        """Classify inter-cell borders from the warped grayscale image.

        Samples a strip centred on each interior grid edge. For Observer puzzles,
        passes the raw grayscale strip to the trained BorderPCA1D model. For
        Guardian puzzles, applies adaptive thresholding then counts peaks/edges.

        Args:
            gry: Grayscale source image.
            m: Perspective transform matrix from locate_grid.
            config: Pipeline configuration.
            border_detector: Observer border model, or None for Guardian.

        Returns:
            (border_x, border_y) as (9, 8) and (8, 9) bool arrays.
        """
        resolution = config.resolution
        subres = config.subres
        bd = config.border_detection

        warped_gry: npt.NDArray[np.uint8] = np.asarray(
            cv2.warpPerspective(
                gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )
        brd_view: npt.NDArray[np.uint8] = np.asarray(
            cv2.adaptiveThreshold(
                warped_gry,
                255,
                cv2.ADAPTIVE_THRESH_MEAN_C,
                cv2.THRESH_BINARY,
                bd.adaptive_block_size,
                bd.adaptive_c,
            ),
            dtype=np.uint8,
        )
        brdrsh: npt.NDArray[np.bool_] = np.zeros((9, 8), dtype=bool)
        brdrsv: npt.NDArray[np.bool_] = np.zeros((8, 9), dtype=bool)

        sample_half = subres // bd.sample_fraction
        sample_margin = subres // bd.sample_margin

        for col in range(9):
            xm = ((2 * col + 1) * subres) // 2
            xb = xm - sample_half + sample_margin
            xt = xm + sample_half - sample_margin
            for row in range(1, 9):
                yl = (row * subres) - sample_half
                yr = (row * subres) + sample_half
                if border_detector is not None:
                    brdrph = np.min(warped_gry[xb:xt, yl:yr], axis=0)
                    brdrpv = np.min(warped_gry[yl:yr, xb:xt], axis=1)
                    isbh_val, isbv_val = border_detector.is_border([brdrph, brdrpv])
                    brdrsh[col, row - 1] = bool(isbh_val)
                    brdrsv[row - 1, col] = bool(isbv_val)
                else:
                    brdrsh[col, row - 1] = (
                        _process_sample_guardian(np.min(brd_view[xb:xt, yl:yr], axis=0))
                        > 2
                    )
                    brdrsv[row - 1, col] = (
                        _process_sample_guardian(np.min(brd_view[yl:yr, xb:xt], axis=1))
                        > 2
                    )

        return brdrsh, brdrsv

    @staticmethod
    def make_border_detector(config: ImagePipelineConfig) -> BorderPCA1D | None:
        """Load the Observer border detector, or return None for Guardian.

        Args:
            config: Pipeline configuration.

        Returns:
            Loaded BorderPCA1D for Observer, or None for Guardian.
        """
        if config.is_guardian:
            return None
        return load_observer_border_detector(config.border_pca1d_model_path)

    @staticmethod
    def make_num_recogniser(config: ImagePipelineConfig) -> CayenneNumber:
        """Load the number recogniser model from disk.

        Args:
            config: Pipeline configuration (supplies the model path).

        Returns:
            Loaded CayenneNumber classifier.
        """
        return load_number_recogniser(config.num_recogniser_path)
