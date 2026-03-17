"""Step 2 of the digit training pipeline: train PCA + SVM digit recogniser.

Reads the labelled digit images produced by collect_numerals, fits a PCA
dimensionality reduction followed by a Support Vector Classifier, and saves the
trained CayenneNumber model via joblib.

The training strategy:
  1. Group digit images by their label (0-9).
  2. Compute the per-label mean image (used as templates for the fast path).
  3. Fit PCA on the 10 mean images to capture inter-digit variation.
  4. Determine the minimum number of PCA dims explaining 99% of variance.
  5. Transform all digit images and train an SVC on the reduced space.

Usage:
    python -m killer_sudoku.training.train_number_recogniser --rag guardian
    python -m killer_sudoku.training.train_number_recogniser --rag observer
    python -m killer_sudoku.training.train_number_recogniser --rag guardian --bootstrap
"""

import argparse
import logging
import pickle
from pathlib import Path

import joblib  # type: ignore[import-untyped]
import numpy as np
import numpy.typing as npt
from sklearn.decomposition import PCA  # type: ignore[import-untyped]
from sklearn.svm import SVC  # type: ignore[import-untyped]

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.number_recognition import CayenneNumber

_log = logging.getLogger(__name__)


def train_number_recogniser(
    config: ImagePipelineConfig,
    bootstrap: bool = False,
) -> CayenneNumber:
    """Train a CayenneNumber model from labelled digit images.

    Reads either numerals.pkl (standard) or bootstrap_numerals.pkl (bootstrap
    mode) from config.puzzle_dir, groups digit images by label, computes
    per-label means, fits PCA on those means, then trains a KNN classifier on
    the reduced space.

    The number of PCA dimensions used is the minimum needed to explain at
    least 99% of variance in the mean images.

    Args:
        config: Pipeline configuration (supplies puzzle_dir and num_recogniser_path).
        bootstrap: If True, read bootstrap_numerals.pkl instead of numerals.pkl.
            Bootstrap labels are derived directly from cage totals with no
            recogniser dependency; set True for a first-pass clean training run.

    Returns:
        Trained CayenneNumber model (also saved to config.num_recogniser_path).

    Raises:
        FileNotFoundError: if the numerals file does not exist.
    """
    filename = "bootstrap_numerals.pkl" if bootstrap else "numerals.pkl"
    numerals_path = config.puzzle_dir / filename
    if not numerals_path.exists():
        script = "collect_numerals --bootstrap" if bootstrap else "collect_numerals"
        raise FileNotFoundError(
            f"{filename} not found at {numerals_path}. "
            f"Run first: python -m killer_sudoku.training.{script} "
            "--rag <guardian|observer>"
        )

    with open(numerals_path, "rb") as fh:
        val_nums: list[tuple[int, npt.NDArray[np.uint8]]] = pickle.load(fh)

    # Group digit images by label.
    cls: dict[int, list[npt.NDArray[np.uint8]]] = {}
    for n, p in val_nums:
        if n not in cls:
            cls[n] = []
        cls[n].append(p)

    # Compute per-label mean image; use a zero array for any missing label.
    first_img = val_nums[0][1]
    zero_img: npt.NDArray[np.float64] = np.zeros_like(first_img, dtype=np.float64)
    means: list[npt.NDArray[np.float64]] = [
        np.mean(cls[i], axis=0) if i in cls else zero_img for i in range(10)
    ]

    # Build template dict: mean image per digit as float32 for cv2.matchTemplate.
    templates: dict[int, npt.NDArray[np.float32]] = {
        i: np.asarray(means[i], dtype=np.float32) for i in range(10)
    }

    # Fit PCA on mean images to capture inter-digit structure.
    pca: PCA = PCA()
    pca.fit([m.flatten() for m in means])
    cumsum: npt.NDArray[np.float64] = np.cumsum(
        np.asarray(pca.explained_variance_ratio_, dtype=np.float64)
    )
    dims = int(np.argmax(cumsum > 0.99))
    _log.info("PCA dims for 99%% variance: %d", dims)

    # Project all labelled images into PCA space and train SVM.
    nums_pca: npt.NDArray[np.float64] = pca.transform(
        [p.flatten() for _, p in val_nums]
    )
    vals: list[int] = [n for n, _ in val_nums]
    svm_c = config.number_recognition.svm_c
    svm_gamma = config.number_recognition.svm_gamma
    svc: SVC = SVC(kernel="rbf", C=svm_c, gamma=svm_gamma)
    svc.fit([v[:dims] for v in nums_pca], vals)
    _log.info(
        "Trained SVC (C=%.1f, gamma=%s) on %d samples", svm_c, svm_gamma, len(vals)
    )

    model = CayenneNumber(
        pca,
        dims,
        svc,
        templates=templates,
        template_threshold=config.number_recognition.template_threshold,
    )
    joblib.dump(model, config.num_recogniser_path)
    _log.info("Saved number recogniser to %s", config.num_recogniser_path)

    return model


def main() -> None:
    """CLI entry point: train digit recogniser from numerals.pkl."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Train PCA+KNN digit recogniser from labelled digit images"
    )
    parser.add_argument("--rag", choices=["guardian", "observer"], required=True)
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        default=False,
        help="Read bootstrap_numerals.pkl instead of numerals.pkl",
    )
    args = parser.parse_args()

    config = ImagePipelineConfig(
        puzzle_dir=Path(args.rag),
        newspaper=args.rag,
    )

    train_number_recogniser(config, bootstrap=args.bootstrap)


if __name__ == "__main__":
    main()
