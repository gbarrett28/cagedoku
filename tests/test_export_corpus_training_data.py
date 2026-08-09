from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray
from PIL import Image

from killer_sudoku.training import ts_bridge
from scripts import _export_corpus_training_data as export


def _make_db(tmp_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(tmp_path / "corpus.db")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE puzzles (
            content_hash TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            corpus TEXT NOT NULL,
            ground_truth TEXT NOT NULL
        );
        CREATE TABLE evaluations (
            id INTEGER PRIMARY KEY,
            puzzle_hash TEXT NOT NULL,
            git_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            bucket TEXT,
            spec_error TEXT,
            grid_corners TEXT,
            finished_at TEXT
        );
        CREATE TABLE cell_reads (
            puzzle_hash TEXT NOT NULL,
            git_hash TEXT NOT NULL,
            cell_type TEXT NOT NULL,
            row INTEGER NOT NULL,
            col INTEGER NOT NULL,
            digit_index INTEGER NOT NULL,
            predicted_label INTEGER NOT NULL,
            source_x INTEGER,
            source_y INTEGER,
            source_width INTEGER,
            source_height INTEGER,
            source_pixels TEXT,
            gray_pixels TEXT
        );
        """
    )
    return conn


def _add_puzzle(
    conn: sqlite3.Connection,
    puzzle_hash: str,
    *,
    evaluation_id: str = export.SOURCE_EVALUATION_ID,
    status: str = "done",
    bucket: str = "clean",
    spec_error: str | None = None,
    grid_corners: str | None = "[0,0,9,0,9,9,0,9]",
) -> None:
    conn.execute(
        "INSERT INTO puzzles VALUES (?, ?, ?, ?)",
        (puzzle_hash, f"{puzzle_hash}.jpg", "guardian", "[]"),
    )
    conn.execute(
        "INSERT INTO evaluations "
        "(puzzle_hash, git_hash, status, bucket, spec_error, grid_corners, finished_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            puzzle_hash,
            evaluation_id,
            status,
            bucket,
            spec_error,
            grid_corners,
            "2026-08-09 10:00:00" if status == "done" else None,
        ),
    )


def _add_digit(
    conn: sqlite3.Connection,
    puzzle_hash: str,
    *,
    evaluation_id: str = export.SOURCE_EVALUATION_ID,
    cell_type: str = "given_digit",
    label: int = 7,
    pixels: list[int] | None = None,
) -> None:
    gray = [10, 20, 30, 40] if pixels is None else pixels
    conn.execute(
        "INSERT INTO cell_reads VALUES (?, ?, ?, 1, 2, 0, ?, 11, 13, 2, 2, ?, ?)",
        (
            puzzle_hash,
            evaluation_id,
            cell_type,
            label,
            json.dumps([0, 255, 255, 0]),
            json.dumps(gray),
        ),
    )


def test_warp_rows_uses_greyscale_pixels_and_gray_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    row = export.DigitRow(
        puzzle_hash="p1",
        cell_type="given_digit",
        row=1,
        col=2,
        digit_index=0,
        provisional_label=7,
        width=2,
        height=2,
        gray_pixels=np.asarray([[10, 20], [30, 40]], dtype=np.uint8),
    )

    def fake_warp(
        crops: list[ts_bridge.RawDigitCrop],
        strategy: str,
        size: int,
        input_mode: str,
    ) -> NDArray[np.uint8]:
        assert crops[0].pixels.tolist() == [[10, 20], [30, 40]]
        assert strategy == "letterbox-centered"
        assert size == 64
        assert input_mode == "gray"
        return np.zeros((1, 64, 64), dtype=np.uint8)

    monkeypatch.setattr(ts_bridge, "warp_crops", fake_warp)

    assert export.warp_rows([row]).shape == (1, 64, 64)


def test_write_cluster_means_creates_labelled_ten_by_four_sheet(tmp_path: Path) -> None:
    means = {
        (digit, cluster): np.full((64, 64), digit * 20 + cluster, dtype=np.uint8)
        for digit in range(10)
        for cluster in range(4)
    }
    out = tmp_path / "means.png"

    export.write_cluster_means(means, out)

    with Image.open(out) as sheet:
        assert sheet.size == (24 + 4 * 64, 24 + 10 * 64)



def test_corrections_apply_only_to_the_evaluation_that_was_reviewed() -> None:
    corrections = {("p1", "given_digit", 1, 2, 0): 7}
    excluded = {("p2", "given_digit", 2, 3, 0)}

    assert export.corrections_for_evaluation(
        "older-run",
        export.SOURCE_EVALUATION_ID,
        corrections,
        excluded,
    ) == ({}, set())
    assert export.corrections_for_evaluation(
        export.SOURCE_EVALUATION_ID,
        export.SOURCE_EVALUATION_ID,
        corrections,
        excluded,
    ) == (corrections, excluded)


def test_audit_requires_exact_source_identity(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1", evaluation_id="older-run")

    with pytest.raises(ValueError, match=export.SOURCE_EVALUATION_ID):
        export.audit_corpus(conn, "older-run")


def test_audit_rejects_unfinished_evaluation(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1", status="running")

    with pytest.raises(ValueError, match="1 unfinished"):
        export.audit_corpus(conn, export.SOURCE_EVALUATION_ID)


def test_audit_accepts_one_complete_evaluation_per_puzzle(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1")
    _add_puzzle(conn, "p2")
    _add_digit(conn, "p1")
    _add_digit(conn, "p2", cell_type="cage_total_digit", label=3)

    audit = export.audit_corpus(conn, export.SOURCE_EVALUATION_ID)

    assert audit == export.CorpusAudit(
        registered_puzzles=2,
        terminal_evaluations=2,
        distinct_puzzles=2,
        digit_rows=2,
    )


def test_audit_rejects_duplicate_or_missing_puzzle_evaluations(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1")
    conn.execute(
        "INSERT INTO evaluations "
        "(puzzle_hash, git_hash, status, bucket, spec_error, grid_corners, finished_at) "
        "VALUES (?, ?, 'done', 'clean', NULL, '[0,0,9,0,9,9,0,9]', '2026-08-09')",
        ("p1", export.SOURCE_EVALUATION_ID),
    )

    with pytest.raises(ValueError, match="duplicate"):
        export.audit_corpus(conn, export.SOURCE_EVALUATION_ID)


def test_audit_rejects_equal_count_but_different_puzzle_membership(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1")
    _add_puzzle(conn, "p2")
    conn.execute(
        "DELETE FROM evaluations WHERE puzzle_hash = 'p2'"
    )
    conn.execute(
        "INSERT INTO evaluations "
        "(puzzle_hash, git_hash, status, bucket, spec_error, grid_corners, finished_at) "
        "VALUES ('p3', ?, 'done', 'clean', NULL, '[0,0,9,0,9,9,0,9]', '2026-08-09')",
        (export.SOURCE_EVALUATION_ID,),
    )

    with pytest.raises(ValueError, match="1 missing and 1 unexpected"):
        export.audit_corpus(conn, export.SOURCE_EVALUATION_ID)


def test_audit_rejects_missing_grid_corners(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1", grid_corners=None)

    with pytest.raises(ValueError, match="missing grid corner"):
        export.audit_corpus(conn, export.SOURCE_EVALUATION_ID)


def test_audit_rejects_malformed_eligible_greyscale_evidence(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1")
    _add_digit(conn, "p1", pixels=[10, 20, 30])

    with pytest.raises(ValueError, match="greyscale pixel length"):
        export.audit_corpus(conn, export.SOURCE_EVALUATION_ID)


def test_audit_rejects_malformed_nonclean_greyscale_evidence(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1", bucket="backtracked")
    _add_digit(conn, "p1", pixels=[10, 20, 30])

    with pytest.raises(ValueError, match="greyscale pixel length"):
        export.audit_corpus(conn, export.SOURCE_EVALUATION_ID)


def test_fetch_eligible_rows_uses_only_clean_error_free_puzzles(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "clean")
    _add_digit(conn, "clean")
    _add_puzzle(conn, "backtracked", bucket="backtracked")
    _add_digit(conn, "backtracked", label=4)
    _add_puzzle(conn, "not-solved", bucket="notSolved")
    _add_digit(conn, "not-solved", label=6)
    _add_puzzle(conn, "repaired", spec_error="repaired total")
    _add_digit(conn, "repaired", label=5)
    _add_puzzle(conn, "older", evaluation_id="older-run")
    _add_digit(conn, "older", evaluation_id="older-run", label=2)

    rows = export.fetch_eligible_rows(conn, export.SOURCE_EVALUATION_ID)

    assert len(rows) == 1
    row = rows[0]
    assert row.puzzle_hash == "clean"
    assert row.cell_type == "given_digit"
    assert row.provisional_label == 7
    assert row.gray_pixels.tolist() == [[10, 20], [30, 40]]


def test_fetch_eligible_rows_rejects_fractional_sqlite_integer_fields(tmp_path: Path) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1")
    _add_digit(conn, "p1")
    conn.execute("UPDATE cell_reads SET predicted_label = 7.9")

    with pytest.raises(ValueError, match="predicted_label must be an integer"):
        export.fetch_eligible_rows(conn, export.SOURCE_EVALUATION_ID)


@pytest.mark.parametrize(
    ("cell_type", "label", "pixels", "message"),
    [
        ("annotation", 7, [10, 20, 30, 40], "unsupported cell type"),
        ("given_digit", 10, [10, 20, 30, 40], "invalid label"),
        ("given_digit", 7, [10, 20, 30], "greyscale pixel length"),
    ],
)
def test_fetch_eligible_rows_rejects_malformed_evidence(
    tmp_path: Path,
    cell_type: str,
    label: int,
    pixels: list[int],
    message: str,
) -> None:
    conn = _make_db(tmp_path)
    _add_puzzle(conn, "p1")
    _add_digit(conn, "p1", cell_type=cell_type, label=label, pixels=pixels)

    with pytest.raises(ValueError, match=message):
        export.fetch_eligible_rows(conn, export.SOURCE_EVALUATION_ID)
