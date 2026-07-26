import sys
from pathlib import Path

import numpy as np
import numpy.typing as npt
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from train_recogniser import HogRecogniser

from killer_sudoku.training.review_low_confidence import (
    find_duplicate_cells,
    least_confident,
    ovo_predictions,
    score_candidates,
)
from killer_sudoku.training.train_combinations import train_and_evaluate


def test_ovo_predictions_reconstructs_votes_and_confidence() -> None:
    # 3 classes -> pairs in order (0,1), (0,2), (1,2). Positive -> first class wins.
    classes = np.array([0, 1, 2], dtype=np.int32)
    scores = np.array(
        [
            [1.0, 3.0, -1.0],   # class0 wins both its pairs -> votes [2, 0, 1]; margin vs class2 (pair 1,2) is 1.0
            [-1.0, 1.0, -1.0],  # 3-way tie [1, 1, 1] -> first-index tie-break
        ]
    )

    best, second, confidence, margin = ovo_predictions(scores, classes)

    assert best.tolist() == [0, 0]
    assert second.tolist() == [2, 1]
    assert confidence.tolist() == [1.0, 0.5]
    # Sample 0: best=class0, second=class2 -> pair (0,2) column value is 3.0.
    # Sample 1: best=class0, second=class1 -> pair (0,1) column value is -1.0, abs -> 1.0.
    assert margin.tolist() == [3.0, 1.0]


def test_ovo_predictions_margin_breaks_ties_among_equal_confidence() -> None:
    # Both samples get a unanimous 2/2 vote for class0 (confidence 1.0), but
    # by very different margins in the class0-vs-class2 pairing -- this is
    # exactly the case integer vote confidence can't distinguish and margin
    # exists to separate. (pair (1,2) = -1.0 in both rows -> class2 beats
    # class1, so class2 -- not class1 -- is the runner-up in both.)
    classes = np.array([0, 1, 2], dtype=np.int32)
    scores = np.array(
        [
            [0.01, 0.01, -1.0],  # razor-thin win over class2
            [5.0, 5.0, -1.0],    # landslide win over class2
        ]
    )

    _best, second, confidence, margin = ovo_predictions(scores, classes)

    assert confidence.tolist() == [1.0, 1.0]
    assert second.tolist() == [2, 2]
    assert margin[0] < margin[1]


def test_find_duplicate_cells_empty_for_a_conflict_free_grid() -> None:
    grid = np.zeros((9, 9), dtype=np.int64)
    grid[0, 0] = 5
    grid[4, 4] = 5  # different row, col, and box -- no conflict
    assert find_duplicate_cells(grid) == {}


def test_find_duplicate_cells_flags_a_row_conflict() -> None:
    grid = np.zeros((9, 9), dtype=np.int64)
    grid[0, 0] = 5
    grid[0, 3] = 5
    conflicts = find_duplicate_cells(grid)
    assert set(conflicts.keys()) == {(0, 0), (0, 3)}
    assert conflicts[(0, 0)] == ["row 1 digit 5"]
    assert conflicts[(0, 3)] == ["row 1 digit 5"]


def test_find_duplicate_cells_flags_a_column_conflict() -> None:
    grid = np.zeros((9, 9), dtype=np.int64)
    grid[0, 0] = 5
    grid[3, 0] = 5
    conflicts = find_duplicate_cells(grid)
    assert set(conflicts.keys()) == {(0, 0), (3, 0)}
    assert conflicts[(0, 0)] == ["col 1 digit 5"]


def test_find_duplicate_cells_flags_a_box_conflict() -> None:
    grid = np.zeros((9, 9), dtype=np.int64)
    grid[0, 0] = 5
    grid[1, 1] = 5  # same 3x3 box, different row and column
    conflicts = find_duplicate_cells(grid)
    assert set(conflicts.keys()) == {(0, 0), (1, 1)}
    assert conflicts[(0, 0)] == ["box (1,1) digit 5"]


def test_find_duplicate_cells_ignores_blank_cells() -> None:
    # Every cell is 0 (blank) -- 0 must never be treated as a shared digit.
    grid = np.zeros((9, 9), dtype=np.int64)
    assert find_duplicate_cells(grid) == {}


def _make_crop(digit: int) -> npt.NDArray[np.uint8]:
    img = Image.new("L", (40, 60), 0)
    draw = ImageDraw.Draw(img)
    draw.text((5, 5), str(digit), fill=255)
    return np.array(img, dtype=np.uint8)


def test_score_candidates_matches_svc_predictions_and_ranks_ascending() -> None:
    train = [(d, _make_crop(d)) for d in range(10) for _ in range(3)]
    holdout = [(d, _make_crop(d)) for d in range(10)]
    _results, fitted_models = train_and_evaluate(train, holdout, cross_font=[])
    recogniser, model = fitted_models["hog_letterbox"]
    assert isinstance(recogniser, HogRecogniser)

    candidates = [(f"id-{d}", d, crop) for d, crop in holdout]
    scored = score_candidates(candidates, recogniser, model)

    assert len(scored) == len(candidates)
    for item in scored:
        assert 0.0 <= item.confidence <= 1.0
        assert item.id.startswith("id-")

    selected = least_confident(scored, count=3)
    assert len(selected) == 3
    keys = [(c.confidence, c.margin) for c in selected]
    assert keys == sorted(keys)
