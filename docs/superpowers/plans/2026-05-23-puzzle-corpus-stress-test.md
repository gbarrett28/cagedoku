# Puzzle Corpus Stress Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Guardian classic-sudoku scraper and a Playwright stress-test runner that processes every image through the production app, records OCR and solver metrics, and outputs a prioritised work queue for rule development.

**Architecture:** Python scraper extends the existing `scrape_puzzles.py` with a `--series-url` flag. The Playwright runner (`web/e2e/stress.spec.ts`) creates one test per image; workers share a WASM-compiled page so OpenCV loads once per worker. A small hook in `main.ts` exposes solver stats via `window.__lastSolverResult`. A Node merge script combines per-worker result files into a single `eval_report.json`.

**Tech Stack:** Python `requests`/`BeautifulSoup` (existing), Playwright TypeScript (existing), Node.js ESM for merge script.

---

## Files

| File | Change |
|---|---|
| `killer_sudoku/training/scrape_puzzles.py` | Add `--series-url` CLI arg; pass through to function |
| `web/src/main.ts` | Expose `window.__lastSolverResult` after every `solveCurrentSpec()` call in `handleProcess` |
| `web/playwright.config.ts` | Add `stress.spec.ts` to `testIgnore` |
| `web/e2e/stress.spec.ts` | New — Playwright stress-test runner |
| `scripts/merge-stress-results.mjs` | New — merges per-worker JSON files, prints summary |
| `scripts/run-stress-test.sh` | New — wrapper that runs Playwright + merge |

---

### Task 1: Extend scrape_puzzles.py with --series-url

**Files:**
- Modify: `killer_sudoku/training/scrape_puzzles.py`

The series URL is currently hardcoded. Make it a parameter so the same script works for any Guardian puzzle series.

- [ ] **Step 1.1: Add `series_url` parameter to `scrape_puzzles()`**

In `killer_sudoku/training/scrape_puzzles.py`, replace the function signature and the hardcoded `html_idx` line:

```python
# BEFORE
def scrape_puzzles(output_dir: Path, url_contains: str | None = None) -> None:
    """..."""
    html_idx = "https://www.theguardian.com/lifeandstyle/series/killer-sudoku?page={}"
```

```python
# AFTER
_DEFAULT_SERIES = "https://www.theguardian.com/lifeandstyle/series/killer-sudoku?page={}"

def scrape_puzzles(
    output_dir: Path,
    series_url: str = _DEFAULT_SERIES,
    url_contains: str | None = None,
) -> None:
    """Download puzzle images into output_dir.

    Fetches the series index pages, collects article URLs, then downloads the
    print .jpg from each article.  If url_contains is provided, only articles
    whose URL contains that substring are collected (use this to restrict to a
    specific puzzle series or difficulty level -- Guardian URLs often encode
    difficulty, e.g. "diabolical").

    Only runs if output_dir does not already exist. This is intentional:
    the existing .jpg images are the primary source of training data and
    should not be overwritten.

    Args:
        output_dir: Directory to create and populate with .jpg files.
        series_url: Series index URL with ``{}`` as the page-number
            placeholder. Defaults to the Guardian killer-sudoku series.
        url_contains: Optional substring filter applied to article URLs.
    """
    html_idx = series_url
```

- [ ] **Step 1.2: Add `--series-url` arg to `main()`**

In the same file, update `main()`:

```python
def main() -> None:
    """CLI entry point: scrape puzzle images from a series index page."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Scrape puzzle images from a Guardian series index page"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory to save images into",
    )
    parser.add_argument(
        "--series-url",
        default=_DEFAULT_SERIES,
        help=(
            "Series index URL with {} as the page-number placeholder. "
            "Default: Guardian killer-sudoku series."
        ),
    )
    parser.add_argument(
        "--url-contains",
        default=None,
        help=(
            "Only collect articles whose URL contains this substring. "
            "Guardian URLs encode difficulty (e.g. 'diabolical', 'hard'). "
            "Use to restrict to a specific puzzle series or difficulty."
        ),
    )
    args = parser.parse_args()
    scrape_puzzles(
        args.output_dir,
        series_url=args.series_url,
        url_contains=args.url_contains,
    )
```

- [ ] **Step 1.3: Verify the scraper still works for the existing killer series**

```bash
python -m killer_sudoku.training.scrape_puzzles --help
```

Expected output includes `--series-url` and `--url-contains` args with no errors.

- [ ] **Step 1.4: Run bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add killer_sudoku/training/scrape_puzzles.py
git commit -m "feat: add --series-url flag to scrape_puzzles for classic sudoku (#117)"
```

---

### Task 2: Expose solver stats via window.__lastSolverResult

**Files:**
- Modify: `web/src/main.ts`

The Playwright runner needs `{ usedBacktracking, stalledCandidates }` after processing. The existing `window.__lastPipelineResult` hook shows the pattern. We add a parallel hook.

`stalledCandidates` is a `number[][][]` (9×9 grid of sorted candidate arrays) captured just before backtracking. Cells with one candidate are solved by the rule engine; cells with multiple candidates are where the backtracker took over. When `stalledCandidates` is `null`, the rule engine solved the puzzle completely.

- [ ] **Step 2.1: Clear the hook at the start of handleProcess**

In `web/src/main.ts`, find `async function handleProcess(): Promise<void> {` (around line 851). After the `setLoading(true);` line, add:

```typescript
    // Reset solver result so stale data from a previous run is never read.
    (window as unknown as Record<string, unknown>)['__lastSolverResult'] = null;
```

- [ ] **Step 2.2: Store result after the killer auto-confirm solver call**

Find the line (around line 889):
```typescript
        const { board, usedBacktracking, stalledCandidates } = solveCurrentSpec();
```

Immediately after it, add:
```typescript
        (window as unknown as Record<string, unknown>)['__lastSolverResult'] = {
          usedBacktracking,
          stalledCandidates: stalledCandidates ?? null,
        };
```

- [ ] **Step 2.3: Store result after the classic auto-confirm solver call**

Find the line (around line 956):
```typescript
        const { board: classicBoard } = solveCurrentSpec();
```

Replace it with (adds `usedBacktracking` and `stalledCandidates` to the destructuring):
```typescript
        const { board: classicBoard, usedBacktracking: classicUsedBt, stalledCandidates: classicStalled } = solveCurrentSpec();
        (window as unknown as Record<string, unknown>)['__lastSolverResult'] = {
          usedBacktracking: classicUsedBt,
          stalledCandidates: classicStalled ?? null,
        };
```

- [ ] **Step 2.4: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2.5: Run bronze gate and commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh
git add web/src/main.ts
git commit -m "feat: expose window.__lastSolverResult for Playwright stress test (#117)"
```

---

### Task 3: Exclude stress.spec.ts from the default Playwright run

**Files:**
- Modify: `web/playwright.config.ts`

The silver gate runs all Playwright tests. The stress spec must be excluded — it requires `STRESS_PUZZLE_DIR` which is never set in CI. The explicit `npx playwright test stress.spec.ts` invocation in `run-stress-test.sh` overrides `testIgnore`.

- [ ] **Step 3.1: Add stress.spec.ts to testIgnore**

In `web/playwright.config.ts`, find:
```typescript
  testIgnore: ['**/flow.spec.ts'],
```

Replace with:
```typescript
  testIgnore: ['**/flow.spec.ts', '**/stress.spec.ts'],
```

- [ ] **Step 3.2: Run the normal Playwright suite to confirm nothing changed**

```bash
cd web && npx playwright test --config playwright.config.ts
```

Expected: same number of tests as before, `stress.spec.ts` does not appear.

- [ ] **Step 3.3: Run bronze gate and commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh
git add web/playwright.config.ts
git commit -m "chore: exclude stress.spec.ts from default Playwright run (#117)"
```

---

### Task 4: Create the Playwright stress-test runner

**Files:**
- Create: `web/e2e/stress.spec.ts`

One test per image. Playwright distributes tests across workers; each worker compiles WASM once using a module-level shared page. Per-worker results are written to `eval_results_<pid>.json` in `afterAll`; the merge script (Task 5) combines them.

- [ ] **Step 4.1: Create web/e2e/stress.spec.ts**

```typescript
/**
 * Stress-test runner — processes every puzzle image in STRESS_PUZZLE_DIR
 * through the production image pipeline and records solver metrics.
 *
 * Each image becomes one Playwright test so workers can distribute them
 * automatically. All tests within a worker share a single browser page;
 * OpenCV.js WASM compiles once per worker (~60 s) and stays resident.
 *
 * Usage: see scripts/run-stress-test.sh
 *
 * Per-worker results are written to <STRESS_PUZZLE_DIR>/eval_results_<pid>.json.
 * Run scripts/merge-stress-results.mjs afterwards to combine into eval_report.json.
 */

import { test, type Browser, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { waitForPipelineReady } from './helpers.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PUZZLE_DIR = process.env['STRESS_PUZZLE_DIR'];
const IMAGE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SolverResult {
  usedBacktracking: boolean;
  stalledCandidates: number[][][] | null;
}

interface ImageResult {
  file: string;
  pipeline_ok: boolean;
  solution_found: boolean;
  backtracker_required: boolean;
  unsolved_cells: number;
  total_candidates: number;
  duration_ms: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Worker-local state (one page shared across all tests in this worker)
// ---------------------------------------------------------------------------

let sharedPage: Page | null = null;
const workerResults: ImageResult[] = [];

async function getSharedPage(browser: Browser): Promise<Page> {
  if (sharedPage === null || sharedPage.isClosed()) {
    sharedPage = await browser.newPage();
    await sharedPage.addInitScript(() =>
      localStorage.setItem('coach_tutorial_suppressed', 'true'),
    );
    await sharedPage.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForPipelineReady(sharedPage, 90_000);
  }
  return sharedPage;
}

// ---------------------------------------------------------------------------
// Per-image processing
// ---------------------------------------------------------------------------

async function processImage(page: Page, imagePath: string): Promise<ImageResult> {
  const file = path.basename(imagePath);
  const t0 = Date.now();

  try {
    await page.locator('#file-input').setInputFiles(imagePath);
    await page.locator('#process-btn').click();

    // Wait for the review panel OR playing mode (auto-confirm may skip the review screen).
    // '#action-group:not([hidden])' uniquely identifies playing mode.
    await page.waitForSelector(
      '#review-panel:not([hidden]), #action-group:not([hidden])',
      { timeout: IMAGE_TIMEOUT_MS },
    );

    // A non-empty error status means OCR or validation failed.
    const statusText = (await page.locator('#status-msg').textContent() ?? '').trim();
    const pipelineError = statusText.length > 0 &&
      /failed|error|could not|no solution/i.test(statusText);

    if (pipelineError) {
      return {
        file, pipeline_ok: false, solution_found: false, backtracker_required: false,
        unsolved_cells: 0, total_candidates: 0, duration_ms: Date.now() - t0,
        error: statusText,
      };
    }

    // Read solver stats exposed by main.ts.
    const solverResult = await page.evaluate((): SolverResult => {
      const w = window as unknown as { __lastSolverResult?: SolverResult | null };
      return w.__lastSolverResult ?? { usedBacktracking: false, stalledCandidates: null };
    });

    const sc = solverResult.stalledCandidates;
    const unsolvedCells = sc === null ? 0
      : sc.flat().filter(c => c.length > 1).length;
    const totalCandidates = sc === null ? 0
      : sc.flat().filter(c => c.length > 1).reduce((sum, c) => sum + c.length, 0);

    return {
      file,
      pipeline_ok: true,
      solution_found: true,
      backtracker_required: solverResult.usedBacktracking,
      unsolved_cells: unsolvedCells,
      total_candidates: totalCandidates,
      duration_ms: Date.now() - t0,
      error: null,
    };
  } catch (e) {
    return {
      file, pipeline_ok: false, solution_found: false, backtracker_required: false,
      unsolved_cells: 0, total_candidates: 0, duration_ms: Date.now() - t0,
      error: String(e),
    };
  } finally {
    // Reset to the upload screen without a full page reload.
    const newPuzzleBtn = page.locator('#new-puzzle-btn');
    const btnVisible = await newPuzzleBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (btnVisible) {
      await newPuzzleBtn.click();
      await page.locator('#upload-panel')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => { /* handled by next test */ });
    } else {
      // Fallback: reload if the new-puzzle button is not reachable.
      await page.goto('/', { waitUntil: 'domcontentloaded' });
    }
  }
}

// ---------------------------------------------------------------------------
// Image list — evaluated at module load so Playwright sees the test count
// ---------------------------------------------------------------------------

const images: string[] = PUZZLE_DIR
  ? fs.readdirSync(PUZZLE_DIR)
      .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
      .map(f => path.resolve(PUZZLE_DIR, f))
      .sort()
  : [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('stress', () => {
  test.skip(!PUZZLE_DIR || images.length === 0,
    'Set STRESS_PUZZLE_DIR to a directory of puzzle images to run this suite.');

  test.afterAll(async () => {
    if (workerResults.length === 0 || !PUZZLE_DIR) return;
    const outPath = path.join(PUZZLE_DIR, `eval_results_${process.pid}.json`);
    fs.writeFileSync(outPath, JSON.stringify(workerResults, null, 2));
    console.log(`[stress] Worker ${process.pid}: wrote ${workerResults.length} results to ${outPath}`);
  });

  for (const imagePath of images) {
    test(path.basename(imagePath), async ({ browser }) => {
      test.setTimeout(IMAGE_TIMEOUT_MS + 15_000);
      const page = await getSharedPage(browser);
      const result = await processImage(page, imagePath);
      workerResults.push(result);
    });
  }
});
```

- [ ] **Step 4.2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

---

### Task 5: Create the merge script

**Files:**
- Create: `scripts/merge-stress-results.mjs`

Reads all `eval_results_<pid>.json` files from the puzzle directory, merges them into one `eval_report.json`, prints the summary, and cleans up the worker files.

- [ ] **Step 5.1: Create scripts/merge-stress-results.mjs**

```javascript
#!/usr/bin/env node
/**
 * Merge per-worker eval_results_*.json files into a single eval_report.json.
 *
 * Usage: node scripts/merge-stress-results.mjs <puzzle-dir>
 */

import fs from 'fs';
import path from 'path';

const puzzleDir = process.argv[2];
if (!puzzleDir) {
  console.error('Usage: merge-stress-results.mjs <puzzle-dir>');
  process.exit(1);
}

const workerFiles = fs.readdirSync(puzzleDir)
  .filter(f => /^eval_results_\d+\.json$/.test(f))
  .map(f => path.join(puzzleDir, f));

if (workerFiles.length === 0) {
  console.error(`No eval_results_*.json files found in ${puzzleDir}`);
  process.exit(1);
}

const allResults = workerFiles
  .flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')))
  .sort((a, b) => a.file.localeCompare(b.file));

const total              = allResults.length;
const pipelineOk         = allResults.filter(r => r.pipeline_ok).length;
const solutionFound      = allResults.filter(r => r.solution_found).length;
const backtrackerRequired = allResults.filter(r => r.backtracker_required).length;
const pipelineErrors     = allResults.filter(r => !r.pipeline_ok).length;

const workQueue = allResults
  .filter(r => r.backtracker_required)
  .sort((a, b) => a.unsolved_cells - b.unsolved_cells || a.total_candidates - b.total_candidates)
  .map(r => ({ file: r.file, unsolved_cells: r.unsolved_cells, total_candidates: r.total_candidates }));

const report = {
  timestamp: new Date().toISOString(),
  source: path.basename(puzzleDir),
  total,
  pipeline_ok: pipelineOk,
  solution_found: solutionFound,
  backtracker_required: backtrackerRequired,
  pipeline_errors: pipelineErrors,
  work_queue: workQueue,
  per_image: Object.fromEntries(allResults.map(r => [r.file, r])),
};

const reportPath = path.join(puzzleDir, 'eval_report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

// Print summary
const pct = (n) => `(${(100 * n / total).toFixed(1)}%)`;
console.log(`\nStress test complete — ${path.basename(puzzleDir)} (${pipelineOk}/${total} pipeline OK)`);
console.log(`  Solution found:       ${String(solutionFound).padStart(5)}  ${pct(solutionFound)}`);
console.log(`  Backtracker required: ${String(backtrackerRequired).padStart(5)}  ${pct(backtrackerRequired)}`);
console.log(`  Pipeline errors:      ${String(pipelineErrors).padStart(5)}`);

if (workQueue.length > 0) {
  console.log('\nRule engine work queue (easiest first):');
  workQueue.slice(0, 10).forEach(r =>
    console.log(`  ${r.file.padEnd(35)} — ${r.unsolved_cells} unsolved, ${r.total_candidates} candidates`),
  );
  if (workQueue.length > 10) console.log(`  ... (${workQueue.length - 10} more)`);
}

console.log(`\nReport: ${reportPath}`);

// Clean up worker result files
workerFiles.forEach(f => fs.unlinkSync(f));
```

---

### Task 6: Create the run-stress-test.sh wrapper

**Files:**
- Create: `scripts/run-stress-test.sh`

- [ ] **Step 6.1: Create scripts/run-stress-test.sh**

```bash
#!/usr/bin/env bash
# Stress-test the production image pipeline against a corpus of puzzle images.
#
# Usage:
#   bash scripts/run-stress-test.sh <puzzle-dir> [workers]
#
#   puzzle-dir   Directory containing .jpg / .png puzzle images (absolute or
#                relative to the repo root).
#   workers      Parallel Playwright workers (default: 4). Each worker compiles
#                OpenCV.js WASM once (~60 s) and processes its share of images
#                sequentially. Memory: ~450 MB per worker.
#
# Output:
#   <puzzle-dir>/eval_report.json — aggregate results + per-image records +
#   prioritised work queue sorted by (unsolved_cells, total_candidates).
set -euo pipefail

PUZZLE_DIR=${1:?Usage: run-stress-test.sh <puzzle-dir> [workers]}
WORKERS=${2:-4}

# Resolve to absolute path so it survives the cd into web/.
PUZZLE_DIR_ABS=$(cd "${PUZZLE_DIR}" && pwd -P)

IMAGE_COUNT=$(find "${PUZZLE_DIR_ABS}" -maxdepth 1 \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l)
echo "Stress test: ${IMAGE_COUNT} images, ${WORKERS} workers — $(( (IMAGE_COUNT + WORKERS - 1) / WORKERS )) images/worker"
echo "WASM cold-compile: ~60 s per worker (runs in parallel)"
echo ""

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

cd "${REPO_ROOT}/web"
STRESS_PUZZLE_DIR="${PUZZLE_DIR_ABS}" \
PLAYWRIGHT_PIPELINE_TESTS=1 \
  npx playwright test \
    --config playwright.config.ts \
    stress.spec.ts \
    --workers="${WORKERS}"

cd "${REPO_ROOT}"
node scripts/merge-stress-results.mjs "${PUZZLE_DIR_ABS}"
```

- [ ] **Step 6.2: Make the script executable**

```bash
chmod +x scripts/run-stress-test.sh
```

- [ ] **Step 6.3: Run bronze gate and commit everything**

```bash
bash scripts/run-bronze-gate.sh
git add web/e2e/stress.spec.ts scripts/merge-stress-results.mjs scripts/run-stress-test.sh
git commit -m "feat: Playwright stress-test runner and merge script (#117)"
```

---

### Task 7: Scrape classic puzzles and run a smoke test

**Files:**
- None (this task runs the tooling against real data)

- [ ] **Step 7.1: Scrape the Guardian classic sudoku series**

From the repo root:

```bash
python -m killer_sudoku.training.scrape_puzzles \
    --output-dir classic_guardian \
    --series-url "https://www.theguardian.com/lifeandstyle/series/sudoku?page={}"
```

Expected: `classic_guardian/` created, images downloading (logged as `Scraping killer_sudoku_N.jpg from ...`). If the page structure has changed since the scraper was written and no images are found, inspect `r.text` from the series index page and update the BeautifulSoup selector `soup.find_all("a", attrs={"class": "fc-item__link"})` accordingly.

- [ ] **Step 7.2: Smoke-test with 5 images and 1 worker**

Build the production bundle first (required by `playwright.config.ts` which serves `vite preview`):

```bash
cd web && npm run build && cd ..
```

Then run on a small subset:

```bash
mkdir -p classic_guardian_smoke
cp classic_guardian/killer_sudoku_{0,1,2,3,4}.jpg classic_guardian_smoke/
bash scripts/run-stress-test.sh classic_guardian_smoke 1
```

Expected: 5 images processed, `classic_guardian_smoke/eval_report.json` written, summary printed. No unhandled exceptions. OCR pipeline rate ≥ 80% (classic images may have different characteristics than killer).

- [ ] **Step 7.3: Run the full classic corpus**

```bash
bash scripts/run-stress-test.sh classic_guardian 4
```

Expected:
- WASM compiles in ~60 s across 4 workers (in parallel)
- Images process at ~3–5 s each
- `classic_guardian/eval_report.json` written
- Work queue printed — puzzle filenames with backtracker dependency, sorted by `(unsolved_cells, total_candidates)`

- [ ] **Step 7.4: Run bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add scripts/run-stress-test.sh  # ensure chmod +x is tracked
git commit -m "chore: verify stress test runs on guardian classic corpus (#117)"
```

---

### Task 8: Update docs and merge

- [ ] **Step 8.1: Update docs/ui.md with a note about the stress-test tooling**

In `docs/ui.md` (or `docs/architecture.md` if more appropriate), add a section describing the stress-test tooling:

```markdown
## Stress-Test Tooling

`scripts/run-stress-test.sh <puzzle-dir> [workers]` processes every `.jpg`/`.png`
in a directory through the production app via Playwright and writes an
`eval_report.json` alongside the images. Each Playwright worker compiles
OpenCV.js once; 4 workers on ~500 images takes ~20 minutes.

The report includes:
- `pipeline_ok` — OCR succeeded, no validation error
- `solution_found` — solver found a complete solution
- `backtracker_required` — logical rules alone were insufficient
- `unsolved_cells` / `total_candidates` — how far the rule engine got before stalling
- `work_queue` — backtracker puzzles sorted by `(unsolved_cells ASC, total_candidates ASC)` — the easiest rule gaps to close first

To scrape new puzzle images:
```bash
python -m killer_sudoku.training.scrape_puzzles \
    --output-dir <dir> \
    --series-url "https://www.theguardian.com/lifeandstyle/series/sudoku?page={}" \
    --url-contains diabolical   # optional difficulty filter
```
```

- [ ] **Step 8.2: Delete the spec and plan, run silver gate, merge**

```bash
rm docs/superpowers/specs/2026-05-23-puzzle-corpus-stress-test-design.md
rm docs/superpowers/plans/2026-05-23-puzzle-corpus-stress-test.md

bash scripts/run-bronze-gate.sh
git add docs/ 
git commit -m "docs: update architecture docs for stress-test tooling (#117)"

bash scripts/run-silver-gate.sh
git checkout master
git merge feature/puzzle-corpus-stress-test
git push origin master
git branch -d feature/puzzle-corpus-stress-test
```
