import base64
import io
import json
import sqlite3
from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray
from PIL import Image

from killer_sudoku.training.review_low_confidence import (
    build_review_items,
    crops_from_duplicate_conflicts,
    write_candidates_file,
)


def _make_cache_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "corpus.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE cell_reads ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, puzzle_hash TEXT NOT NULL, git_hash TEXT NOT NULL, "
        "cell_type TEXT NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL, "
        "digit_index INTEGER NOT NULL DEFAULT 0, predicted_label INTEGER NOT NULL, "
        "confident INTEGER NOT NULL, clashes_with TEXT NOT NULL, "
        "source_x INTEGER, source_y INTEGER, source_width INTEGER, source_height INTEGER, "
        "source_pixels BLOB, recognition_pixels BLOB NOT NULL, "
        "hog_features TEXT NOT NULL, hole_features TEXT NOT NULL)"
    )
    conn.commit()
    conn.close()
    return db_path


def _insert_cell_read(
    db_path: Path,
    *,
    puzzle_hash: str,
    git_hash: str,
    row: int,
    col: int,
    predicted_label: int,
    clashes_with: list[dict[str, int]],
    crop: NDArray[np.uint8],
    source_x: int = 11,
    source_y: int = 13,
) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO cell_reads (puzzle_hash, git_hash, cell_type, row, col, digit_index, "
        "predicted_label, confident, clashes_with, source_x, source_y, source_width, "
        "source_height, source_pixels, recognition_pixels, hog_features, hole_features) "
        "VALUES (?, ?, 'given_digit', ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, '[]', '[]')",
        (
            puzzle_hash,
            git_hash,
            row,
            col,
            predicted_label,
            json.dumps(clashes_with),
            source_x,
            source_y,
            crop.shape[1],
            crop.shape[0],
            crop.tobytes(),
            bytes(64 * 64),
        ),
    )
    conn.commit()
    conn.close()


def test_duplicate_review_preserves_raw_3_by_7_crop_and_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "killer_sudoku.training.review_low_confidence.resolve_corpus_name",
        lambda _src: "guardian",
    )
    db_path = _make_cache_db(tmp_path)
    src = tmp_path / "puzzle.jpg"
    src.write_bytes(b"")
    crop = np.arange(21, dtype=np.uint8).reshape(3, 7)
    _insert_cell_read(
        db_path,
        puzzle_hash="p1",
        git_hash="h1",
        row=0,
        col=0,
        predicted_label=6,
        clashes_with=[{"row": 1, "col": 0}],
        crop=crop,
    )

    pairs = crops_from_duplicate_conflicts([("guardian", "p1", src)], "h1", db_path)
    items = build_review_items(pairs, count=10)

    assert len(items) == 1
    item = items[0]
    assert item.source_rect == (11, 13, 7, 3)
    assert np.array_equal(item.crop, crop)
    assert item.conflict_descs == ("clashes with r2c1",)

    candidates_path = tmp_path / "candidates.json"
    write_candidates_file(items, candidates_path)
    candidate = json.loads(candidates_path.read_text(encoding="utf-8"))[item.id]
    assert candidate["sourceRect"] == {"x": 11, "y": 13, "width": 7, "height": 3}
    assert candidate["sourceWidth"] == 7
    assert candidate["sourceHeight"] == 3
    decoded = np.array(
        Image.open(io.BytesIO(base64.b64decode(candidate["cropPng"]))).convert("L"),
        dtype=np.uint8,
    )
    assert np.array_equal(decoded, crop)


def test_duplicate_review_excludes_non_conflicting_cells(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "killer_sudoku.training.review_low_confidence.resolve_corpus_name",
        lambda _src: "guardian",
    )
    db_path = _make_cache_db(tmp_path)
    src = tmp_path / "puzzle.jpg"
    src.write_bytes(b"")
    _insert_cell_read(
        db_path,
        puzzle_hash="p1",
        git_hash="h1",
        row=0,
        col=0,
        predicted_label=4,
        clashes_with=[],
        crop=np.zeros((3, 7), dtype=np.uint8),
    )

    assert crops_from_duplicate_conflicts([("guardian", "p1", src)], "h1", db_path) == []


def test_duplicate_review_skips_rows_without_raw_source_pixels(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "killer_sudoku.training.review_low_confidence.resolve_corpus_name",
        lambda _src: "guardian",
    )
    db_path = _make_cache_db(tmp_path)
    src = tmp_path / "puzzle.jpg"
    src.write_bytes(b"")
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO cell_reads (puzzle_hash, git_hash, cell_type, row, col, digit_index, "
        "predicted_label, confident, clashes_with, recognition_pixels, hog_features, hole_features) "
        "VALUES ('p1', 'h1', 'given_digit', 0, 0, 0, 6, 1, ?, ?, '[]', '[]')",
        (json.dumps([{"row": 1, "col": 0}]), bytes(64 * 64)),
    )
    conn.commit()
    conn.close()

    assert crops_from_duplicate_conflicts([("guardian", "p1", src)], "h1", db_path) == []
