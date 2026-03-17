"""Cage border detection for killer sudoku puzzle images.

Two detectors are implemented:
- BorderDecode: PCA + KMeans clustering (used during training only).
- BorderPCA1D: Fast single-principal-component classifier (production observer model).

For Guardian puzzles, threshold-based detection is used directly in InpImage
(no trained model needed). For Observer puzzles, a BorderPCA1D model is loaded
lazily from disk using load_observer_border_detector().
"""

from pathlib import Path

import joblib  # type: ignore[import-untyped]
import numpy as np
import numpy.typing as npt
from scipy.signal import find_peaks
from sklearn.cluster import KMeans  # type: ignore[import-untyped]
from sklearn.decomposition import PCA  # type: ignore[import-untyped]


class BorderDecode:
    """PCA + KMeans border classifier, used only during training.

    Fits a PCA transformation and KMeans clustering to border samples,
    then maps cluster indices to boolean border/not-border labels.
    """

    def __init__(
        self,
        pca: PCA,
        kmeans: KMeans,
        isbrdr: dict[int, bool],
    ) -> None:
        self.pca: PCA = pca
        self.kmeans: KMeans = kmeans
        self.isbrdr: dict[int, bool] = isbrdr

    def is_border(self, brdrs: list[npt.NDArray[np.float64]]) -> list[bool]:
        """Classify a list of border samples as border or not.

        Args:
            brdrs: List of 1D pixel arrays sampled from each candidate border.

        Returns:
            List of booleans, True where a cage border was detected.
        """
        cls: npt.NDArray[np.intp] = self.kmeans.predict(self.pca.transform(brdrs))
        return [bool(self.isbrdr[int(c)]) for c in cls]


class BorderPCA1D:
    """Single principal-component border classifier (production Observer model).

    Collapses a two-stage PCA pipeline into a single inner-product plus
    threshold comparison, for fast inference without full PCA overhead.

    Attributes:
        vec: Combined projection vector (product of both PCA component matrices).
        bp: Bias/breakpoint scalar — subtract then compare sign.
        cmp: Polarity flag — when True, invert the comparison direction.
    """

    def __init__(
        self,
        pp: npt.NDArray[np.float64],
        mm: npt.NDArray[np.float64],
        cmp: bool,
    ) -> None:
        self.vec: npt.NDArray[np.float64] = pp
        self.bp: npt.NDArray[np.float64] = mm
        self.cmp: bool = cmp

    def project(self, brdps: list[npt.NDArray[np.float64]]) -> list[float]:
        """Project border samples onto the single discriminant axis.

        Args:
            brdps: List of 1D pixel arrays sampled from each candidate border.

        Returns:
            List of scalar projection values (positive or negative).
        """
        return [float(np.matmul(self.vec, b)) - float(self.bp) for b in brdps]

    def is_border(self, brdps: list[npt.NDArray[np.float64]]) -> list[bool]:
        """Classify border samples as border or not using the projection.

        Args:
            brdps: List of 1D pixel arrays sampled from each candidate border.

        Returns:
            List of booleans, True where a cage border was detected.
        """
        return [(b > 0) != self.cmp for b in self.project(brdps)]


def load_observer_border_detector(model_path: Path) -> BorderPCA1D:
    """Load a trained BorderPCA1D model from disk using joblib.

    Args:
        model_path: Path to the serialised BorderPCA1D model file.

    Raises:
        FileNotFoundError: if model_path does not exist.
    """
    if not model_path.exists():
        raise FileNotFoundError(f"Observer border model not found: {model_path}")
    result: BorderPCA1D = joblib.load(model_path)
    return result


def detect_borders_peak_count(
    warped_brd: npt.NDArray[np.uint8],
    subres: int,
    sample_fraction: int,
    sample_margin: int,
) -> tuple[npt.NDArray[np.bool_], npt.NDArray[np.bool_]]:
    """Detect cage borders using peak counting on an adaptive-threshold image.

    Iterates over all 144 interior cell edges, extracts a pixel strip centred
    on each edge from the adaptive-threshold image, and counts peaks in the
    inverted strip. More than 2 peaks indicates a printed cage border line.

    This is the Guardian border detection algorithm. It can also be used as a
    bootstrap approximation for Observer images when no trained model is yet
    available (accuracy is lower but sufficient to seed initial training).

    Args:
        warped_brd: Adaptive-threshold binary image (output of
            cv2.adaptiveThreshold), warped to canonical grid resolution.
        subres: Sub-resolution — pixels per cell side.
        sample_fraction: Strip half-width divisor:
            half_width = subres // sample_fraction.
        sample_margin: Strip margin divisor: margin = subres // sample_margin.

    Returns:
        (border_x, border_y) — (9, 8) and (8, 9) bool arrays; True where a
        cage border was detected.
    """
    border_x: npt.NDArray[np.bool_] = np.zeros((9, 8), dtype=bool)
    border_y: npt.NDArray[np.bool_] = np.zeros((8, 9), dtype=bool)
    sample_half = subres // sample_fraction
    sample_margin_px = subres // sample_margin

    for col in range(9):
        xm = ((2 * col + 1) * subres) // 2
        xb = xm - sample_half + sample_margin_px
        xt = xm + sample_half - sample_margin_px
        for row in range(1, 9):
            yl = (row * subres) - sample_half
            yr = (row * subres) + sample_half
            sh: npt.NDArray[np.uint8] = np.min(warped_brd[xb:xt, yl:yr], axis=0)
            sv: npt.NDArray[np.uint8] = np.min(warped_brd[yl:yr, xb:xt], axis=1)
            peaks_h: npt.NDArray[np.intp]
            peaks_v: npt.NDArray[np.intp]
            peaks_h, _ = find_peaks(~sh, height=32)
            peaks_v, _ = find_peaks(~sv, height=32)
            border_x[col, row - 1] = len(peaks_h) > 2
            border_y[row - 1, col] = len(peaks_v) > 2

    return border_x, border_y
