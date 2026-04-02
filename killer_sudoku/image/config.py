"""Configuration dataclasses for the killer_sudoku image pipeline.

Each sub-module of killer_sudoku.image has its own configuration dataclass here.
A top-level ImagePipelineConfig aggregates them for convenience.
"""

import dataclasses
from pathlib import Path
from typing import Literal


@dataclasses.dataclass(frozen=True)
class GridLocationConfig:
    """Parameters for Hough-line grid detection.

    Two detection strategies are available, selected by use_hough_p:

    HoughLines (use_hough_p=False, default): classical accumulator with adaptive
    threshold.
        Binary search descends from hough_threshold_max until at least
        hough_lines_min_count lines are found.
        hough_lines_theta_divisor controls angular resolution (16 ≈ 11°).
        This is the reliable production strategy for both Guardian and Observer.

    HoughLinesP (use_hough_p=True): probabilistic line segments.
        hough_theta_divisor controls angular resolution (180 = 1°).
        min_line_length_fraction * resolution sets the minimum segment length:
        a valid grid line must span at least one 3-box row (resolution / 3).
        max_line_gap bridges small discontinuities in ink.
        Note: known to underperform on Observer puzzles (24/424 grid failures).
    """

    rho: int = 2
    hough_theta_divisor: int = 180
    min_line_length_fraction: float = 0.3
    max_line_gap: int = 20
    hough_p_threshold: int = 80
    hough_lines_theta_divisor: int = 16
    hough_threshold_max: int = 2048
    hough_lines_min_count: int = 20
    """Minimum line count for the HoughLines binary search.

    The binary search halves the threshold until this many lines are found
    (or threshold drops below 1).  Images where the grid spans only part of
    the frame accumulate fewer votes per line, so the search must descend
    further than a single-image-filling grid would require.
    """
    isblack_offset: int = 56
    use_hough_p: bool = False


@dataclasses.dataclass(frozen=True)
class BorderDetectionConfig:
    """Parameters for cage border detection.

    adaptive_block_size is not stored here; it is derived from subres
    as (subres // 4) | 1 and exposed via ImagePipelineConfig.adaptive_block_size.
    This ensures the value stays odd (required by cv2.adaptiveThreshold) and
    automatically tracks any change to the grid resolution.
    """

    adaptive_c: int = 0
    sample_fraction: int = 4
    sample_margin: int = 16


@dataclasses.dataclass(frozen=True)
class NumberRecognitionConfig:
    """Parameters for digit/number recognition.

    cluster_labels_guardian and cluster_labels_observer are empirically derived
    cluster-to-digit mappings determined by visual inspection of training data.

    The SVM and template-matching hyperparameters control the two-stage
    classifier used during inference: template matching (fast path) runs first;
    if the best match score is below template_threshold, the SVM fallback runs.
    """

    cluster_labels_guardian: tuple[int, ...] = (
        3,
        1,
        2,
        0,
        1,
        8,
        7,
        9,
        6,
        1,
        4,
        0,
        2,
        5,
        3,
        7,
    )
    cluster_labels_observer: tuple[int, ...] = (
        2,
        1,
        6,
        4,
        0,
        7,
        8,
        3,
        1,
        2,
        1,
        9,
        5,
        1,
        2,
        5,
    )
    subres: int = 128
    svm_c: float = 5.0
    svm_gamma: str = "scale"
    template_threshold: float = 0.85
    # C offset for adaptive threshold fallback: when the primary contour-based
    # detection (using the global blk binary image) produces a cage-total sum
    # outside [360, 450], the pipeline retries using an adaptive threshold of
    # the warped grayscale with this C value.  Needs to be large enough to
    # separate ink from paper even when the global threshold over-includes
    # grey pixels (isblack too high), but not so large that faint digits are
    # missed.  Validated empirically: C=20 recovers image 278 without
    # regressions across the full Guardian and Observer datasets.
    contour_fallback_adaptive_c: int = 20


@dataclasses.dataclass(frozen=True)
class CellScanConfig:
    """Parameters for Stage 3: lightweight per-cell classification.

    Detects which cells contain cage totals (small contour in top-left quadrant)
    or pre-filled digits (large centred contour) before border detection runs.
    Output is used to anchor border clustering in Stage 4.
    """

    classic_min_size_fraction: float = 1.0 / 3.0
    """Minimum contour dimension as a fraction of subres for classic digit detection.

    A pre-filled digit occupies at least one-third of the cell in both dimensions.
    """

    anchor_confidence_threshold: float = 0.5
    """Minimum cage_total_confidence for a cell to contribute positive border anchors.

    Cells whose cage_total_confidence meets this threshold are treated as cage heads;
    their top and left inner borders are used as positive anchors for clustering.
    """


@dataclasses.dataclass(frozen=True)
class BorderClusteringConfig:
    """Parameters for Stage 4: format-agnostic anchored border clustering.

    Classifies each of the 144 inner borders as cage/non-cage using per-image
    k-means clustering, anchored by cage-total cells detected in Stage 3.
    """

    sample_fraction: int = 4
    """Strip half-width divisor: half_width = subres // sample_fraction pixels."""

    sample_margin: int = 16
    """Strip end inset divisor: margin = subres // sample_margin pixels from each end.

    Removes pixels at both ends of the strip to avoid sampling digit ink
    in adjacent cells.
    """


@dataclasses.dataclass(frozen=True)
class ImagePipelineConfig:
    """Top-level configuration for the image processing pipeline."""

    puzzle_dir: Path
    newspaper: Literal["guardian", "observer"]
    rework: bool = False
    grid_location: GridLocationConfig = dataclasses.field(
        default_factory=GridLocationConfig
    )
    border_detection: BorderDetectionConfig = dataclasses.field(
        default_factory=BorderDetectionConfig
    )
    number_recognition: NumberRecognitionConfig = dataclasses.field(
        default_factory=NumberRecognitionConfig
    )
    cell_scan: CellScanConfig = dataclasses.field(default_factory=CellScanConfig)
    """Stage 3 cell-scan configuration."""

    border_clustering: BorderClusteringConfig = dataclasses.field(
        default_factory=BorderClusteringConfig
    )
    """Stage 4 anchored-clustering configuration."""

    poc_border_clustering: bool = False
    """Run the new anchored-clustering pipeline in parallel with the existing pipeline.

    When True, InpImage.__init__ also runs Stage 3 (cell scan) and Stage 4
    (border clustering), converts the soft border assignments to hard ones, compares
    them with the existing pipeline output, and logs any discrepancies.  The primary
    pipeline (existing Guardian/Observer detection) is unchanged; this flag enables
    Phase 1 proof-of-concept comparison only.
    """

    n_jobs: int = -1
    """Number of parallel worker processes for batch operations.

    Passed directly to joblib.Parallel(n_jobs=...).  -1 means use all
    available CPUs; 1 disables parallelism (useful for debugging).
    """

    @property
    def is_guardian(self) -> bool:
        """True if the newspaper is Guardian."""
        return self.newspaper == "guardian"

    @property
    def is_observer(self) -> bool:
        """True if the newspaper is Observer."""
        return self.newspaper == "observer"

    @property
    def subres(self) -> int:
        """Sub-resolution for cell images (pixels per cell side)."""
        return self.number_recognition.subres

    @property
    def resolution(self) -> int:
        """Full grid resolution in pixels (9 * subres)."""
        return 9 * self.subres

    @property
    def adaptive_block_size(self) -> int:
        """Adaptive threshold block size derived from subres.

        Computed as (subres // 4) | 1 to ensure the value is always odd,
        as required by cv2.adaptiveThreshold. For the default subres=128
        this gives 33, replacing the former magic constant 31.
        """
        return (self.subres // 4) | 1

    @property
    def status_path(self) -> Path:
        """Path to the solved/status file."""
        return self.puzzle_dir / "status.pkl"

    @property
    def border_model_path(self) -> Path:
        """Path to the Observer border detection model file."""
        return self.puzzle_dir / "brdr.pkl"

    @property
    def border_pca1d_model_path(self) -> Path:
        """Path to the Observer 1D PCA border model file."""
        return self.puzzle_dir / "pca_1d_border.pkl"

    @property
    def num_recogniser_path(self) -> Path:
        """Path to the number recogniser model file."""
        return self.puzzle_dir / "nums_pca_s.pkl"
