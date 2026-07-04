# Corpus Database Reference

`corpus.db` is a SQLite database (WAL mode) that records every evaluation run
against the puzzle corpus. It lives at the repo root (gitignored).

Open it with any SQLite tool:
```bash
sqlite3 corpus.db
# or via Node:
node -e "const D=require('better-sqlite3'); const db=D('corpus.db'); console.log(db.prepare('SELECT COUNT(*) FROM evaluations').get());"
```

---

## Tables

### `puzzles`

One row per unique puzzle image, keyed by SHA-256 of the file contents.

| Column | Type | Meaning |
|--------|------|---------|
| `content_hash` | TEXT PK | SHA-256 of the image file (hex) |
| `path` | TEXT | Absolute path on the machine that ran `populate-corpus` |
| `corpus` | TEXT | Source directory label, e.g. `guardian`, `observer` |
| `ground_truth` | TEXT | Sorted JSON `string[]` of known labels: `[]` = unlabelled, `["killer"]`, `["classic"]`, or `["classic","killer"]` = ambiguous |

### `corpora`

One row per scanned source directory.

| Column | Type | Meaning |
|--------|------|---------|
| `dir_path` | TEXT PK | Absolute path to the directory |
| `ground_truth` | TEXT | `'killer'` or `'classic'` |
| `file_count` | INTEGER | Number of image files found at last scan |
| `last_scanned` | TEXT | ISO datetime of last `populate-corpus` run |

### `evaluations`

One row per (puzzle × git-hash) run. An evaluation is created with
`status='running'` when a worker claims a puzzle, then updated to
`status='done'` or `status='failed'` on completion.

#### Identity and result

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Auto-increment |
| `puzzle_hash` | TEXT | FK → `puzzles.content_hash` |
| `git_hash` | TEXT | Label passed as `--git-hash`; not necessarily a real git SHA |
| `status` | TEXT | `running` / `done` / `failed` |
| `worker_id` | INTEGER | Evaluator worker index (1-based) |
| `started_at` | TEXT | ISO datetime when the row was created |
| `finished_at` | TEXT | ISO datetime when the row was updated (NULL if still running) |

#### Outcome classification

| Column | Type | Meaning |
|--------|------|---------|
| `bucket` | TEXT | `clean` — puzzle solved without backtracking; `backtracked` — solved using the backtracker; `notSolved` — solver could not complete; `timeout` — exceeded 30 s; `error` — evaluator-level failure |
| `reason` | TEXT | Sub-classification string. Common values: `auto_confirmed`, `classic review`, `ocr warning`, `layout errors`, `sum warning`, `solver incomplete`, `GridNotFoundError: …`, `error: …` |
| `detected_type` | TEXT | Puzzle type detected by the pipeline: `killer`, `classic`, or NULL on hard failure |
| `spec_hash` | TEXT | SHA-256 of the normalised `PuzzleSpec` (cage layout + totals); NULL if no spec was produced. Identical values across two runs mean identical OCR output |
| `spec_error` | TEXT | Non-null when cage totals needed repair or a layout warning was issued (even if `bucket='clean'`). Indicates the OCR read was imperfect |
| `detected_big_apple` | INTEGER | `1` if the Big Apple source was detected, `0` otherwise |

#### Timing

| Column | Type | Meaning |
|--------|------|---------|
| `elapsed_ms` | INTEGER | Total wall-clock time from file-input to `__reportOutcome` (evaluator-measured) |
| `parse_elapsed_ms` | INTEGER | Time inside `uploadPuzzleImage` — OCR only (browser-measured) |
| `solve_elapsed_ms` | INTEGER | Time from end of parse to `__reportOutcome` — solve + coaching (browser-measured) |

#### WASM heap monitors

Set by `installCvMonitors()` in `store.ts`. NULL before that initialises.

| Column | Type | Meaning |
|--------|------|---------|
| `live_mats` | INTEGER | Count of `cv.Mat` / `cv.MatVector` objects not yet `.delete()`d at outcome time. Non-zero indicates a WASM heap leak |
| `heap_bytes` | INTEGER | `cv.HEAPU8.byteLength` at outcome time — total WASM heap size |
| `alloc_bytes` | INTEGER | Bytes currently allocated inside the WASM heap (`dlmalloc`); `-1` if unavailable |

#### Calibration

| Column | Type | Meaning |
|--------|------|---------|
| `fallback_used` | INTEGER | `1` if border-calibration fell back to the rough adaptive-threshold path; `0` for the normal path; NULL for classic puzzles |

#### Contour-tree parallel path (Sprints 1–4)

These columns hold signals from the experimental contour-tree pipeline, compared
against the existing pipeline. All are NULL for classic puzzles except
`ct_d1_count`, `ct_d2_count`, and `ct_type`.

| Column | Type | Meaning |
|--------|------|---------|
| `ct_d1_count` | INTEGER | Depth-1 contour count — one per grid cell interior; ~81 for a clean grid |
| `ct_d2_count` | INTEGER | Depth-2 contour count — digit/cage fragments; >55 heuristic → killer |
| `ct_type` | TEXT | Type signal from contour tree: `killer` or `classic` |
| `ct_orientation` | REAL | Cage-label orientation in degrees from contour quadrant vote: 0, 90, 180, or 270 (killer only) |
| `quad_sum_orientation` | REAL | Orientation from existing quadrant-sum method, same scale (killer only) |
| `ct_border_agreement` | REAL | Fraction of 144 wall slots (9×8 + 8×9) where CT agrees with existing pipeline (0–1; killer only) |
| `ct_border_fp` | INTEGER | Walls CT detects that existing pipeline does not (killer only) |
| `ct_border_fn` | INTEGER | Walls existing pipeline detects that CT does not (killer only) |
| `ct_digit_agreement` | REAL | Fraction of non-zero cage total cells where CT value equals existing OCR value (0–1; killer only) |

---

## Evaluator CLI options → columns

| Flag | Columns affected |
|------|-----------------|
| `--git-hash SHA` | `git_hash` |
| `--workers N` | `worker_id` (1…N) |
| `--limit N` | Stops after N total evaluations; no column |
| `--filter SQL` | Restricts which puzzles are claimed; no column |
| `--dump-contours DIR` | Writes per-puzzle JSON to disk; no column |

The `--diag-path` flag has been removed. All diagnostics are stored in the DB.

---

## Common queries

**Clean rate by git hash:**
```sql
SELECT git_hash,
       COUNT(*) FILTER (WHERE bucket = 'clean') AS clean,
       COUNT(*) FILTER (WHERE status = 'done')  AS total,
       ROUND(100.0 * COUNT(*) FILTER (WHERE bucket = 'clean')
             / COUNT(*) FILTER (WHERE status = 'done'), 1) AS pct
FROM evaluations
WHERE status = 'done'
GROUP BY git_hash
ORDER BY rowid DESC;
```

**WASM leak trend (average live mats per run, by git hash):**
```sql
SELECT git_hash, ROUND(AVG(live_mats), 1) AS avg_live_mats
FROM evaluations
WHERE live_mats IS NOT NULL
GROUP BY git_hash
ORDER BY rowid DESC;
```

**Contour-tree border agreement distribution for a run:**
```sql
SELECT
  ROUND(ct_border_agreement, 1) AS bucket,
  COUNT(*) AS n
FROM evaluations
WHERE git_hash = 'feature-diag'
  AND ct_border_agreement IS NOT NULL
GROUP BY ROUND(ct_border_agreement, 1)
ORDER BY bucket;
```

**Clean puzzles that needed cage-total repair:**
```sql
SELECT COUNT(*)
FROM evaluations
WHERE git_hash = 'master-leak-fix'
  AND bucket = 'clean'
  AND spec_error IS NOT NULL;
```

**Parse vs solve time breakdown:**
```sql
SELECT git_hash,
       ROUND(AVG(parse_elapsed_ms)) AS avg_parse_ms,
       ROUND(AVG(solve_elapsed_ms)) AS avg_solve_ms,
       ROUND(AVG(elapsed_ms))       AS avg_total_ms
FROM evaluations
WHERE status = 'done' AND parse_elapsed_ms IS NOT NULL
GROUP BY git_hash;
```
