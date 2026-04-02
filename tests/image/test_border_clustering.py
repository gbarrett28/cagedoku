"""Tests for killer_sudoku.image.border_clustering."""

import numpy as np

from killer_sudoku.image.border_clustering import (
    BoundaryKind,
    boundary_kind,
    cluster_borders,
    strip_features,
)
from killer_sudoku.image.config import BorderClusteringConfig

SUBRES = 128
RESOLUTION = 9 * SUBRES


# ---------------------------------------------------------------------------
# boundary_kind
# ---------------------------------------------------------------------------


def test_boundary_kind_box_at_index_2() -> None:
    """Gap index 2 (between rows 2 and 3) is a box boundary."""
    assert boundary_kind(2) == BoundaryKind.BOX


def test_boundary_kind_box_at_index_5() -> None:
    """Gap index 5 (between rows 5 and 6) is a box boundary."""
    assert boundary_kind(5) == BoundaryKind.BOX


def test_boundary_kind_cell_at_index_0() -> None:
    """Gap index 0 is a cell boundary."""
    assert boundary_kind(0) == BoundaryKind.CELL


def test_boundary_kind_cell_at_index_3() -> None:
    """Gap index 3 is a cell boundary (3 % 3 == 0, not 2)."""
    assert boundary_kind(3) == BoundaryKind.CELL


def test_all_8_gaps_have_2_box_and_6_cell() -> None:
    """The 8 row-gaps (or col-gaps) contain exactly 2 BOX and 6 CELL entries."""
    kinds = [boundary_kind(g) for g in range(8)]
    assert kinds.count(BoundaryKind.BOX) == 2
    assert kinds.count(BoundaryKind.CELL) == 6


# ---------------------------------------------------------------------------
# strip_features
# ---------------------------------------------------------------------------


def test_strip_features_shape() -> None:
    """strip_features returns a 4-element float64 array."""
    strip = np.full(64, 128, dtype=np.uint8)
    feat = strip_features(strip)
    assert feat.shape == (4,)
    assert feat.dtype == np.float64


def test_flat_strip_has_zero_peaks() -> None:
    """A completely flat strip produces zero peaks (feature index 0 == 0.0)."""
    strip = np.full(64, 128, dtype=np.uint8)
    feat = strip_features(strip)
    assert feat[0] == 0.0  # peak_count


def test_dashed_strip_has_multiple_peaks() -> None:
    """A dashed-line strip (alternating dark/light) produces 3+ peaks."""
    # Simulate a cage border: three dark dashes
    dash = [200] * 10 + [20] * 6
    strip = np.array(dash + dash + dash + [200] * 8, dtype=np.uint8)
    feat = strip_features(strip)
    assert feat[0] >= 3.0, f"Expected >= 3 peaks for dashed strip, got {feat[0]}"


# ---------------------------------------------------------------------------
# cluster_borders — shape and type contract
# ---------------------------------------------------------------------------


def _blank_warped() -> np.ndarray:
    return np.full((RESOLUTION, RESOLUTION), 200, dtype=np.uint8)


def test_cluster_borders_output_shapes() -> None:
    """cluster_borders returns (9, 8) and (8, 9) float64 arrays."""
    warped = _blank_warped()
    cage_conf = np.zeros((9, 9), dtype=np.float64)
    bx, by = cluster_borders(warped, cage_conf, SUBRES, BorderClusteringConfig())
    assert bx.shape == (9, 8)
    assert by.shape == (8, 9)
    assert bx.dtype == np.float64
    assert by.dtype == np.float64


def test_cluster_borders_values_in_unit_interval() -> None:
    """All output probabilities are in [0, 1]."""
    warped = _blank_warped()
    cage_conf = np.zeros((9, 9), dtype=np.float64)
    bx, by = cluster_borders(warped, cage_conf, SUBRES, BorderClusteringConfig())
    assert float(bx.min()) >= 0.0
    assert float(bx.max()) <= 1.0
    assert float(by.min()) >= 0.0
    assert float(by.max()) <= 1.0


def test_cluster_borders_no_anchors_returns_uncertain() -> None:
    """With no anchor cells, all borders return 0.5 (polarity cannot be resolved)."""
    warped = _blank_warped()
    cage_conf = np.zeros((9, 9), dtype=np.float64)  # no anchors
    bx, by = cluster_borders(warped, cage_conf, SUBRES, BorderClusteringConfig())
    assert np.all(bx == 0.5), "No-anchor case should yield all 0.5"
    assert np.all(by == 0.5)
