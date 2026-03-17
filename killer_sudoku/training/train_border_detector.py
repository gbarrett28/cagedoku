"""Observer border detector training pipeline.

Two detector types can be trained:
- BorderDecode (PCA + KMeans): rough initial classifier trained on all images.
- BorderPCA1D (single-component PCA): fast production classifier trained on
  SOLVED images only.

The BorderPCA1D collapses a two-stage PCA pipeline into a single inner-product
plus threshold comparison for fast inference.

Note: The website structure may have changed since the existing .jpg images were
collected. Treat the existing images as the primary source of training data.

Usage:
    python -m killer_sudoku.training.train_border_detector --rag observer
    python -m killer_sudoku.training.train_border_detector --rag observer \
        --detector pca1d
    python -m killer_sudoku.training.train_border_detector --rag observer --rework
"""

import argparse
import itertools
import logging
from pathlib import Path

import cv2
import joblib  # type: ignore[import-untyped]
import numpy as np
import numpy.typing as npt
from sklearn.cluster import KMeans  # type: ignore[import-untyped]
from sklearn.decomposition import PCA  # type: ignore[import-untyped]

from killer_sudoku.image.border_detection import BorderDecode, BorderPCA1D
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.training.status import TRAINING_STATUSES, StatusStore

_log = logging.getLogger(__name__)


def extract_border_samples_from_image(
    filepath: Path,
    config: ImagePipelineConfig,
) -> tuple[list[npt.NDArray[np.float64]], list[npt.NDArray[np.float64]]]:
    """Extract raw pixel strips for all interior grid border positions.

    Runs grid location and perspective warp, then samples a strip centred on
    each interior horizontal and vertical grid edge.

    Args:
        filepath: Path to the puzzle .jpg image file.
        config: Pipeline configuration (resolution, border_detection params).

    Returns:
        (brdrph_list, brdrpv_list) -- horizontal and vertical pixel strip arrays,
        each of shape (sample_width,), ordered col-major (col in [0,9), row in [1,9)).
    """
    resolution = config.resolution
    subres = config.subres
    bd = config.border_detection

    gry, img = get_gry_img(filepath, resolution)
    _blk, grid = locate_grid(gry, img, config.grid_location)

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
        cv2.getPerspectiveTransform(grid, dst_size), dtype=np.float64
    )
    warped_gry: npt.NDArray[np.uint8] = np.asarray(
        cv2.warpPerspective(gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR),
        dtype=np.uint8,
    )

    sample_half = subres // bd.sample_fraction
    sample_margin = subres // bd.sample_margin

    brdrph_list: list[npt.NDArray[np.float64]] = []
    brdrpv_list: list[npt.NDArray[np.float64]] = []

    for col in range(9):
        xm = ((2 * col + 1) * subres) // 2
        xb = xm - sample_half + sample_margin
        xt = xm + sample_half - sample_margin
        for row in range(1, 9):
            yl = (row * subres) - sample_half
            yr = (row * subres) + sample_half
            brdrph = np.asarray(
                np.min(warped_gry[xb:xt, yl:yr], axis=0), dtype=np.float64
            )
            brdrpv = np.asarray(
                np.min(warped_gry[yl:yr, xb:xt], axis=1), dtype=np.float64
            )
            brdrph_list.append(brdrph)
            brdrpv_list.append(brdrpv)

    return brdrph_list, brdrpv_list


def train_border_decode(
    config: ImagePipelineConfig, rework: bool = False
) -> BorderDecode:
    """Train a BorderDecode (PCA + KMeans) classifier on all available images.

    Collects border pixel strips from every puzzle image, fits PCA + KMeans
    to cluster them, then assigns each cluster a boolean is-border label based
    on how often that cluster co-occurs with a cell that has cage digits.

    A cluster is labelled as a border if fewer than 10x as many cells with cage
    numbers share it (heuristic: cage borders tend to appear near cage numbers).

    Args:
        config: Pipeline configuration.
        rework: If False and the model file exists, load and return it.

    Returns:
        Trained BorderDecode model (also saved to config.border_model_path).
    """
    if not rework and config.border_model_path.exists():
        result: BorderDecode = joblib.load(config.border_model_path)
        return result

    samples: list[npt.NDArray[np.float64]] = []
    hasnums: list[bool] = []
    num_recogniser = InpImage.make_num_recogniser(config)

    for f in itertools.islice(config.puzzle_dir.glob("*.jpg"), None):
        _log.info("Processing (train_border_decode) %s...", f)
        brdrph_list, brdrpv_list = extract_border_samples_from_image(f, config)
        try:
            inp = InpImage(f, config, None, num_recogniser)
        except Exception as exc:  # noqa: BLE001
            _log.warning("  Skipping %s: %s", f, exc)
            continue
        cage_totals = inp.info.cage_totals
        for col in range(9):
            for row in range(1, 9):
                idx = col * 8 + (row - 1)
                cbd = cage_totals[row, col] != 0 or cage_totals[row - 1, col] != 0
                hasnums.append(bool(cbd))
                samples.append(brdrph_list[idx])
                hasnums.append(bool(cbd))
                samples.append(brdrpv_list[idx])

    pca: PCA = PCA()
    brdrs_pca: npt.NDArray[np.float64] = pca.fit_transform(samples)
    kmeans: KMeans = KMeans(n_clusters=4, n_init=16)
    labels: npt.NDArray[np.intp] = kmeans.fit_predict(brdrs_pca)
    clusters: npt.NDArray[np.intp] = np.unique(labels)

    cl_brdr: dict[int, int] = {int(c): 0 for c in clusters}
    cl_size: dict[int, int] = {int(c): 0 for c in clusters}
    for c, b in zip(labels.tolist(), hasnums, strict=False):
        cl_size[c] += 1
        if b:
            cl_brdr[c] += 1

    cl_is_brdr: dict[int, bool] = {c: cl_size[c] < 10 * cl_brdr[c] for c in cl_size}

    model = BorderDecode(pca, kmeans, cl_is_brdr)
    joblib.dump(model, config.border_model_path)
    _log.info("Saved BorderDecode model to %s", config.border_model_path)
    return model


def collect_passing_border_samples(
    config: ImagePipelineConfig,
    rework: bool = False,
) -> tuple[list[npt.NDArray[np.float64]], list[npt.NDArray[np.float64]]]:
    """Collect border pixel strips from SOLVED puzzles, split by true label.

    Uses the border_x/border_y arrays from each solved InpImage to determine
    the true border/no-border label for each strip position.

    Args:
        config: Pipeline configuration.
        rework: If True, bypass the .jpk cache and reprocess images.

    Returns:
        (brdrs_0, brdrs_1) -- pixel strip lists for non-border and border positions.
    """
    status = StatusStore(config.status_path, config.puzzle_dir)
    border_detector = InpImage.make_border_detector(config)
    num_recogniser = InpImage.make_num_recogniser(config)
    brdrs_0: list[npt.NDArray[np.float64]] = []
    brdrs_1: list[npt.NDArray[np.float64]] = []

    for f in itertools.islice(config.puzzle_dir.glob("*.jpg"), None):
        if status[f] in TRAINING_STATUSES:
            _log.info("Processing (collect_passing_border_samples) %s...", f)
            inp = InpImage(f, config, border_detector, num_recogniser)
            resolution = config.resolution
            subres = config.subres
            bd = config.border_detection
            gry, img = get_gry_img(f, resolution)
            _blk, grid = locate_grid(gry, img, config.grid_location)
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
                cv2.getPerspectiveTransform(grid, dst_size), dtype=np.float64
            )
            warped_gry: npt.NDArray[np.uint8] = np.asarray(
                cv2.warpPerspective(
                    gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR
                ),
                dtype=np.uint8,
            )
            sample_half = subres // bd.sample_fraction
            sample_margin = subres // bd.sample_margin
            for col in range(9):
                xm = ((2 * col + 1) * subres) // 2
                xb = xm - sample_half + sample_margin
                xt = xm + sample_half - sample_margin
                for row in range(1, 9):
                    yl = (row * subres) - sample_half
                    yr = (row * subres) + sample_half
                    brdrph: npt.NDArray[np.float64] = np.asarray(
                        np.min(warped_gry[xb:xt, yl:yr], axis=0), dtype=np.float64
                    )
                    brdrpv: npt.NDArray[np.float64] = np.asarray(
                        np.min(warped_gry[yl:yr, xb:xt], axis=1), dtype=np.float64
                    )
                    is_h_border = bool(inp.info.border_x[col, row - 1])
                    is_v_border = bool(inp.info.border_y[row - 1, col])
                    if is_h_border:
                        brdrs_1.append(brdrph)
                    else:
                        brdrs_0.append(brdrph)
                    if is_v_border:
                        brdrs_1.append(brdrpv)
                    else:
                        brdrs_0.append(brdrpv)

    _log.info(
        "Number of borders True=%d, False=%d, TOTAL=%d",
        len(brdrs_1),
        len(brdrs_0),
        len(brdrs_1) + len(brdrs_0),
    )
    return brdrs_0, brdrs_1


def train_border_pca1d(
    config: ImagePipelineConfig,
    rework: bool = False,
    rework_all: bool = False,
) -> BorderPCA1D:
    """Train a BorderPCA1D (single-component PCA) classifier on SOLVED puzzles.

    Collapses a two-stage PCA pipeline into a single inner-product plus
    threshold comparison:
      P2 * ((P1 * (V - M1)) - M2) = P2*P1*V - (P2*P1*M1 + P2*M2)

    The breakpoint is set as a weighted combination of class extremes,
    favouring separation with a 75/25 weighting (p=0.25).

    Args:
        config: Pipeline configuration.
        rework: If False and model file exists, load and return it.
        rework_all: If True, bypass .jpk cache when collecting border samples.

    Returns:
        Trained BorderPCA1D model (also saved to config.border_pca1d_model_path).
    """
    if not rework and config.border_pca1d_model_path.exists():
        result: BorderPCA1D = joblib.load(config.border_pca1d_model_path)
        return result

    brdrs_raw_0, brdrs_raw_1 = collect_passing_border_samples(config, rework=rework_all)
    len0 = len(brdrs_raw_0)

    pca_raw: PCA = PCA()
    brdrs_0_pca: npt.NDArray[np.float64] = pca_raw.fit_transform(brdrs_raw_0)
    brdrs_1_pca: npt.NDArray[np.float64] = pca_raw.transform(brdrs_raw_1)
    cumsum: npt.NDArray[np.float64] = np.cumsum(
        np.asarray(pca_raw.explained_variance_ratio_, dtype=np.float64)
    )
    dims = int(np.argmax(cumsum > 0.99))
    _log.info("dims=%d", dims)

    all_high: list[npt.NDArray[np.float64]] = [b[dims:] for b in brdrs_0_pca] + [
        b[dims:] for b in brdrs_1_pca
    ]
    pca: PCA = PCA(n_components=2)
    brdrs_2d: npt.NDArray[np.float64] = pca.fit_transform(all_high)

    coeffs: list[float] = [float(b[0]) for b in brdrs_2d]
    m0 = float(np.mean(coeffs[:len0]))
    m1 = float(np.mean(coeffs[len0:]))
    cmp = m0 >= m1
    p = 0.25
    bp: float
    if not cmp:
        bp = (p * float(np.max(coeffs[:len0]))) + (
            (1 - p) * float(np.min(coeffs[len0:]))
        )
    else:
        bp = ((1 - p) * float(np.min(coeffs[:len0]))) + (
            p * float(np.max(coeffs[len0:]))
        )

    # Collapse two-stage PCA to single inner-product + scalar offset.
    # p2 * ((p1 * (v - m1)) - m2) = p2*p1*v - (p2*p1*m1 + p2*m2)
    p1: npt.NDArray[np.float64] = np.asarray(
        pca_raw.components_[dims:, :], dtype=np.float64
    )
    m1_mean: npt.NDArray[np.float64] = np.asarray(pca_raw.mean_, dtype=np.float64)
    p2: npt.NDArray[np.float64] = np.asarray(pca.components_[:1, :], dtype=np.float64)
    m2_mean: npt.NDArray[np.float64] = np.asarray(pca.mean_, dtype=np.float64)
    proj_vec: npt.NDArray[np.float64] = np.asarray(np.matmul(p2, p1), dtype=np.float64)
    proj_bias: npt.NDArray[np.float64] = np.asarray(
        np.matmul(p2, np.matmul(p1, m1_mean)) + np.matmul(p2, m2_mean),
        dtype=np.float64,
    )

    _log.info("breakpoint=%s, swapped=%s", bp, cmp)

    model = BorderPCA1D(proj_vec, proj_bias + bp, cmp)
    joblib.dump(model, config.border_pca1d_model_path)
    _log.info("Saved BorderPCA1D model to %s", config.border_pca1d_model_path)
    return model


def main() -> None:
    """CLI entry point: train Observer border detector."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Train Observer border detector model")
    parser.add_argument("--rag", choices=["guardian", "observer"], required=True)
    parser.add_argument(
        "--detector",
        choices=["decode", "pca1d"],
        default="pca1d",
        help="Which detector type to train (default: pca1d)",
    )
    parser.add_argument(
        "--rework",
        action="store_true",
        default=False,
        help="Retrain even if model file already exists",
    )
    parser.add_argument(
        "--rework-all",
        action="store_true",
        default=False,
        help="Also bypass .jpk cache when collecting border samples",
    )
    args = parser.parse_args()

    if args.rag == "guardian":
        _log.info("Border detector training is only applicable to Observer puzzles.")
        return

    config = ImagePipelineConfig(
        puzzle_dir=Path(args.rag),
        newspaper=args.rag,
        rework=args.rework,
    )

    if args.detector == "decode":
        train_border_decode(config, rework=args.rework)
    else:
        train_border_pca1d(config, rework=args.rework, rework_all=args.rework_all)


if __name__ == "__main__":
    main()
