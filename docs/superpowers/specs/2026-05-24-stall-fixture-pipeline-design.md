# Stall Fixture Pipeline — Design Spec

**Date:** 2026-05-24
**Status:** Approved

## Overview

A unified pipeline for capturing, storing, loading, and weeding puzzle stall states — cases where the rule engine cannot solve a puzzle without MRV backtracking. Two input sources (Guardian stress-test corpus and Cloudflare R2 user uploads) converge on a common file format committed to the repo. A dev-mode app panel lets developers load any fixture directly into the solution screen. A regression test auto-deletes fixtures that a new rule has resolved.

---

## Sub-project 1: Common Format

### File shape

Each stall record is a `<name>.stall.json` file:

```json
{
  "version": 1,
  "source": "guardian",
  "name": "killer_sudoku_101",
  "addedAt": "2026-05-24",
  "puzzleType": "killer",
  "imagePath": "guardian/killer_sudoku_101.jpg",
  "spec": {
    "regions": [[…]],
    "cageTotals": [[…]],
    "borderX": [[…]],
    "borderY": [[…]]
  },
  "stalledCandidates": [[[…]]],
  "unsolvedCells": 66,
  "totalCandidates": 316
}
```

**Field notes:**

| Field | Required | Notes |
|---|---|---|
| `version` | ✓ | Always `1` for this format |
| `source` | ✓ | `"guardian"`, `"observer"`, `"r2"`, or another corpus name |
| `name` | ✓ | Derived from image filename or R2 key; unique across the directory |
| `addedAt` | ✓ | ISO date (YYYY-MM-DD) the fixture was created |
| `puzzleType` | ✓ | `"killer"` or `"classic"` |
| `imagePath` | — | Repo-root-relative path to the source image; omitted when unknown (R2 uploads) |
| `spec` | ✓ | Full `PuzzleSpec` — regions, cageTotals, borderX, borderY. Shape matches `web/src/solver/puzzleSpec.ts` |
| `stalledCandidates` | ✓ | 9×9 array of sorted candidate lists; single-element = solved cell. Captured at the moment the rule engine stalled, before backtracking |
| `unsolvedCells` | ✓ | Count of cells with more than one candidate at stall time. Pre-computed for the picker |
| `totalCandidates` | ✓ | Sum of candidate-list lengths across all unsolved cells. Pre-computed for the picker |

### TypeScript type

Defined in `web/src/engine/rules/stallFixtureFile.ts`:

```ts
export interface StallFixtureFile {
  version: 1;
  source: string;
  name: string;
  addedAt: string;
  puzzleType: 'killer' | 'classic';
  imagePath?: string;
  spec: PuzzleSpec;
  stalledCandidates: number[][][];
  unsolvedCells: number;
  totalCandidates: number;
}
```

### Location in repo

`web/stall-fixtures/<name>.stall.json`

Files are committed to the repo so all developers share the same fixture set. The directory is not in `web/public/` — files are served only through the Vite dev middleware (see Sub-project 2).

### Coordinate conventions

`spec.regions`, `spec.cageTotals` are row-major (`[row][col]`), consistent with `PuzzleSpec` and the project-wide convention. `spec.borderX[col][rowGap]` and `spec.borderY[colGap][row]` follow the intentional col-first border exception documented in `web/src/image/validation.ts`.

---

## Sub-project 2: App Import Panel

### Activation

The panel is shown when the URL contains `?dev=1`. On a production build this query parameter is ignored — the Vite middleware that backs the panel does not exist outside `vite dev`.

### Vite middleware

A dev-only plugin registered in `vite.config.ts` handles two endpoints:

- `GET /dev/stall-fixtures` — reads `web/stall-fixtures/*.stall.json`, returns a JSON array of metadata objects (all fields except `spec` and `stalledCandidates`) sorted by `(unsolvedCells ASC, totalCandidates ASC)`
- `GET /dev/stall-fixtures/:name` — returns the full JSON for a single fixture

### UI

A collapsible panel rendered at the top of the app when `?dev=1` is detected. Contents:

- Header: "Stall Fixtures" with a collapse toggle and a fixture count badge
- Table columns (sorted by unsolvedCells ASC, totalCandidates ASC):
  - Name
  - Source
  - Type (killer / classic)
  - Unsolved cells
  - Total candidates
  - Image (filename only, shown if `imagePath` is present — informational, not a link)
- Clicking a row fetches the full fixture JSON, calls `loadSpecDirect(spec)` from `web/src/session/actions.ts`, and transitions directly to the solution screen — bypassing the image pipeline and review steps entirely

### Load path

`loadSpecDirect(spec)` already exists and builds `PuzzleState` from a `PuzzleSpec`. The panel calls it directly. No changes to the session state machine are needed.

### Production safety

In the production build the Vite middleware is absent, so `/dev/stall-fixtures` returns a 404. The panel fetch must handle this gracefully — a non-OK response or network error silently renders nothing. The `?dev=1` URL parameter has no effect in production.

---

## Sub-project 3: Regression Test

`web/stall-fixtures/stall-fixtures-dir.test.ts`

For each `*.stall.json` in `web/stall-fixtures/`:

- Runs `solve(fixture.spec)` using the current rule set
- **Test passes** if `usedBacktracking === true` — the gap is still open; the fixture is still relevant
- **Test fails + auto-deletes the file** if `usedBacktracking === false` — a new rule closed this gap

Failure message: `"killer_sudoku_101 now solves without backtracking — fixture deleted. Commit the deletion."`

Auto-deletion on failure is intentional. When a developer adds a rule and runs tests, any fixtures the rule resolves are removed in the same step. The developer sees which fixtures were closed via `git diff` and commits the deletions.

If `web/stall-fixtures/` is empty, the test file emits a single passing no-op.

---

## Sub-project 4: Stress Test Enhancement

### Change to `web/e2e/stress.spec.ts`

The stress test already exposes `{ usedBacktracking, stalledCandidates }` via `window.__lastSolverResult`. Enhancement: when `usedBacktracking` is true, write a `<name>.stall.json` file **alongside the source image** in the puzzle directory.

Fields populated:
- `source` — derived from the puzzle directory name (e.g. `"guardian"`)
- `name` — image filename without extension (e.g. `"killer_sudoku_101"`)
- `imagePath` — repo-root-relative path to the image
- `spec` — reconstructed from `window.__lastSolverResult.specData` (already captured)
- `stalledCandidates`, `unsolvedCells`, `totalCandidates` — from solver result

### Copy step

A new `--copy-stalls <dest>` flag on `scripts/run-stress-test.sh` copies all `*.stall.json` files from the puzzle directory into `web/stall-fixtures/` after the run. Existing files with the same name are overwritten (the solver result is deterministic).

Usage:
```bash
bash scripts/run-stress-test.sh guardian/ 4 --copy-stalls web/stall-fixtures
```

The copy step is optional — omitting it leaves the stall files in the puzzle directory for inspection without modifying the repo.

---

## Sub-project 5: R2 Workflow

### Trigger

`workflow_dispatch` only (manual). No automatic schedule — R2 puzzle-spec uploads require human review before becoming committed fixtures.

### New files

- `.github/workflows/puzzle-spec-review.yml` — the workflow
- `web/scripts/check-puzzle-specs.ts` — TypeScript solver check script, run via `npx vite-node`

### Workflow steps

1. **Checkout** repo
2. **Install Node deps** — `cd web && npm ci`
3. **Install Python deps** — `pip install boto3`
4. **List** `puzzle-spec/` objects in R2 — `python3 scripts/_r2_list.py cagedoku-training puzzle-spec/ > /tmp/r2_keys.txt`; exit early if empty
5. **Download** to `/tmp/puzzle-specs/` — `python3 scripts/_r2_download.py cagedoku-training /tmp/puzzle-specs/ < /tmp/r2_keys.txt`
6. **Check** — `npx vite-node web/scripts/check-puzzle-specs.ts /tmp/puzzle-specs/ /tmp/stall-out/`
   - For each downloaded JSON: runs `solve(spec)`, writes `<name>.stall.json` to `/tmp/stall-out/` if `usedBacktracking === true`, logs a skip message if now solved
7. **Copy fixtures** — copy any `*.stall.json` from `/tmp/stall-out/` into `web/stall-fixtures/`; skip if directory is empty
8. **Commit** — if any fixtures were added, commit with message `chore: add stall fixtures from R2 puzzle-spec uploads`
9. **Push** — `git pull --rebase && git push`
10. **Delete** processed R2 objects — `python3 scripts/_r2_delete.py cagedoku-training < /tmp/r2_keys.txt`

R2 objects are always deleted regardless of whether the puzzle stalled — once downloaded and checked, the spec is no longer needed in R2.

### `web/scripts/check-puzzle-specs.ts`

CLI: `check-puzzle-specs.ts <input-dir> <output-dir>`

- Reads every `*.json` from `<input-dir>`
- Validates the shape matches `PuzzleSpecExport` (version 2, puzzleType killer)
- Runs `solve(spec)` via the engine
- If `usedBacktracking`: writes a `StallFixtureFile` JSON to `<output-dir>/<name>.stall.json`
  - `name` derived from R2 key date prefix (e.g. `r2-2026-05-24-<uuid-prefix>`)
  - `source: "r2"`, `imagePath` omitted
- If solved cleanly: logs `"<name>: now solves without backtracking — skipping"`

---

## Implementation Order

1. `StallFixtureFile` type (`web/src/engine/rules/stallFixtureFile.ts`)
2. Vite middleware + app panel (`vite.config.ts`, `web/src/main.ts`)
3. Regression test (`web/stall-fixtures/stall-fixtures-dir.test.ts`)
4. Stress test enhancement (`web/e2e/stress.spec.ts`, `scripts/run-stress-test.sh`)
5. R2 workflow (`.github/workflows/puzzle-spec-review.yml`, `web/scripts/check-puzzle-specs.ts`)
