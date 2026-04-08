"""Tests for killer_sudoku.image.border_clustering."""

import numpy as np

from killer_sudoku.image.border_clustering import (
    BoundaryKind,
    _anchor_set,
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


def test_flat_strip_has_high_percentiles() -> None:
    """A flat strip (all same brightness) has all percentiles equal to that value.

    Spec change from peak_count: feat[0] is now p5 (5th-percentile brightness),
    not peak_count.  A flat strip at value 128 has p5 == mean == 128.
    """
    strip = np.full(64, 128, dtype=np.uint8)
    feat = strip_features(strip)
    assert feat[0] == 128.0  # p5 == 128 (no dark dip)


def test_dark_strip_has_low_p5() -> None:
    """A strip with dark regions has a low p5 (5th-percentile brightness).

    Spec change from peak_count: feat[0] is now p5 (position-independent),
    not peak_count.  Three dark dashes (value 20) among lighter pixels give
    p5 well below 128, distinguishing a cage border from a blank strip.
    """
    dash = [200] * 10 + [20] * 6
    strip = np.array(dash + dash + dash + [200] * 8, dtype=np.uint8)
    feat = strip_features(strip)
    assert feat[0] < 128.0, f"Expected low p5 for dark strip, got {feat[0]}"


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


# ---------------------------------------------------------------------------
# _anchor_set — index convention
# ---------------------------------------------------------------------------


def test_anchor_set_horizontal_above() -> None:
    """Cage total at (row=2, col=3) → horizontal anchor (True, gap=1, along=3)."""
    conf = np.zeros((9, 9), dtype=np.float64)
    conf[2, 3] = 1.0
    anchors = _anchor_set(conf, threshold=0.5)
    assert (True, 1, 3) in anchors, "Expected horizontal anchor above cell (2,3)"


def test_anchor_set_vertical_left() -> None:
    """Cage total at (row=2, col=3) → vertical anchor (False, gap=2, along=2).

    The vertical anchor convention is (is_h=False, gap_idx=col-1, along_idx=row).
    A previous bug had gap_idx and along_idx transposed.
    """
    conf = np.zeros((9, 9), dtype=np.float64)
    conf[2, 3] = 1.0
    anchors = _anchor_set(conf, threshold=0.5)
    assert (False, 2, 2) in anchors, "Expected vertical anchor left of cell (2,3)"
    assert (False, 2, 3) not in anchors, "Transposed (buggy) form must not be present"


def test_anchor_set_top_left_cell_has_no_anchors() -> None:
    """Cell (0, 0) is in the top-left corner — no borders above or left."""
    conf = np.zeros((9, 9), dtype=np.float64)
    conf[0, 0] = 1.0
    anchors = _anchor_set(conf, threshold=0.5)
    assert len(anchors) == 0


def test_anchor_set_threshold_respected() -> None:
    """Cell with confidence below threshold contributes no anchors."""
    conf = np.zeros((9, 9), dtype=np.float64)
    conf[2, 3] = 0.4  # below default threshold of 0.5
    anchors = _anchor_set(conf, threshold=0.5)
    assert len(anchors) == 0
