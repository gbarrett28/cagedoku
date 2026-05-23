# Puzzle Corpus Stress Test — Design Spec

## Goal

Build a corpus of classic sudoku images and a Playwright-based runner that
stress-tests the production OCR pipeline and logical rule engine across many
puzzles. Results are prioritised so the easiest rule gaps are investigated
first.

## Context

We have ~1,800 killer sudoku images (Guardian + Observer) evaluated at
~99.7% solve rate via the Python `evaluate.py` harness. We have no classic
sudoku images. This work adds:

1. A scraper to download Guardian classic sudoku print images.
2. A Playwright runner that processes each image through the production
   TypeScript app (real OCR, real rule engine) and records solver metrics.
3. A JSON report with a prioritised work queue for rule development.

The runner stops at the **OCR review screen** — it does not enter playing
mode. At that point the app has already run the full image pipeline, found a
solution (or failed), and determined whether the logical rules alone were
sufficient. All required metrics are readable from that state.

---

## Files

| File | Change |
|---|---|
| `killer_sudoku/training/scrape_puzzles.py` | Add `--series-url` flag to make series URL configurable; existing Guardian killer URL becomes the default |
| `web/e2e/stress.spec.ts` | New — Playwright stress-test runner |
| `scripts/run-stress-test.sh` | New — convenience wrapper that sets env vars and invokes Playwright with correct flags |

No changes to production app code. No new npm dependencies (Playwright already
present).

---

## 1 — Scraper

Extend `killer_sudoku/training/scrape_puzzles.py` with a `--series-url` flag.
The logic is identical to the existing killer scraper — iterate series index
pages, collect article links, download the print-edition `.jpg` from each
article.

**Guardian classic sudoku series:**
```
https://www.theguardian.com/lifeandstyle/series/sudoku?page={n}
```

**Guardian classic sudoku (hard/diabolical only):**

Pass `--title-contains diabolical` (or `hard`) to filter articles by title
substring. The Guardian includes difficulty in article titles
("Sudoku No 4,212 (diabolical)"). This targets puzzles most likely to
stress the rule engine.

**Usage:**
```bash
python -m killer_sudoku.training.scrape_puzzles \
    --output-dir classic_guardian \
    --series-url "https://www.theguardian.com/lifeandstyle/series/sudoku?page={}"
    --title-contains diabolical
```

The `--output-dir` guard (skip if directory already exists) is preserved.
Images are named `killer_sudoku_N.jpg` (same convention as killer corpus).

---

## 2 — Playwright Stress-Test Runner

### File: `web/e2e/stress.spec.ts`

One `test.describe` block. A single test iterates over all `.jpg` / `.png`
files found in the directory given by the `STRESS_PUZZLE_DIR` environment
variable (required). The shared-page singleton pattern (one Chromium instance
per worker, WASM compiles once) is copied from `app.spec.ts`.

### Per-image flow

```
setInputFiles('#file-input', imagePath)
click '#process-btn'
wait for '#review-panel' visible OR '#status-msg' contains error text
  → if error: record pipeline_ok=false, skip to next image
page.evaluate() → extract solver metrics from app state
click '#new-puzzle-btn'
wait for '#upload-panel' visible
→ next image
```

### Solver metrics extraction

After `#review-panel` becomes visible, call `page.evaluate()` to read the
app's in-memory solver state:

- **`solution_found`** — whether the solver found a complete solution.
- **`backtracker_required`** — whether backtracking was needed (logical rules
  alone were insufficient).
- **`unsolved_cells`** — number of cells the logical rule engine could not
  place a digit in (i.e., cells the backtracker had to handle). Zero means
  the logical rules solved it completely.
- **`total_candidates`** — sum of remaining candidates across all unsolved
  cells after the logical rule engine ran. Zero when `unsolved_cells` is zero.

The exact JS call is an implementation detail resolved during development
(likely reading from `getState()` or a dedicated `getSolverStats()` helper
exposed via `window` in the production build, or computed inline via
`buildEngine`).

### Parallelism

```bash
STRESS_PUZZLE_DIR=classic_guardian \
PLAYWRIGHT_PIPELINE_TESTS=1 \
  npx playwright test --config playwright.config.ts stress.spec.ts \
  --workers=4
```

Each Playwright worker compiles WASM once (~60 s) then processes its shard of
images sequentially. Four workers: ~1.8 GB RAM, ~4× throughput.

### Timeout

Per-image timeout: 30 s (OCR takes 2–5 s; 30 s provides safety margin for
slow images without hanging the run). Overall test timeout: disabled (set to
0) — the single test runs until all images are processed.

---

## 3 — Output

### `eval_report.json` (written to `STRESS_PUZZLE_DIR`)

```json
{
  "timestamp": "2026-05-23T10:00:00Z",
  "source": "classic_guardian",
  "total": 500,
  "pipeline_ok": 498,
  "solution_found": 496,
  "backtracker_required": 41,
  "pipeline_errors": 2,
  "per_image": {
    "killer_sudoku_0.jpg": {
      "pipeline_ok": true,
      "solution_found": true,
      "backtracker_required": false,
      "unsolved_cells": 0,
      "total_candidates": 0,
      "duration_ms": 3120,
      "error": null
    }
  },
  "work_queue": [
    { "file": "killer_sudoku_312.jpg", "unsolved_cells": 1, "total_candidates": 2 },
    { "file": "killer_sudoku_087.jpg", "unsolved_cells": 1, "total_candidates": 3 },
    { "file": "killer_sudoku_204.jpg", "unsolved_cells": 2, "total_candidates": 5 }
  ]
}
```

`work_queue` contains only backtracker puzzles, sorted ascending by
`(unsolved_cells, total_candidates)`. The top entries are the easiest rule
gaps to close — one cell with two candidates means a single new rule
eliminates one candidate and places the digit. Rules found there often
propagate to reduce candidates in harder puzzles, shrinking or eliminating
their backtracker dependency.

### stdout summary

```
Stress test complete — classic_guardian (498/500 pipeline OK)
  Solution found:        496  (99.2%)
  Backtracker required:   41  ( 8.3%)
  Pipeline errors:         2

Rule engine work queue (easiest first):
  killer_sudoku_312.jpg  — 1 unsolved,  2 candidates
  killer_sudoku_087.jpg  — 1 unsolved,  3 candidates
  killer_sudoku_204.jpg  — 2 unsolved,  5 candidates
  ... (38 more)
```

### `scripts/run-stress-test.sh`

```bash
#!/usr/bin/env bash
# Usage: bash scripts/run-stress-test.sh <puzzle-dir> [workers]
set -euo pipefail
PUZZLE_DIR=${1:?Usage: run-stress-test.sh <puzzle-dir> [workers]}
WORKERS=${2:-4}
cd web
STRESS_PUZZLE_DIR="$PUZZLE_DIR" \
PLAYWRIGHT_PIPELINE_TESTS=1 \
  npx playwright test --config playwright.config.ts stress.spec.ts \
  --workers="$WORKERS"
```

---

## Out of Scope

- No changes to the production app (no new `window` globals, no new API
  surface exposed solely for testing — metrics are read from existing
  internal state).
- No Playwright test for rule engine correctness (that is `flow.spec.ts`'s
  job).
- No scraping of non-Guardian sources (Telegraph, Daily Mail) — different
  HTML structure, separate work if needed.
- No automated rule generation — the work queue identifies candidates for
  manual rule development.
