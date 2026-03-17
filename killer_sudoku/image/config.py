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
        Binary search descends from hough_threshold_max until lines are found.
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
