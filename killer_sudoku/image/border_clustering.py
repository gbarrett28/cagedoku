"""Stage 4: format-agnostic anchored border clustering.

Classifies each of the 144 inner borders as cage/non-cage without any
newspaper-specific code, using k-means clustering anchored by cage-total
cells detected in Stage 3.

The 144 borders are pre-labelled structurally into two groups:
  - 36 box boundaries (at gap indices 2 and 5: between 3x3 boxes)
  - 108 cell boundaries (all other inner edges)

Two independent 2-class k-means problems are solved, one per group.
Cage-total anchor cells resolve which cluster label corresponds to cage borders.
When no anchors are available, all borders in the group return 0.5 (uncertain).

Strip sampling follows the same [x, y]-transposed convention used in
detect_borders_peak_count and _identify_borders (see border_detection.py).
"""

from __future__ import annotations

import logging
from enum import Enum

import numpy as np
import numpy.typing as npt
from scipy.signal import find_peaks
from sklearn.cluster import KMeans  # type: ignore[import-untyped]
from sklearn.preprocessing import StandardScaler  # type: ignore[import-untyped]

from killer_sudoku.image.config import BorderClusteringConfig

_log = logging.getLogger(__name__)


class BoundaryKind(Enum):
    """Whether a border lies on a 3x3 box boundary or an ordinary cell boundary."""

    BOX = "box"
    CELL = "cell"


def boundary_kind(gap_idx: int) -> BoundaryKind:
    """Return the structural kind of a border gap.

    Box boundaries occur between the 3rd and 4th rows/columns (gap_idx=2) and
    between the 6th and 7th (gap_idx=5).  In 0-indexed 8-gap space, the
    condition is gap_idx % 3 == 2.

    Args:
        gap_idx: 0-indexed gap index (0..7) between adjacent rows or columns.

    Returns:
        BoundaryKind.BOX if the gap lies on a 3x3 box boundary, else
        BoundaryKind.CELL.
    """
    return BoundaryKind.BOX if gap_idx % 3 == 2 else BoundaryKind.CELL


def strip_features(strip: npt.NDArray[np.uint8]) -> npt.NDArray[np.float64]:
    """Extract 4 summary features from a 1D min-projected border strip.

    Features: [peak_count, mean_brightness, variance, amplitude].
    Dark features (cage borders, grid lines) appear as dips in the strip; the
    inverted strip (~strip) is used for peak finding so dark dips become peaks.

    Args:
        strip: 1D array of uint8 pixel values from the border region.

    Returns:
        float64 array of shape (4,).
    """
    f: npt.NDArray[np.float64] = strip.astype(np.float64)
    inverted: npt.NDArray[np.float64] = 255.0 - f
    peaks, _ = find_peaks(inverted, height=32.0)
    return np.array(
        [
            float(len(peaks)),
            float(np.mean(f)),
            float(np.var(f)),
            float(np.max(f)) - float(np.min(f)),
        ],
        dtype=np.float64,
    )


def _sample_strip(
    warped_gry: npt.NDArray[np.uint8],
    is_horizontal: bool,
    gap_idx: int,
    along_idx: int,
    subres: int,
    sample_half: int,
    sample_margin_px: int,
) -> npt.NDArray[np.uint8]:
    """Sample a 1D min-projected strip for one interior border edge.

    Follows the sampling convention established in detect_borders_peak_count:
    the first numpy axis is treated as the x (column) direction, consistent
    with the transposed indexing used throughout the border detection code.

    Args:
        warped_gry: Warped grayscale image (resolution x resolution).
        is_horizontal: True for a horizontal border (constant y), False for
            vertical (constant x).
        gap_idx: 0-indexed gap position (0..7) in the perpendicular direction.
        along_idx: 0-indexed cell position (0..8) along the border.
        subres: Pixels per cell side.
        sample_half: Half-width of the sampling strip in pixels.
        sample_margin_px: Pixels removed from each end of the strip.

    Returns:
        1D uint8 array (the min-projected strip).
    """
    xm = ((2 * along_idx + 1) * subres) // 2
    xb = xm + sample_margin_px
    xt = xm + sample_half - sample_margin_px
    yl = ((gap_idx + 1) * subres) - sample_half
    yr = ((gap_idx + 1) * subres) + sample_half

    if is_horizontal:
        return np.asarray(np.min(warped_gry[xb:xt, yl:yr], axis=0), dtype=np.uint8)
    return np.asarray(np.min(warped_gry[yl:yr, xb:xt], axis=1), dtype=np.uint8)


def _anchor_set(
    cage_total_confidence: npt.NDArray[np.float64],
    threshold: float,
) -> set[tuple[bool, int, int]]:
    """Return the set of anchor borders from high-confidence cage-total cells.

    For a cage-total cell at (row, col), the borders above it (horizontal,
    gap_idx=row-1) and to its left (vertical, gap_idx=col-1) are cage borders.
    Outer-edge borders (row=0 or col=0) have no inner border above/left and
    are skipped.

    Returns:
        Set of (is_horizontal, gap_idx, along_idx) triples.
    """
    anchors: set[tuple[bool, int, int]] = set()
    for row in range(9):
        for col in range(9):
            if cage_total_confidence[row, col] >= threshold:
                if row > 0:
                    anchors.add((True, row - 1, col))
                if col > 0:
                    anchors.add((False, row, col - 1))
    return anchors


def _cluster_group(
    features: list[npt.NDArray[np.float64]],
    anchor_positions: list[int],
) -> npt.NDArray[np.float64]:
    """Cluster one group of border strips into cage/non-cage.

    Uses KMeans(k=2); anchor positions resolve which cluster label is cage.
    Returns 0.5 for all strips when no anchors are provided (polarity unknown).

    Args:
        features: List of 4-element feature vectors, one per border in the group.
        anchor_positions: Indices into features of known cage-border strips.

    Returns:
        float64 array of length len(features) with values in {0.0, 0.5, 1.0}.
    """
    n = len(features)
    if n == 0:
        return np.array([], dtype=np.float64)
    if not anchor_positions:
        return np.full(n, 0.5, dtype=np.float64)

    x: npt.NDArray[np.float64] = np.stack(features)
    scaler: StandardScaler = StandardScaler()
    x_scaled: npt.NDArray[np.float64] = np.asarray(
        scaler.fit_transform(x), dtype=np.float64
    )

    km: KMeans = KMeans(n_clusters=2, n_init=10, random_state=42)
    labels: npt.NDArray[np.intp] = np.asarray(km.fit_predict(x_scaled), dtype=np.intp)

    anchor_labels = labels[anchor_positions]
    counts = np.bincount(anchor_labels, minlength=2)
    cage_cluster = int(np.argmax(counts))
    _log.debug(
        "cluster_group: %d anchors, cage_cluster=%d, counts=%s",
        len(anchor_positions),
        cage_cluster,
        counts.tolist(),
    )

    cage_mask: npt.NDArray[np.bool_] = np.asarray(
        labels == cage_cluster, dtype=np.bool_
    )
    return cage_mask.astype(np.float64)


def cluster_borders(
    warped_gry: npt.NDArray[np.uint8],
    cage_total_confidence: npt.NDArray[np.float64],
    subres: int,
    config: BorderClusteringConfig,
    anchor_confidence_threshold: float = 0.5,
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Classify all 144 inner borders as cage/non-cage without format-specific code.

    Extracts features from each border strip, groups by BoundaryKind, uses
    cage-total anchors to resolve cluster polarity, and returns soft
    cage-border probabilities.

    Args:
        warped_gry: Perspective-corrected grayscale image (resolution x resolution).
        cage_total_confidence: Shape (9, 9) array from scan_cells Stage 3.
        subres: Pixels per cell side.
        config: Clustering parameters.
        anchor_confidence_threshold: Minimum cage_total_confidence for a cell to
            contribute positive border anchors.  Callers should pass
            CellScanConfig.anchor_confidence_threshold; defaults to 0.5.

    Returns:
        (border_x_prob, border_y_prob) — shapes (9, 8) and (8, 9) with values in
        [0, 1].  Values > 0.5 indicate a likely cage border; 0.5 means uncertain.
    """
    sample_half = subres // config.sample_fraction
    sample_margin_px = subres // config.sample_margin
    anchors = _anchor_set(cage_total_confidence, anchor_confidence_threshold)

    # Collect features grouped by BoundaryKind only — horizontal and vertical
    # borders of the same structural type are clustered together.  This doubles
    # the anchor count per group (anchors from both axes vote on the same
    # polarity decision) and halves the number of independent polarity choices.
    # Key: BoundaryKind
    # Value: list of (is_horizontal, gap_idx, along_idx, feature_vector)
    _edge_entry = tuple[bool, int, int, npt.NDArray[np.float64]]
    groups: dict[BoundaryKind, list[_edge_entry]] = {
        BoundaryKind.CELL: [],
        BoundaryKind.BOX: [],
    }

    for gap_idx in range(8):
        kind = boundary_kind(gap_idx)
        for along_idx in range(9):
            for is_h in (True, False):
                strip = _sample_strip(
                    warped_gry,
                    is_h,
                    gap_idx,
                    along_idx,
                    subres,
                    sample_half,
                    sample_margin_px,
                )
                feat = strip_features(strip)
                groups[kind].append((is_h, gap_idx, along_idx, feat))

    border_x_prob = np.zeros((9, 8), dtype=np.float64)
    border_y_prob = np.zeros((8, 9), dtype=np.float64)

    for _kind, entries in groups.items():
        features = [e[3] for e in entries]
        anchor_pos = [
            i for i, (is_h, g, a, _) in enumerate(entries) if (is_h, g, a) in anchors
        ]
        probs = _cluster_group(features, anchor_pos)
        for i, (is_h, gap_idx, along_idx, _) in enumerate(entries):
            if is_h:
                border_x_prob[along_idx, gap_idx] = probs[i]
            else:
                border_y_prob[gap_idx, along_idx] = probs[i]

    return border_x_prob, border_y_prob
