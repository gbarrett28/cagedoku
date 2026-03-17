"""Configuration dataclasses for the killer_sudoku image pipeline.

Each sub-module of killer_sudoku.image has its own configuration dataclass here.
A top-level ImagePipelineConfig aggregates them for convenience.
"""

import dataclasses
from pathlib import Path
from typing import Literal


@dataclasses.dataclass(frozen=True)
class GridLocationConfig:
    """Parameters for Hough-line grid detection."""

    rho: int = 2
    theta_divisor: int = 16
    hough_threshold: int = 1792
    isblack_offset: int = 56


@dataclasses.dataclass(frozen=True)
class BorderDetectionConfig:
    """Parameters for cage border detection."""

    adaptive_block_size: int = 31
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
