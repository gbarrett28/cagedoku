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
