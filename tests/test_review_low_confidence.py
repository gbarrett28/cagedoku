import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import numpy.typing as npt
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from train_recogniser import HogRecogniser

from killer_sudoku.training.review_low_confidence import (
    crops_from_duplicate_conflicts,
    crops_from_flagged_puzzles,
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

_TEST_WIN_SIZE = 64


def _make_cache_db(tmp_path: Path) -> Path:
    """Minimal corpus.db fixture with just the tables review_low_confidence reads."""
    db_path = tmp_path / "corpus.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE puzzles (content_hash TEXT PRIMARY KEY, path TEXT NOT NULL, "
        "corpus TEXT NOT NULL DEFAULT '', ground_truth TEXT NOT NULL DEFAULT '[]')"
    )
    conn.execute(
        "CREATE TABLE cell_reads ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, puzzle_hash TEXT NOT NULL, git_hash TEXT NOT NULL, "
        "cell_type TEXT NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL, "
        "digit_index INTEGER NOT NULL DEFAULT 0, predicted_label INTEGER NOT NULL, "
        "confident INTEGER NOT NULL, clashes_with TEXT NOT NULL, crop_pixels TEXT NOT NULL, "
        "hog_features TEXT NOT NULL, hole_features TEXT NOT NULL)"
    )
    conn.commit()
    conn.close()
    return db_path


def _insert_cell_read(
    db_path: Path, *, puzzle_hash: str, git_hash: str, cell_type: str,
    row: int, col: int, predicted_label: int, clashes_with: list[dict[str, int]],
) -> None:
    crop = np.zeros((_TEST_WIN_SIZE, _TEST_WIN_SIZE), dtype=np.uint8).flatten().tolist()
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO cell_reads (puzzle_hash, git_hash, cell_type, row, col, digit_index, "
        "predicted_label, confident, clashes_with, crop_pixels, hog_features, hole_features) "
        "VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, '[]', '[]')",
        (puzzle_hash, git_hash, cell_type, row, col, predicted_label,
         json.dumps(clashes_with), json.dumps(crop)),
    )
    conn.commit()
    conn.close()


def test_crops_from_flagged_puzzles_reads_from_cell_reads_cache(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(
        "killer_sudoku.training.review_low_confidence.resolve_corpus_name",
        lambda _src: "guardian",
    )
    db_path = _make_cache_db(tmp_path)
    src = tmp_path / "puzzle.jpg"
    src.write_bytes(b"")
    _insert_cell_read(
        db_path, puzzle_hash="p1", git_hash="h1", cell_type="given_digit",
        row=0, col=0, predicted_label=5, clashes_with=[],
    )

    candidates = crops_from_flagged_puzzles([("guardian", "p1", src)], "h1", db_path)

    assert len(candidates) == 1
    assert (candidates[0].row, candidates[0].col) == (0, 0)
    assert candidates[0].current_label == 5
    assert candidates[0].crop.shape == (_TEST_WIN_SIZE, _TEST_WIN_SIZE)


def test_crops_from_flagged_puzzles_skips_a_puzzle_with_no_rows_for_this_git_hash(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(
        "killer_sudoku.training.review_low_confidence.resolve_corpus_name",
        lambda _src: "guardian",
    )
    db_path = _make_cache_db(tmp_path)
    src = tmp_path / "puzzle.jpg"
    src.write_bytes(b"")
    _insert_cell_read(
        db_path, puzzle_hash="p1", git_hash="stale-hash", cell_type="given_digit",
        row=0, col=0, predicted_label=5, clashes_with=[],
    )

    assert crops_from_flagged_puzzles([("guardian", "p1", src)], "current-hash", db_path) == []


def test_crops_from_duplicate_conflicts_only_returns_cells_with_clashes(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(
        "killer_sudoku.training.review_low_confidence.resolve_corpus_name",
        lambda _src: "guardian",
    )
    db_path = _make_cache_db(tmp_path)
    src = tmp_path / "puzzle.jpg"
    src.write_bytes(b"")
    _insert_cell_read(
        db_path, puzzle_hash="p1", git_hash="h1", cell_type="given_digit",
        row=0, col=0, predicted_label=6, clashes_with=[{"row": 1, "col": 0}],
    )
    _insert_cell_read(
        db_path, puzzle_hash="p1", git_hash="h1", cell_type="given_digit",
        row=1, col=0, predicted_label=6, clashes_with=[{"row": 0, "col": 0}],
    )
    _insert_cell_read(
        db_path, puzzle_hash="p1", git_hash="h1", cell_type="given_digit",
        row=0, col=1, predicted_label=4, clashes_with=[],
    )

    pairs = crops_from_duplicate_conflicts([("guardian", "p1", src)], "h1", db_path)

    assert len(pairs) == 2
    cells = {(c.row, c.col) for c, _descs in pairs}
    assert cells == {(0, 0), (1, 0)}
    descs_by_cell = {(c.row, c.col): descs for c, descs in pairs}
    assert descs_by_cell[(0, 0)] == ["clashes with r2c1"]
    assert descs_by_cell[(1, 0)] == ["clashes with r1c1"]
