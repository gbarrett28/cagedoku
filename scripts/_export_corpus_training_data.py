"""Export a canonical training JSON from corpus.db's cell_reads.

Schema v2, replacing browser_train.json as the --browser-file input to
train_recogniser.py.

Unlike browser_train.json (opaque, untagged, mixed warp-strategy samples
accumulated from user feedback over time), every crop here comes from a single
evaluation run (see killer_sudoku/training/digit_corrections.json's gitHash)
with a known, uniform warp_strategy and a small, explicitly reviewed set of
label corrections applied.

Private helper, not a human-facing entry point (see CLAUDE.md's Python
guidelines) -- analogous to scripts/_r2_*.py.

Usage:
    python scripts/_export_corpus_training_data.py \
        --db-path corpus.db \
        --corrections-file killer_sudoku/training/digit_corrections.json \
        --out web/corpus_train.json \
        --samples-per-digit 400
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast

import numpy as np
from numpy.typing import NDArray
from sklearn.decomposition import PCA
from sklearn.mixture import GaussianMixture

from killer_sudoku.training import ts_bridge

THUMBNAIL_SIZE = 64
N_CLUSTERS = 4
PCA_COMPONENTS = 20
SOURCE_EVALUATION_ID = "full-corpus-b708d8b"
SUPPORTED_CELL_TYPES = frozenset({"given_digit", "cage_total_digit"})

CellType = Literal["given_digit", "cage_total_digit"]


@dataclass(frozen=True)
class CorpusAudit:
    registered_puzzles: int
    terminal_evaluations: int
    distinct_puzzles: int
    digit_rows: int


@dataclass(frozen=True)
class DigitRow:
    puzzle_hash: str
    cell_type: CellType
    row: int
    col: int
    digit_index: int
    provisional_label: int
    width: int
    height: int
    gray_pixels: NDArray[np.uint8]


def audit_corpus(conn: sqlite3.Connection, evaluation_id: str) -> CorpusAudit:
    """Validate that the immutable source evaluation covers the registered corpus."""
    if evaluation_id != SOURCE_EVALUATION_ID:
        raise ValueError(
            f"Training source must be {SOURCE_EVALUATION_ID!r}, got {evaluation_id!r}"
        )

    registered = int(conn.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0])
    counts = conn.execute(
        """
        SELECT COUNT(*) AS evaluations,
               COUNT(DISTINCT puzzle_hash) AS distinct_puzzles,
               SUM(CASE WHEN status != 'done' OR finished_at IS NULL THEN 1 ELSE 0 END) AS unfinished,
               SUM(CASE WHEN grid_corners IS NULL THEN 1 ELSE 0 END) AS missing_corners
        FROM evaluations
        WHERE git_hash = ?
        """,
        (evaluation_id,),
    ).fetchone()
    terminal = int(counts["evaluations"])
    distinct = int(counts["distinct_puzzles"])
    unfinished = int(counts["unfinished"] or 0)
    missing_corners = int(counts["missing_corners"] or 0)
    duplicate_groups = int(
        conn.execute(
            """
            SELECT COUNT(*) FROM (
                SELECT puzzle_hash FROM evaluations
                WHERE git_hash = ? GROUP BY puzzle_hash HAVING COUNT(*) > 1
            )
            """,
            (evaluation_id,),
        ).fetchone()[0]
    )

    if unfinished:
        raise ValueError(f"Source evaluation has {unfinished} unfinished evaluation(s)")
    if duplicate_groups:
        raise ValueError(f"Source evaluation has {duplicate_groups} duplicate puzzle evaluation(s)")
    if terminal != registered or distinct != registered:
        raise ValueError(
            "Source evaluation coverage mismatch: "
            f"{terminal} evaluations for {distinct} distinct puzzles; {registered} registered"
        )
    if missing_corners:
        raise ValueError(f"Source evaluation has {missing_corners} missing grid corner record(s)")

    digit_rows = int(
        conn.execute(
            "SELECT COUNT(*) FROM cell_reads WHERE git_hash = ?",
            (evaluation_id,),
        ).fetchone()[0]
    )
    return CorpusAudit(registered, terminal, distinct, digit_rows)


def _decode_pixel_array(value: object, *, field: str, expected: int) -> NDArray[np.uint8]:
    if value is None:
        raise ValueError(f"missing {field}")
    decoded = json.loads(str(value))
    if not isinstance(decoded, list) or len(decoded) != expected:
        actual = len(decoded) if isinstance(decoded, list) else "non-array"
        raise ValueError(f"{field} length {actual} does not match {expected}")
    if any(not isinstance(pixel, int) or isinstance(pixel, bool) or not 0 <= pixel <= 255 for pixel in decoded):
        raise ValueError(f"{field} contains a value outside uint8")
    return np.asarray(decoded, dtype=np.uint8)


def fetch_eligible_rows(conn: sqlite3.Connection, evaluation_id: str) -> list[DigitRow]:
    """Load provisional labels only from clean, error-free puzzles in one run."""
    if evaluation_id != SOURCE_EVALUATION_ID:
        raise ValueError(
            f"Training source must be {SOURCE_EVALUATION_ID!r}, got {evaluation_id!r}"
        )
    rows = conn.execute(
        """
        SELECT cr.puzzle_hash, cr.cell_type, cr.row, cr.col, cr.digit_index,
               cr.predicted_label, cr.source_x, cr.source_y,
               cr.source_width, cr.source_height, cr.source_pixels, cr.gray_pixels
        FROM cell_reads cr
        JOIN evaluations e
          ON e.puzzle_hash = cr.puzzle_hash AND e.git_hash = cr.git_hash
        WHERE cr.git_hash = ? AND e.status = 'done' AND e.bucket = 'clean'
          AND e.spec_error IS NULL
        ORDER BY cr.puzzle_hash, cr.cell_type, cr.row, cr.col, cr.digit_index
        """,
        (evaluation_id,),
    ).fetchall()

    result: list[DigitRow] = []
    for db_row in rows:
        cell_type = str(db_row["cell_type"])
        if cell_type not in SUPPORTED_CELL_TYPES:
            raise ValueError(f"unsupported cell type: {cell_type}")
        label = int(db_row["predicted_label"])
        if not 0 <= label <= 9:
            raise ValueError(f"invalid label: {label}")
        coordinates = (db_row["source_x"], db_row["source_y"])
        if any(value is None or int(value) < 0 for value in coordinates):
            raise ValueError("missing or invalid source coordinates")
        width = int(db_row["source_width"] or 0)
        height = int(db_row["source_height"] or 0)
        if width <= 0 or height <= 0:
            raise ValueError(f"invalid source dimensions: {width}x{height}")
        expected = width * height
        _decode_pixel_array(db_row["source_pixels"], field="source pixel", expected=expected)
        gray = _decode_pixel_array(
            db_row["gray_pixels"], field="greyscale pixel", expected=expected
        ).reshape(height, width)
        result.append(
            DigitRow(
                puzzle_hash=str(db_row["puzzle_hash"]),
                cell_type=cast("CellType", cell_type),
                row=int(db_row["row"]),
                col=int(db_row["col"]),
                digit_index=int(db_row["digit_index"]),
                provisional_label=label,
                width=width,
                height=height,
                gray_pixels=gray,
            )
        )
    return result


def load_corrections(path: Path) -> tuple[str, dict[tuple[str, str, int, int, int], int], set[tuple[str, str, int, int, int]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    git_hash = str(data["gitHash"])
    corrections: dict[tuple[str, str, int, int, int], int] = {}
    for c in data["corrections"]:
        key = (c["puzzleHash"], c["cellType"], c["row"], c["col"], c["digitIndex"])
        corrections[key] = int(c["toLabel"])
    excluded: set[tuple[str, str, int, int, int]] = {
        (g["puzzleHash"], g["cellType"], g["row"], g["col"], g["digitIndex"])
        for g in data["excludeGarbled"]
    }
    return git_hash, corrections, excluded


def fetch_digit_rows(
    conn: sqlite3.Connection, git_hash: str, digit: int,
) -> list[sqlite3.Row]:
    cur = conn.execute(
        """
        SELECT cr.puzzle_hash, cr.cell_type, cr.row, cr.col, cr.digit_index,
               cr.source_pixels, cr.source_width, cr.source_height
        FROM cell_reads cr
        JOIN evaluations e
          ON e.puzzle_hash = cr.puzzle_hash AND e.git_hash = cr.git_hash
        WHERE cr.git_hash = ? AND cr.predicted_label = ?
          AND e.status = 'done' AND e.bucket = 'clean' AND e.spec_error IS NULL
          AND cr.cell_type IN ('given_digit', 'cage_total_digit')
          AND cr.source_pixels IS NOT NULL
        """,
        (git_hash, digit),
    )
    return cur.fetchall()


def warp_rows(rows: list[sqlite3.Row]) -> NDArray[np.uint8]:
    """Warp raw source_pixels through the centered strategy via the TS bridge."""
    crops = [
        ts_bridge.RawDigitCrop(
            pixels=np.array(json.loads(r["source_pixels"]), dtype=np.uint8).reshape(
                r["source_height"], r["source_width"],
            )
        )
        for r in rows
    ]
    return ts_bridge.warp_crops(crops, strategy="letterbox-centered", size=THUMBNAIL_SIZE)


def cluster_ids_for(warped: NDArray[np.uint8]) -> NDArray[np.int64]:
    hog, hole, aspect = ts_bridge.extract_features(list(warped))
    features = np.hstack([hog, hole, aspect.reshape(-1, 1)])
    reduced = PCA(n_components=min(PCA_COMPONENTS, features.shape[1]), random_state=0).fit_transform(features)
    gmm = GaussianMixture(n_components=N_CLUSTERS, random_state=0, n_init=5)
    result: NDArray[np.int64] = gmm.fit_predict(reduced)
    return result


def stratified_sample(
    strata: dict[tuple[int, int], list[dict[str, Any]]], n_per_digit: int, rng: np.random.Generator,
) -> list[dict[str, Any]]:
    stratum_keys = list(strata.keys())
    k = len(stratum_keys)
    if k == 0:
        return []
    target = n_per_digit // k
    remainder = n_per_digit - target * k
    picked: list[dict[str, Any]] = []
    shortfall = 0
    for i, sk in enumerate(stratum_keys):
        members = strata[sk]
        want = target + (1 if i < remainder else 0)
        take = min(want, len(members))
        shortfall += want - take
        idx = rng.choice(len(members), size=take, replace=False)
        picked.extend(members[j] for j in idx)
    if shortfall > 0:
        picked_ids = {id(e) for e in picked}
        spare_pool = [m for sk in stratum_keys for m in strata[sk] if id(m) not in picked_ids]
        take = min(shortfall, len(spare_pool))
        idx = rng.choice(len(spare_pool), size=take, replace=False)
        picked.extend(spare_pool[j] for j in idx)
    return picked


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-path", type=Path, default=Path("corpus.db"))
    parser.add_argument(
        "--corrections-file", type=Path,
        default=Path("killer_sudoku/training/digit_corrections.json"),
    )
    parser.add_argument("--out", type=Path, default=Path("web/corpus_train.json"))
    parser.add_argument("--samples-per-digit", type=int, default=400)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    git_hash, corrections, excluded = load_corrections(args.corrections_file)
    print(f"Loaded {len(corrections)} corrections, {len(excluded)} exclusions for git_hash={git_hash}")

    conn = sqlite3.connect(f"file:{args.db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    audit = audit_corpus(conn, git_hash)
    eligible_rows = fetch_eligible_rows(conn, git_hash)
    print(
        f"Audited {audit.terminal_evaluations}/{audit.registered_puzzles} evaluations; "
        f"{len(eligible_rows)} clean digit rows are eligible"
    )

    strata_by_digit: dict[int, dict[tuple[int, int], list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))

    for raw_digit in range(0, 10):
        rows = fetch_digit_rows(conn, git_hash, raw_digit)
        if not rows:
            continue
        warped = warp_rows(rows)
        cluster_ids = cluster_ids_for(warped)
        n_corrected = 0
        n_excluded = 0
        for row, img, cid in zip(rows, warped, cluster_ids, strict=True):
            key = (row["puzzle_hash"], row["cell_type"], row["row"], row["col"], row["digit_index"])
            if key in excluded:
                n_excluded += 1
                continue
            corrected_label = corrections.get(key, raw_digit)
            if corrected_label != raw_digit:
                n_corrected += 1
            strata_by_digit[corrected_label][(raw_digit, int(cid))].append({
                "recognition_pixels": img.flatten().tolist(),
            })
        print(f"raw_digit {raw_digit}: {len(rows)} rows, {n_corrected} corrected, {n_excluded} excluded")

    rng = np.random.default_rng(args.seed)
    samples: list[dict[str, Any]] = []
    for digit in range(0, 10):
        strata = strata_by_digit.get(digit, {})
        picked = stratified_sample(strata, args.samples_per_digit, rng)
        print(f"digit {digit}: {len(strata)} strata -> sampled {len(picked)}")
        for p in picked:
            samples.append({
                "digit": digit,
                "recognitionPixels": p["recognition_pixels"],
                "warpStrategy": "letterbox-centered",
            })

    conn.close()

    export = {
        "schemaVersion": 2,
        "reportType": "training-export",
        "exportedAt": datetime.now(UTC).isoformat(),
        "appVersion": f"corpus-db-export:{git_hash}",
        "puzzleType": "mixed",
        "subres": THUMBNAIL_SIZE,
        "thumbnailSize": THUMBNAIL_SIZE,
        "sampleCount": len(samples),
        "samples": samples,
    }
    args.out.write_text(json.dumps(export))
    print(f"\nWrote {len(samples)} samples to {args.out}")


if __name__ == "__main__":
    main()
