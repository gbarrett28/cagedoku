# Stall Fixture Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified pipeline for capturing, storing, loading, and weeding puzzle stall states across two input sources (Guardian stress-test corpus and Cloudflare R2 user uploads).

**Architecture:** A shared `StallFixtureFile` JSON format lives in `web/stall-fixtures/`; a Vite dev middleware serves the files to a `?dev=1` picker panel in `main.ts` that loads fixtures directly into playing mode. A regression test auto-deletes fixtures that new rules resolve. The stress test runner writes stall files alongside images; an R2 GitHub Actions workflow downloads, checks, and commits them.

**Tech Stack:** TypeScript, Vite (middleware plugin), Vitest, Playwright, Python (boto3), GitHub Actions.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `web/src/engine/rules/stallFixtureFile.ts` | **Create** | `StallFixtureFile` TypeScript interface |
| `web/tsconfig.json` | **Modify** | Add `stall-fixtures/**/*` to includes |
| `web/vitest.config.ts` | **Modify** | Add `stall-fixtures/**/*.test.ts` to includes |
| `web/stall-fixtures/.gitkeep` | **Create** | Ensures directory is committed |
| `web/stall-fixtures/stall-fixtures-dir.test.ts` | **Create** | Regression test (auto-deletes solved fixtures) |
| `web/vite.config.ts` | **Modify** | Add `stallFixturesPlugin` dev middleware |
| `web/src/main.ts` | **Modify** | Add `?dev=1` picker panel; expose `spec` in `__lastSolverResult` |
| `web/e2e/stress.spec.ts` | **Modify** | Write `.stall.json` when `usedBacktracking` is true |
| `scripts/run-stress-test.sh` | **Modify** | Add `--copy-stalls <dest>` flag |
| `web/scripts/check-puzzle-specs.ts` | **Create** | vite-node script: solve R2 specs, write stall files |
| `.github/workflows/puzzle-spec-review.yml` | **Create** | Manual GHA workflow for R2 puzzle-spec processing |

---

## Task 1: StallFixtureFile type + config updates

**Files:**
- Create: `web/src/engine/rules/stallFixtureFile.ts`
- Modify: `web/tsconfig.json`
- Modify: `web/vitest.config.ts`

- [ ] **Step 1: Create the StallFixtureFile type**

Create `web/src/engine/rules/stallFixtureFile.ts`:

```typescript
import type { PuzzleSpec } from '../../solver/puzzleSpec.js';

/**
 * Committed stall-fixture record — a puzzle the rule engine cannot solve
 * without MRV backtracking.
 *
 * Files live in web/stall-fixtures/<name>.stall.json.
 * Served in dev mode via GET /dev/stall-fixtures (list) and
 * GET /dev/stall-fixtures/:name (individual fixture).
 *
 * See docs/superpowers/specs/2026-05-24-stall-fixture-pipeline-design.md.
 */
export interface StallFixtureFile {
  /** Always 1 for this format. */
  version: 1;
  /** Origin corpus: "guardian", "observer", "r2", etc. */
  source: string;
  /** Unique name derived from image filename or R2 key. */
  name: string;
  /** ISO date (YYYY-MM-DD) when the fixture was created. */
  addedAt: string;
  puzzleType: 'killer' | 'classic';
  /**
   * Repo-root-relative path to the source image.
   * Omitted for R2 uploads (no image in the repo).
   * The image may not exist on the current machine — informational only.
   */
  imagePath?: string;
  /** Full puzzle spec — passed directly to solve(). */
  spec: PuzzleSpec;
  /**
   * 9×9 candidate grid at the moment the rule engine stalled, before
   * backtracking. Each cell is a sorted array of remaining candidates;
   * single-element = already solved.
   */
  stalledCandidates: number[][][];
  /** Count of cells with more than one candidate at stall time. */
  unsolvedCells: number;
  /** Sum of candidate-list lengths across all unsolved cells at stall time. */
  totalCandidates: number;
}
```

- [ ] **Step 2: Update tsconfig.json to include stall-fixtures/**

In `web/tsconfig.json`, change:
```json
"include": ["src/**/*", "*.ts"]
```
to:
```json
"include": ["src/**/*", "stall-fixtures/**/*", "*.ts"]
```

- [ ] **Step 3: Update vitest.config.ts to include stall-fixtures tests**

In `web/vitest.config.ts`, change:
```typescript
    include: ['src/**/*.test.ts'],
```
to:
```typescript
    include: ['src/**/*.test.ts', 'stall-fixtures/**/*.test.ts'],
```

- [ ] **Step 4: Verify tsc still passes**

```bash
cd web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/rules/stallFixtureFile.ts web/tsconfig.json web/vitest.config.ts
git commit -m "feat: add StallFixtureFile type and extend tsconfig/vitest includes"
```

---

## Task 2: Stall fixtures directory + regression test

**Files:**
- Create: `web/stall-fixtures/.gitkeep`
- Create: `web/stall-fixtures/stall-fixtures-dir.test.ts`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p web/stall-fixtures
touch web/stall-fixtures/.gitkeep
```

- [ ] **Step 2: Write the regression test**

Create `web/stall-fixtures/stall-fixtures-dir.test.ts`:

```typescript
/**
 * Regression test for committed stall fixtures.
 *
 * Each *.stall.json in web/stall-fixtures/ represents a puzzle the rule engine
 * cannot solve without MRV backtracking.
 *
 * - PASSES when solve(fixture.spec).usedBacktracking === true  (gap still open)
 * - FAILS  when solve(fixture.spec).usedBacktracking === false (new rule closed it)
 *   and auto-deletes the fixture file so `git diff` shows what the rule resolved.
 *
 * Run after adding a new rule to discover which fixtures it closes.
 */

import { describe, it, expect } from 'vitest';
import { solve } from '../src/engine/index.js';
import type { StallFixtureFile } from '../src/engine/rules/stallFixtureFile.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = __dirname; // test lives alongside the fixtures

const fixtureFiles = fs.existsSync(fixturesDir)
  ? fs.readdirSync(fixturesDir).filter(f => f.endsWith('.stall.json'))
  : [];

describe('stall fixture regressions', () => {
  if (fixtureFiles.length === 0) {
    it('no fixtures committed yet', () => {
      // No-op: directory is empty, nothing to check.
    });
    return;
  }

  for (const fileName of fixtureFiles) {
    const filePath = path.join(fixturesDir, fileName);
    const fixture: StallFixtureFile = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StallFixtureFile;

    it(`still stalls: ${fixture.name}`, () => {
      const result = solve(fixture.spec);
      if (!result.usedBacktracking) {
        fs.unlinkSync(filePath);
        expect.fail(
          `${fixture.name} now solves without backtracking — fixture deleted. ` +
          `Commit the deletion (git add -u web/stall-fixtures/).`
        );
      }
      expect(result.usedBacktracking).toBe(true);
    });
  }
});
```

- [ ] **Step 3: Run the test — expect pass (empty directory)**

```bash
cd web && npx vitest run stall-fixtures/stall-fixtures-dir.test.ts
```

Expected output: `✓ stall fixture regressions > no fixtures committed yet`

- [ ] **Step 4: Commit**

```bash
git add web/stall-fixtures/.gitkeep web/stall-fixtures/stall-fixtures-dir.test.ts
git commit -m "feat: add stall-fixtures directory and regression test"
```

---

## Task 3: Vite middleware for fixture serving

**Files:**
- Modify: `web/vite.config.ts`

The middleware serves two endpoints (dev only):
- `GET /dev/stall-fixtures` → sorted metadata list (strips `spec` and `stalledCandidates`)
- `GET /dev/stall-fixtures/:name` → full fixture JSON

- [ ] **Step 1: Add the middleware plugin to vite.config.ts**

Add these imports at the top of `web/vite.config.ts` (after the existing `import { defineConfig } from 'vite';` line):

```typescript
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
```

Then add this plugin definition before `export default defineConfig(...)`:

```typescript
const __viteDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Dev-only plugin: serves committed stall fixtures from web/stall-fixtures/.
 *
 * GET /dev/stall-fixtures       → JSON array of metadata (sorted by unsolvedCells ASC,
 *                                 totalCandidates ASC), omitting spec and stalledCandidates.
 * GET /dev/stall-fixtures/:name → full StallFixtureFile JSON for a single fixture.
 *
 * Only active during `vite dev` (apply: 'serve'). Never included in the production build.
 */
const stallFixturesPlugin: Plugin = {
  name: 'dev-stall-fixtures',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/dev/stall-fixtures', (req, res, next) => {
      const fixturesDir = path.join(__viteDir, 'stall-fixtures');
      if (!fs.existsSync(fixturesDir)) {
        res.setHeader('Content-Type', 'application/json');
        res.end('[]');
        return;
      }

      // req.url is relative to the mount path (/dev/stall-fixtures).
      const relPath = (req.url ?? '/').replace(/^\//, '');

      if (relPath === '' || relPath === '/') {
        // List: return metadata only (omit heavy fields).
        const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.stall.json'));
        const metadata = files
          .map(f => {
            const raw = JSON.parse(
              fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
            ) as Record<string, unknown>;
            const { spec: _s, stalledCandidates: _c, ...meta } = raw;
            return meta;
          })
          .sort((a, b) => {
            const ua = (a as { unsolvedCells: number }).unsolvedCells;
            const ub = (b as { unsolvedCells: number }).unsolvedCells;
            const ta = (a as { totalCandidates: number }).totalCandidates;
            const tb = (b as { totalCandidates: number }).totalCandidates;
            return ua !== ub ? ua - ub : ta - tb;
          });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(metadata));
        return;
      }

      // Individual fixture: relPath is the fixture name (without .stall.json).
      const name = relPath.replace(/\.stall\.json$/, '');
      // Reject names with path separators to prevent directory traversal.
      if (name.includes('/') || name.includes('..')) {
        res.statusCode = 400;
        res.end('Invalid fixture name');
        return;
      }
      const filePath = path.join(fixturesDir, `${name}.stall.json`);
      if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(fs.readFileSync(filePath, 'utf-8'));
      } else {
        res.statusCode = 404;
        res.end(`Fixture not found: ${name}`);
      }
    });
  },
};
```

Then add `stallFixturesPlugin` to the plugins array in `defineConfig`:

```typescript
export default defineConfig({
  plugins: [devSwPoisonPill, stallFixturesPlugin],
  // ... rest unchanged
```

- [ ] **Step 2: Verify tsc on the node tsconfig**

```bash
cd web && npx tsc -p tsconfig.node.json --noEmit
```
Expected: no errors.

- [ ] **Step 3: Smoke-test the endpoint**

Start the dev server:
```bash
cd web && npm run dev -- --port 5175
```

In a second terminal:
```bash
curl http://localhost:5175/dev/stall-fixtures
```
Expected: `[]` (empty array — no fixtures yet).

Stop the dev server (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add web/vite.config.ts
git commit -m "feat: add Vite dev middleware to serve stall fixtures"
```

---

## Task 4: App dev panel (`?dev=1`)

**Files:**
- Modify: `web/src/main.ts`

The panel is injected dynamically inside the existing `if (import.meta.env.DEV)` block. It detects `?dev=1`, fetches the fixture list, and renders a table using safe DOM APIs (no `innerHTML` for data). On row click it loads the fixture directly into playing mode.

- [ ] **Step 1: Add the StallFixtureFile import to main.ts**

Near the top of `web/src/main.ts`, after the existing imports, add:

```typescript
import type { StallFixtureFile } from './engine/rules/stallFixtureFile.js';
```

- [ ] **Step 2: Add helper to create a table cell with text content**

Inside the `if (import.meta.env.DEV)` block, at the start (before the `__testLoad` registration), add:

```typescript
    /** Create a <td> with the given text and optional inline style. */
    function devTd(text: string, style?: string): HTMLTableCellElement {
      const td = document.createElement('td');
      td.textContent = text;
      td.style.cssText = style ?? 'padding:3px 8px;';
      return td;
    }
```

- [ ] **Step 3: Add the panel injection at the end of the DEV block**

At the end of the `if (import.meta.env.DEV)` block (after all the `__testLoad` and `__testSetPendingThumbs` registrations), add:

```typescript
    // Dev fixture panel — shown when URL contains ?dev=1.
    // Fetches committed stall fixtures from the Vite middleware and lets the
    // developer load any fixture directly into playing mode without OCR or review.
    if (new URLSearchParams(window.location.search).get('dev') === '1') {
      // Build panel DOM using safe DOM methods (no innerHTML for dynamic data).
      const panel = document.createElement('div');
      panel.id = 'dev-panel';
      panel.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;' +
        'background:#1a1a2e;color:#eee;font-family:monospace;font-size:12px;' +
        'max-height:40vh;overflow-y:auto;border-bottom:2px solid #4a4a8a;';

      const header = document.createElement('div');
      header.style.cssText = 'padding:4px 8px;cursor:pointer;display:flex;' +
        'align-items:center;gap:8px;background:#111128;';

      const titleSpan = document.createElement('span');
      titleSpan.textContent = '🔧 Stall Fixtures';

      const countBadge = document.createElement('span');
      countBadge.style.cssText = 'background:#4a4a8a;padding:1px 6px;border-radius:10px;font-size:10px;';

      const toggleHint = document.createElement('span');
      toggleHint.style.cssText = 'margin-left:auto;font-size:10px;color:#aaa;';
      toggleHint.textContent = '[click to toggle]';

      header.append(titleSpan, countBadge, toggleHint);

      const body = document.createElement('div');

      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      headerRow.style.cssText = 'background:#2a2a4e;text-align:left;';
      ['Name', 'Source', 'Type', 'Unsolved', 'Candidates', 'Image'].forEach(label => {
        const th = document.createElement('th');
        th.style.cssText = 'padding:3px 8px;';
        th.textContent = label;
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);

      const tbody = document.createElement('tbody');
      const statusDiv = document.createElement('div');
      statusDiv.style.cssText = 'padding:4px 8px;color:#aaa;font-style:italic;';

      table.append(thead, tbody);
      body.append(table, statusDiv);
      panel.append(header, body);
      document.body.prepend(panel);

      // Toggle collapse on header click.
      let collapsed = false;
      header.addEventListener('click', () => {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : '';
      });

      // Load a fixture directly into playing mode.
      async function loadDevFixture(name: string): Promise<void> {
        statusDiv.textContent = `Loading ${name}…`;
        try {
          const res = await fetch(`/dev/stall-fixtures/${encodeURIComponent(name)}`);
          if (!res.ok) { statusDiv.textContent = `Failed to load ${name}: ${res.status}`; return; }
          const fixture = await res.json() as StallFixtureFile;
          const { state } = loadSpecDirect(fixture.spec);
          draftBorderX = fixture.spec.borderX.map(col => [...col]);
          draftBorderY = fixture.spec.borderY.map(row => [...row]);
          draftEdited = false;
          const { board } = solveCurrentSpec();
          const playing = confirmPuzzle(board);
          renderPlayingMode(playing);
          appendCallouts(buildPlayingCallouts(playing.puzzleType !== 'classic'));
          statusDiv.textContent = `Loaded: ${name}`;
        } catch (e) {
          statusDiv.textContent = `Error: ${String(e)}`;
        }
      }

      // Fetch fixture list and populate table.
      async function refreshDevPanel(): Promise<void> {
        try {
          const res = await fetch('/dev/stall-fixtures');
          if (!res.ok) { statusDiv.textContent = 'Middleware unavailable.'; return; }
          const fixtures = await res.json() as Array<Omit<StallFixtureFile, 'spec' | 'stalledCandidates'>>;
          countBadge.textContent = String(fixtures.length);
          tbody.textContent = ''; // clear existing rows safely

          if (fixtures.length === 0) {
            statusDiv.textContent = 'No fixtures committed yet.';
            return;
          }

          for (const f of fixtures) {
            const row = document.createElement('tr');
            row.style.cssText = 'cursor:pointer;border-top:1px solid #2a2a4e;';
            row.appendChild(devTd(f.name));
            row.appendChild(devTd(f.source));
            row.appendChild(devTd(f.puzzleType));
            row.appendChild(devTd(String(f.unsolvedCells), 'padding:3px 8px;text-align:right;'));
            row.appendChild(devTd(String(f.totalCandidates), 'padding:3px 8px;text-align:right;'));
            const imgName = f.imagePath ? f.imagePath.split('/').pop() ?? '' : '';
            row.appendChild(devTd(imgName, 'padding:3px 8px;color:#888;'));
            row.addEventListener('mouseover', () => { row.style.background = '#2a2a4e'; });
            row.addEventListener('mouseout',  () => { row.style.background = ''; });
            row.addEventListener('click', () => { void loadDevFixture(f.name); });
            tbody.appendChild(row);
          }
          statusDiv.textContent = '';
        } catch (e) {
          statusDiv.textContent = 'Could not reach /dev/stall-fixtures — is the dev server running?';
        }
      }

      void refreshDevPanel();
    }
```

- [ ] **Step 4: Verify tsc still passes**

```bash
cd web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Smoke-test the panel**

```bash
cd web && npm run dev -- --port 5175
```

Open `http://localhost:5175/?dev=1`. The panel should appear at the top with the "🔧 Stall Fixtures" header and "No fixtures committed yet." status.

Stop the dev server.

- [ ] **Step 6: Run bronze gate**

```bash
cd .. && bash scripts/run-bronze-gate.sh
```
Expected: all checks pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/main.ts
git commit -m "feat: add ?dev=1 stall fixture picker panel"
```

---

## Task 5: Expose `spec` in `__lastSolverResult`

**Files:**
- Modify: `web/src/main.ts`

The stress test reads `window.__lastSolverResult` to get `stalledCandidates`. Add the puzzle `spec` to that object so the stress test can write complete stall fixtures.

- [ ] **Step 1: Update the killer auto-confirm `__lastSolverResult` assignment**

Find this block in `main.ts` (inside `handleProcess`, killer auto-confirm path — search for the line `const { board, usedBacktracking, stalledCandidates } = solveCurrentSpec();`):

```typescript
        const { board, usedBacktracking, stalledCandidates } = solveCurrentSpec();
        (window as unknown as Record<string, unknown>)['__lastSolverResult'] = {
          usedBacktracking,
          stalledCandidates: stalledCandidates ?? null,
        };
```

Replace with:

```typescript
        const { board, usedBacktracking, stalledCandidates } = solveCurrentSpec();
        (window as unknown as Record<string, unknown>)['__lastSolverResult'] = {
          usedBacktracking,
          stalledCandidates: stalledCandidates ?? null,
          spec: {
            regions: state.specData.regions,
            cageTotals: state.specData.cageTotals,
            borderX: draftBorderX,
            borderY: draftBorderY,
          },
        };
```

- [ ] **Step 2: Update the classic `__lastSolverResult` assignment (consistency)**

Find the block inside `handleProcess` for the classic path (search for `usedBacktracking: classicUsedBt`):

```typescript
        (window as unknown as Record<string, unknown>)['__lastSolverResult'] = {
          usedBacktracking: classicUsedBt,
          stalledCandidates: classicStalled ?? null,
        };
```

Replace with:

```typescript
        (window as unknown as Record<string, unknown>)['__lastSolverResult'] = {
          usedBacktracking: classicUsedBt,
          stalledCandidates: classicStalled ?? null,
          spec: {
            regions: state.specData.regions,
            cageTotals: state.specData.cageTotals,
            borderX: draftBorderX,
            borderY: draftBorderY,
          },
        };
```

- [ ] **Step 3: Verify tsc passes**

```bash
cd web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Run bronze gate**

```bash
cd .. && bash scripts/run-bronze-gate.sh
```

- [ ] **Step 5: Commit**

```bash
git add web/src/main.ts
git commit -m "feat: expose spec in __lastSolverResult for stress test stall writing"
```

---

## Task 6: Stress test stall writing

**Files:**
- Modify: `web/e2e/stress.spec.ts`

When a puzzle requires backtracking, write a `<name>.stall.json` alongside the source image.

- [ ] **Step 1: Update the `SolverResult` interface in stress.spec.ts**

Find this interface near the top of `web/e2e/stress.spec.ts`:

```typescript
interface SolverResult {
  usedBacktracking: boolean;
  stalledCandidates: number[][][] | null;
}
```

Replace with:

```typescript
interface PuzzleSpecData {
  regions: number[][];
  cageTotals: number[][];
  borderX: boolean[][];
  borderY: boolean[][];
}

interface SolverResult {
  usedBacktracking: boolean;
  stalledCandidates: number[][][] | null;
  spec: PuzzleSpecData | null;
}
```

- [ ] **Step 2: Update the `page.evaluate()` fallback value**

Find the evaluate call in `processImage`:

```typescript
      return w.__lastSolverResult ?? { usedBacktracking: false, stalledCandidates: null };
```

Replace with:

```typescript
      return w.__lastSolverResult ?? { usedBacktracking: false, stalledCandidates: null, spec: null };
```

- [ ] **Step 3: Add stall file writing inside processImage**

In `processImage`, find the block that computes `unsolvedCells` and `totalCandidates`:

```typescript
    const sc = solverResult.stalledCandidates;
    const unsolvedCells = sc === null ? 0
      : sc.flat().filter(c => c.length > 1).length;
    const totalCandidates = sc === null ? 0
      : sc.flat().filter(c => c.length > 1).reduce((sum, c) => sum + c.length, 0);
```

Immediately after that block (before the `return { file, ... }` statement), add:

```typescript
    // Write a .stall.json alongside the image when backtracking was needed.
    if (
      solverResult.usedBacktracking &&
      solverResult.stalledCandidates !== null &&
      solverResult.spec !== null &&
      PUZZLE_DIR !== undefined && PUZZLE_DIR !== ''
    ) {
      const name = path.basename(imagePath, path.extname(imagePath));
      const repoRoot = path.resolve(PUZZLE_DIR, '..');
      const relImagePath = path.relative(repoRoot, imagePath).replace(/\\/g, '/');
      const sourceName = path.basename(PUZZLE_DIR);
      const stallRecord = {
        version: 1,
        source: sourceName,
        name,
        addedAt: new Date().toISOString().slice(0, 10),
        puzzleType: 'killer',
        imagePath: relImagePath,
        spec: solverResult.spec,
        stalledCandidates: solverResult.stalledCandidates,
        unsolvedCells,
        totalCandidates,
      };
      const stallPath = imagePath.replace(/\.(jpg|jpeg|png)$/i, '.stall.json');
      fs.writeFileSync(stallPath, JSON.stringify(stallRecord, null, 2));
    }
```

- [ ] **Step 4: Verify TypeScript compiles (e2e tsconfig)**

```bash
cd web && npx tsc -p tsconfig.node.json --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/e2e/stress.spec.ts
git commit -m "feat: write .stall.json alongside image when stress test puzzle needs backtracking"
```

---

## Task 7: `--copy-stalls` flag for run-stress-test.sh

**Files:**
- Modify: `scripts/run-stress-test.sh`

- [ ] **Step 1: Replace the script contents**

Replace the entire contents of `scripts/run-stress-test.sh` with:

```bash
#!/usr/bin/env bash
# Stress-test the production image pipeline against a corpus of puzzle images.
#
# Usage:
#   bash scripts/run-stress-test.sh <puzzle-dir> [workers] [--copy-stalls <dest>]
#
#   puzzle-dir      Directory containing .jpg / .png puzzle images (absolute or
#                   relative to the repo root).
#   workers         Parallel Playwright workers (default: 4). Each worker compiles
#                   OpenCV.js WASM once (~60 s) and processes its share of images
#                   sequentially. Memory: ~450 MB per worker.
#   --copy-stalls   After the run, copy all *.stall.json files written by the stress
#                   test from <puzzle-dir> into <dest>. Existing files are overwritten
#                   (the solver result is deterministic). No-op if no stall files exist.
#
# Output:
#   <puzzle-dir>/eval_report.json — aggregate results + per-image records +
#   prioritised work queue sorted by (unsolved_cells, total_candidates).
#
# Examples:
#   bash scripts/run-stress-test.sh guardian 4
#   bash scripts/run-stress-test.sh guardian 4 --copy-stalls web/stall-fixtures
set -euo pipefail

PUZZLE_DIR=${1:?Usage: run-stress-test.sh <puzzle-dir> [workers] [--copy-stalls <dest>]}
WORKERS=${2:-4}
COPY_STALLS_DEST=""

# Parse optional --copy-stalls flag (may appear anywhere after positional args).
args=("$@")
for (( i=0; i<${#args[@]}; i++ )); do
  if [[ "${args[$i]}" == "--copy-stalls" ]]; then
    COPY_STALLS_DEST="${args[$((i+1))]:-}"
    if [[ -z "${COPY_STALLS_DEST}" ]]; then
      echo "Error: --copy-stalls requires a destination directory argument" >&2
      exit 1
    fi
  fi
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PUZZLE_DIR_ABS="$(cd "${PUZZLE_DIR}" && pwd -P)"

IMAGE_COUNT=$(find "${PUZZLE_DIR_ABS}" -maxdepth 1 \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l | tr -d ' ')
PER_WORKER=$(( (IMAGE_COUNT + WORKERS - 1) / WORKERS ))

echo "Stress test: ${IMAGE_COUNT} images, ${WORKERS} workers (~${PER_WORKER} images/worker)"
echo "WASM cold-compile: ~60 s per worker (workers run in parallel)"
echo ""

cd "${REPO_ROOT}/web"
STRESS_PUZZLE_DIR="${PUZZLE_DIR_ABS}" \
  npx playwright test \
    --config playwright.stress.config.ts \
    --workers="${WORKERS}"

cd "${REPO_ROOT}"
node scripts/merge-stress-results.mjs "${PUZZLE_DIR_ABS}"

# Copy stall fixtures into the repo fixture directory if --copy-stalls was given.
if [[ -n "${COPY_STALLS_DEST}" ]]; then
  DEST_ABS="$(cd "${REPO_ROOT}/${COPY_STALLS_DEST}" && pwd -P)"
  shopt -s nullglob
  STALL_FILES=("${PUZZLE_DIR_ABS}"/*.stall.json)
  shopt -u nullglob
  if [[ ${#STALL_FILES[@]} -gt 0 ]]; then
    echo ""
    echo "Copying ${#STALL_FILES[@]} stall fixture(s) → ${DEST_ABS}"
    for f in "${STALL_FILES[@]}"; do
      cp "${f}" "${DEST_ABS}/$(basename "${f}")"
      echo "  copied: $(basename "${f}")"
    done
    echo "Done. Review with: git diff web/stall-fixtures/"
  else
    echo ""
    echo "No .stall.json files found in ${PUZZLE_DIR_ABS} — nothing to copy."
  fi
fi
```

- [ ] **Step 2: Commit**

```bash
git add scripts/run-stress-test.sh
git commit -m "feat: add --copy-stalls flag to run-stress-test.sh"
```

---

## Task 8: `check-puzzle-specs.ts` solver script

**Files:**
- Create: `web/scripts/check-puzzle-specs.ts`

This script runs via `npx vite-node` from the `web/` directory. It reads R2 `PuzzleSpecExport` JSON files (version 2, puzzleType killer) from an input directory, runs `solve()`, and writes `StallFixtureFile` JSON to an output directory for those that still stall.

- [ ] **Step 1: Create the script**

Create `web/scripts/check-puzzle-specs.ts`:

```typescript
/**
 * check-puzzle-specs.ts — batch-check R2 puzzle-spec uploads against the solver.
 *
 * Usage (run from repo root):
 *   cd web && npx vite-node scripts/check-puzzle-specs.ts <input-dir> <output-dir>
 *
 * For each *.json in <input-dir>:
 *   - Validates shape (version 2, puzzleType killer, correct array dimensions)
 *   - Runs solve(spec)
 *   - If usedBacktracking: writes <output-dir>/<name>.stall.json
 *   - If solved cleanly:   logs a skip message
 *
 * Exits 0 whether or not any fixtures were produced.
 * The caller (puzzle-spec-review.yml) moves output files into web/stall-fixtures/.
 */

import fs from 'fs';
import path from 'path';
import { solve } from '../src/engine/index.js';
import type { StallFixtureFile } from '../src/engine/rules/stallFixtureFile.js';
import type { PuzzleSpec } from '../src/solver/puzzleSpec.js';

// ---------------------------------------------------------------------------
// PuzzleSpecExport validation (mirrors worker/src/validate.ts isPuzzleSpecExport)
// ---------------------------------------------------------------------------

interface PuzzleSpecExport {
  version: 2;
  puzzleType: 'killer';
  regions: number[][];
  cageTotals: number[][];
  borderX: boolean[][];
  borderY: boolean[][];
}

function isPuzzleSpecExport(value: unknown): value is PuzzleSpecExport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 2) return false;
  if (v['puzzleType'] !== 'killer') return false;
  if (!is9x9NumberGrid(v['regions'])) return false;
  if (!is9x9NumberGrid(v['cageTotals'])) return false;
  if (!isBorderX(v['borderX'])) return false;
  if (!isBorderY(v['borderY'])) return false;
  return true;
}

function is9x9NumberGrid(v: unknown): boolean {
  if (!Array.isArray(v) || v.length !== 9) return false;
  return (v as unknown[]).every(row =>
    Array.isArray(row) &&
    (row as unknown[]).length === 9 &&
    (row as unknown[]).every(c => typeof c === 'number'),
  );
}

function isBorderX(v: unknown): boolean {
  // borderX[col][rowGap]: shape 9×8
  if (!Array.isArray(v) || v.length !== 9) return false;
  return (v as unknown[]).every(col =>
    Array.isArray(col) &&
    (col as unknown[]).length === 8 &&
    (col as unknown[]).every(c => typeof c === 'boolean'),
  );
}

function isBorderY(v: unknown): boolean {
  // borderY[colGap][row]: shape 8×9
  if (!Array.isArray(v) || v.length !== 8) return false;
  return (v as unknown[]).every(colGap =>
    Array.isArray(colGap) &&
    (colGap as unknown[]).length === 9 &&
    (colGap as unknown[]).every(c => typeof c === 'boolean'),
  );
}

// ---------------------------------------------------------------------------
// Name derivation from R2 key filename.
// R2 key format: "puzzle-spec/2026-05-24T10:00:00.000Z-abc12345.json"
// Filename:      "2026-05-24T10:00:00.000Z-abc12345.json"
// Derived name:  "r2-2026-05-24T10-00-00.000Z-abc12345"  (colons → hyphens)
// ---------------------------------------------------------------------------

function deriveName(filename: string): string {
  const base = path.basename(filename, '.json');
  return `r2-${base.replace(/:/g, '-')}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [,, inputDir, outputDir] = process.argv;
if (!inputDir || !outputDir) {
  console.error('Usage: check-puzzle-specs.ts <input-dir> <output-dir>');
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.json'));
if (files.length === 0) {
  console.log('No .json files in input directory — nothing to check.');
  process.exit(0);
}

let stalled = 0;
let clean = 0;
let invalid = 0;

for (const filename of files) {
  const filePath = path.join(inputDir, filename);
  const name = deriveName(filename);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.warn(`[SKIP] ${filename}: failed to parse JSON — ${String(e)}`);
    invalid++;
    continue;
  }

  if (!isPuzzleSpecExport(raw)) {
    console.warn(`[SKIP] ${filename}: does not match PuzzleSpecExport (version 2, killer)`);
    invalid++;
    continue;
  }

  // PuzzleSpecExport fields are layout-identical to PuzzleSpec — no transformation needed.
  // (buildPuzzleSpecExport in trainingExport.ts copies all four arrays verbatim.)
  const spec: PuzzleSpec = {
    regions: raw.regions,
    cageTotals: raw.cageTotals,
    borderX: raw.borderX,
    borderY: raw.borderY,
  };

  const result = solve(spec);

  if (!result.usedBacktracking) {
    console.log(`[CLEAN] ${filename}: solves without backtracking — skipping`);
    clean++;
    continue;
  }

  if (!result.stalledCandidates) {
    console.warn(`[SKIP] ${filename}: usedBacktracking=true but no stalledCandidates`);
    invalid++;
    continue;
  }

  const sc = result.stalledCandidates;
  const unsolvedCells = sc.flat().filter(c => c.length > 1).length;
  const totalCandidates = sc.flat()
    .filter(c => c.length > 1)
    .reduce((sum, c) => sum + c.length, 0);

  const fixture: StallFixtureFile = {
    version: 1,
    source: 'r2',
    name,
    addedAt: new Date().toISOString().slice(0, 10),
    puzzleType: 'killer',
    spec,
    stalledCandidates: result.stalledCandidates,
    unsolvedCells,
    totalCandidates,
  };

  const outPath = path.join(outputDir, `${name}.stall.json`);
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(
    `[STALL] ${filename} → ${name}.stall.json` +
    `  (${unsolvedCells} unsolved, ${totalCandidates} candidates)`,
  );
  stalled++;
}

console.log(`\nDone: ${stalled} stalled, ${clean} clean, ${invalid} skipped.`);
```

- [ ] **Step 2: Verify the script is importable without error**

```bash
cd web && npx vite-node scripts/check-puzzle-specs.ts 2>&1 | head -3
```

Expected: `Usage: check-puzzle-specs.ts <input-dir> <output-dir>` then exits.

- [ ] **Step 3: Commit**

```bash
git add web/scripts/check-puzzle-specs.ts
git commit -m "feat: add check-puzzle-specs.ts vite-node script for R2 puzzle-spec review"
```

---

## Task 9: `puzzle-spec-review.yml` GitHub Actions workflow

**Files:**
- Create: `.github/workflows/puzzle-spec-review.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/puzzle-spec-review.yml`:

```yaml
name: Review R2 puzzle-spec uploads

on:
  workflow_dispatch:

permissions:
  contents: write

jobs:
  review:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Node dependencies
        run: cd web && npm ci

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install Python dependencies
        run: pip install boto3

      - name: List pending puzzle-spec uploads
        id: list
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
        run: |
          python3 scripts/_r2_list.py cagedoku-training puzzle-spec/ > /tmp/r2_keys.txt
          COUNT=$(wc -l < /tmp/r2_keys.txt | tr -d ' ')
          echo "count=$COUNT" >> "$GITHUB_OUTPUT"
          echo "Found $COUNT pending puzzle-spec upload(s)."

      - name: Download puzzle-spec uploads
        if: steps.list.outputs.count != '0'
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
        run: |
          mkdir -p /tmp/puzzle-specs
          python3 scripts/_r2_download.py cagedoku-training /tmp/puzzle-specs < /tmp/r2_keys.txt

      - name: Check specs against solver
        if: steps.list.outputs.count != '0'
        run: |
          mkdir -p /tmp/stall-out
          cd web && npx vite-node scripts/check-puzzle-specs.ts /tmp/puzzle-specs /tmp/stall-out

      - name: Copy new stall fixtures into repo
        if: steps.list.outputs.count != '0'
        run: |
          shopt -s nullglob
          STALL_FILES=(/tmp/stall-out/*.stall.json)
          shopt -u nullglob
          if [[ ${#STALL_FILES[@]} -gt 0 ]]; then
            cp /tmp/stall-out/*.stall.json web/stall-fixtures/
            echo "Copied ${#STALL_FILES[@]} fixture(s)."
          else
            echo "All specs solve without backtracking — no fixtures to commit."
          fi

      - name: Commit new fixtures
        if: steps.list.outputs.count != '0'
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add web/stall-fixtures/
          git diff --cached --quiet && echo "No new fixtures." || \
            git commit -m "chore: add stall fixtures from R2 puzzle-spec uploads"

      - name: Push commits
        if: steps.list.outputs.count != '0'
        run: git pull --rebase && git push

      - name: Delete processed R2 objects
        if: steps.list.outputs.count != '0'
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
        run: |
          python3 scripts/_r2_delete.py cagedoku-training < /tmp/r2_keys.txt
          echo "Deleted $(wc -l < /tmp/r2_keys.txt | tr -d ' ') R2 object(s)."
```

- [ ] **Step 2: Verify the workflow YAML parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/puzzle-spec-review.yml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 3: Run final bronze gate**

```bash
bash scripts/run-bronze-gate.sh
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/puzzle-spec-review.yml
git commit -m "feat: add puzzle-spec-review workflow to process R2 uploads"
```

---

## Task 10: Add Guardian stall fixtures to the repo

With the tooling in place, use it to commit the 9 known stall fixtures from the Guardian corpus.

**Pre-condition:** The `guardian/` directory must exist on this machine (it is gitignored). If not, re-run the scraper.

- [ ] **Step 1: Re-run the stress test with --copy-stalls**

```bash
bash scripts/run-stress-test.sh guardian 4 --copy-stalls web/stall-fixtures
```

Expected: 9 `.stall.json` files copied into `web/stall-fixtures/`.

- [ ] **Step 2: Verify fixture files exist**

```bash
ls web/stall-fixtures/*.stall.json | wc -l
```

Expected: `9`

- [ ] **Step 3: Run regression test — all 9 should still stall**

```bash
cd web && npx vitest run stall-fixtures/stall-fixtures-dir.test.ts
```

Expected: 9 tests pass (`still stalls: killer_sudoku_101`, etc.).

- [ ] **Step 4: Run full bronze gate**

```bash
cd .. && bash scripts/run-bronze-gate.sh
```

- [ ] **Step 5: Commit the fixtures**

```bash
git add web/stall-fixtures/
git commit -m "feat: add 9 Guardian killer sudoku stall fixtures"
```
