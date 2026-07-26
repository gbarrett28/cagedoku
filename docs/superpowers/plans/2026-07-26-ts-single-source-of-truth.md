# TS Single Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every independently-reimplemented copy of production
image/digit-recognition logic in Python by routing all of it through the real
TypeScript implementation — via a new Node-callable bridge for pure-math
operations, and a generalized corpus cache for anything that needs OpenCV/WASM.

**Architecture:** `web/scripts/ts-bridge.ts` is a thin CLI wrapper importing
directly from `numberRecognition.ts`/`holeFeatures.ts` (no reimplementation).
A generalized `cell_reads` table (was `given_digit_reads`) plus new columns on
`evaluations` cache every crop, feature vector, prediction, and border/cage
structure the browser produces during a full, Playwright-driven corpus walk.
Every Python call site that currently reimplements crop extraction, feature
extraction, or classification is migrated to read the cache or call the bridge.

**Tech Stack:** TypeScript (Node via `npx tsx`), Python 3.12, `better-sqlite3`
(existing), `subprocess` (Python stdlib).

## Global Constraints

- No silent fallback to a Python reimplementation, ever — cache miss or
  bridge failure is a hard error, never a quiet drop into approximate logic.
- Batch, don't loop — every bridge call takes many crops per invocation.
- Cache rows are keyed by `(puzzle_hash, git_hash)` (plus `row`/`col`/
  `digit_index` for `cell_reads`); a code change is a new commit, hence a new
  `git_hash`, hence fresh rows — no separate invalidation scheme.
- `scikit-learn`'s `SVC.fit()`/`PCA.fit()`, the numba dithering kernel,
  `balanced_split`, and corpus-walk orchestration stay Python — never move,
  never get reimplemented in TS.
- Serena MCP tools for all `.ts`/`.py` reads and edits (per this repo's
  `CLAUDE.md`).
- Bronze gate (`bash scripts/run-bronze-gate.sh`) before every commit.

---

### Task 1: Export `hogExtract`, add `ts-bridge.ts`'s `extract-features` op

**Files:**
- Modify: `web/src/image/numberRecognition.ts:341` (add `export` to `hogExtract`)
- Create: `web/scripts/ts-bridge.ts`
- Test: `web/scripts/ts-bridge.test.ts`

**Interfaces:**
- Consumes: `hogExtract(imgs: Uint8Array[], params: HOGParams): Float64Array`
  (now exported), `extractHoleFeatures(imgs: Uint8Array[], winSize: number): Float64Array`
  (already exported), `HOGParams` (already exported).
- Produces: a CLI, `npx tsx web/scripts/ts-bridge.ts --op extract-features
  [--input <path>] [--output <path>]`. Reads JSON from stdin (or `--input`
  file) shaped `{ crops: number[][] }` where each inner array is a flattened
  64×64 crop (0-255 grayscale ink=white/background=black, matching the
  existing `crop_pixels` convention). Writes JSON to stdout (or `--output`
  file) shaped `{ hog: number[][], hole: number[][] }` — one row per input
  crop, `hog` rows length 1764, `hole` rows length 5. Later tasks' `predict`
  op is added to the same file in Task 2.

- [ ] **Step 1: Export `hogExtract`**

In `web/src/image/numberRecognition.ts`, change line 341 from:
```ts
function hogExtract(imgs: Uint8Array[], params: HOGParams): Float64Array {
```
to:
```ts
export function hogExtract(imgs: Uint8Array[], params: HOGParams): Float64Array {
```

- [ ] **Step 2: Run existing tests to confirm the export doesn't break anything**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts`
Expected: all 7 tests still pass (this is a pure visibility change, no
behavior change).

- [ ] **Step 3: Write the failing test for the bridge script**

Create `web/scripts/ts-bridge.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BRIDGE = path.resolve(__dirname, 'ts-bridge.ts');

function runBridge(args: string[], stdin: string): string {
  return execFileSync('npx', ['tsx', BRIDGE, ...args], {
    input: stdin,
    encoding: 'utf-8',
  });
}

describe('ts-bridge --op extract-features', () => {
  it('returns HOG and hole feature vectors of the expected length, one row per crop', () => {
    const blank = new Array(64 * 64).fill(0);
    const payload = JSON.stringify({ crops: [blank, blank] });
    const out = runBridge(['--op', 'extract-features'], payload);
    const parsed = JSON.parse(out) as { hog: number[][]; hole: number[][] };
    expect(parsed.hog).toHaveLength(2);
    expect(parsed.hog[0]).toHaveLength(1764);
    expect(parsed.hole).toHaveLength(2);
    expect(parsed.hole[0]).toHaveLength(5);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd web && npx vitest run scripts/ts-bridge.test.ts`
Expected: FAIL — `ts-bridge.ts` does not exist yet.

- [ ] **Step 5: Write `ts-bridge.ts`**

Create `web/scripts/ts-bridge.ts`:
```ts
import fs from 'node:fs';
import { hogExtract, extractHoleFeatures } from '../src/image/numberRecognition.js';
import type { HOGParams } from '../src/image/numberRecognition.js';

const HOG_PARAMS: HOGParams = {
  winSize: 64, cellSize: 8, blockSize: 16, blockStride: 8, nbins: 9,
};

interface Args {
  op: string;
  input: string | null;
  output: string | null;
}

function parseArgs(argv: string[]): Args {
  let op = '';
  let input: string | null = null;
  let output: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--op') op = argv[++i]!;
    else if (argv[i] === '--input') input = argv[++i]!;
    else if (argv[i] === '--output') output = argv[++i]!;
  }
  if (!op) throw new Error('--op is required (extract-features | predict)');
  return { op, input, output };
}

function readPayload(inputPath: string | null): string {
  if (inputPath) return fs.readFileSync(inputPath, 'utf-8');
  return fs.readFileSync(0, 'utf-8'); // fd 0 = stdin
}

function writeResult(outputPath: string | null, json: string): void {
  if (outputPath) fs.writeFileSync(outputPath, json);
  else process.stdout.write(json);
}

function toUint8Crops(crops: number[][]): Uint8Array[] {
  return crops.map(c => Uint8Array.from(c));
}

function runExtractFeatures(payload: { crops: number[][] }): string {
  const imgs = toUint8Crops(payload.crops);
  const hogFeat = hogExtract(imgs, HOG_PARAMS);
  const holeFeat = extractHoleFeatures(imgs, HOG_PARAMS.winSize);
  const nHog = hogFeat.length / imgs.length;
  const nHole = holeFeat.length / imgs.length;
  const hog: number[][] = [];
  const hole: number[][] = [];
  for (let i = 0; i < imgs.length; i++) {
    hog.push(Array.from(hogFeat.subarray(i * nHog, (i + 1) * nHog)));
    hole.push(Array.from(holeFeat.subarray(i * nHole, (i + 1) * nHole)));
  }
  return JSON.stringify({ hog, hole });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const payload = JSON.parse(readPayload(args.input));
  let result: string;
  if (args.op === 'extract-features') {
    result = runExtractFeatures(payload);
  } else {
    throw new Error(`unknown --op '${args.op}' (predict is added in Task 2)`);
  }
  writeResult(args.output, result);
}

main();
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd web && npx vitest run scripts/ts-bridge.test.ts`
Expected: PASS

- [ ] **Step 7: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add web/src/image/numberRecognition.ts web/scripts/ts-bridge.ts web/scripts/ts-bridge.test.ts
git commit -m "feat: add ts-bridge.ts extract-features op, export hogExtract"
```

---

### Task 2: `ts-bridge.ts`'s `predict` op

**Files:**
- Modify: `web/scripts/ts-bridge.ts`
- Modify: `web/scripts/ts-bridge.test.ts`

**Interfaces:**
- Consumes: `loadNumRecogniser(binBuffer: ArrayBuffer, manifestJson): NumRecogniser`
  (exported, `numberRecognition.ts:488`), `NumRecogniser.recognise(imgs:
  Uint8Array[]): Recognition[]` (exported abstract method), `Recognition`
  interface (`{ label: number; confident: boolean; runnerUp?: { label:
  number; score: number } }`, exported).
- Produces: `npx tsx web/scripts/ts-bridge.ts --op predict --model-bin
  <path> --model-json <path> [--input <path>] [--output <path>]`. Same
  `{ crops: number[][] }` input shape as Task 1. Output:
  `{ predictions: Array<{ label: number; confident: boolean; runnerUp:
  { label: number; score: number } | null }> }`, one entry per crop.

- [ ] **Step 1: Write the failing test**

Add to `web/scripts/ts-bridge.test.ts`:
```ts
describe('ts-bridge --op predict', () => {
  it('returns a prediction per crop using the currently deployed model', () => {
    const blank = new Array(64 * 64).fill(0);
    const payload = JSON.stringify({ crops: [blank] });
    const out = runBridge(
      ['--op', 'predict',
       '--model-bin', path.resolve(__dirname, '../public/num_recogniser.bin'),
       '--model-json', path.resolve(__dirname, '../public/num_recogniser.json')],
      payload,
    );
    const parsed = JSON.parse(out) as { predictions: Array<{ label: number; confident: boolean }> };
    expect(parsed.predictions).toHaveLength(1);
    expect(typeof parsed.predictions[0]!.label).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run scripts/ts-bridge.test.ts`
Expected: FAIL — `--op predict` not implemented (throws "unknown --op").

- [ ] **Step 3: Implement the predict op**

In `web/scripts/ts-bridge.ts`, add the import and function, and wire it into
`main()`:
```ts
import { loadNumRecogniser } from '../src/image/numberRecognition.js';
```

Add alongside `runExtractFeatures`:
```ts
function runPredict(
  payload: { crops: number[][] },
  modelBinPath: string,
  modelJsonPath: string,
): string {
  const binBuffer = fs.readFileSync(modelBinPath).buffer;
  const manifestJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8'));
  const recogniser = loadNumRecogniser(binBuffer, manifestJson);
  const imgs = toUint8Crops(payload.crops);
  const recognitions = recogniser.recognise(imgs);
  return JSON.stringify({
    predictions: recognitions.map(r => ({
      label: r.label,
      confident: r.confident,
      runnerUp: r.runnerUp ?? null,
    })),
  });
}
```

Update `parseArgs` to also capture `--model-bin`/`--model-json`:
```ts
interface Args {
  op: string;
  input: string | null;
  output: string | null;
  modelBin: string | null;
  modelJson: string | null;
}
```
Add to the `parseArgs` loop:
```ts
    else if (argv[i] === '--model-bin') modelBin = argv[++i]!;
    else if (argv[i] === '--model-json') modelJson = argv[++i]!;
```
(declare `let modelBin: string | null = null;` / `let modelJson: string | null = null;`
alongside `input`/`output`, and return them in the final object.)

Update `main()`:
```ts
  } else if (args.op === 'predict') {
    if (!args.modelBin || !args.modelJson) {
      throw new Error('--op predict requires --model-bin and --model-json');
    }
    result = runPredict(payload, args.modelBin, args.modelJson);
  } else {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run scripts/ts-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add web/scripts/ts-bridge.ts web/scripts/ts-bridge.test.ts
git commit -m "feat: add ts-bridge.ts predict op"
```

---

### Task 3: `killer_sudoku/training/ts_bridge.py`

**Files:**
- Create: `killer_sudoku/training/ts_bridge.py`
- Test: `tests/test_ts_bridge.py`

**Interfaces:**
- Consumes: `web/scripts/ts-bridge.ts` (Tasks 1-2, via `npx tsx`).
- Produces:
  `extract_features(crops: list[npt.NDArray[np.uint8]]) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]`
  (returns `(hog, hole)` arrays, shapes `(n, 1764)` and `(n, 5)`).
  `predict(crops: list[npt.NDArray[np.uint8]], model_bin: Path, model_json: Path) -> list[dict[str, Any]]`
  (returns one dict per crop: `{"label": int, "confident": bool, "runnerUp": dict | None}`).
  Both batch — one subprocess call per function call, regardless of crop count.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_ts_bridge.py`:
```python
import numpy as np
from pathlib import Path

from killer_sudoku.training.ts_bridge import extract_features, predict


def test_extract_features_returns_correct_shapes():
    crops = [np.zeros((64, 64), dtype=np.uint8), np.zeros((64, 64), dtype=np.uint8)]
    hog, hole = extract_features(crops)
    assert hog.shape == (2, 1764)
    assert hole.shape == (2, 5)


def test_predict_returns_one_result_per_crop():
    crops = [np.zeros((64, 64), dtype=np.uint8)]
    results = predict(
        crops,
        Path("web/public/num_recogniser.bin"),
        Path("web/public/num_recogniser.json"),
    )
    assert len(results) == 1
    assert isinstance(results[0]["label"], int)
    assert isinstance(results[0]["confident"], bool)


def test_predict_surfaces_bridge_failure_as_an_error():
    crops = [np.zeros((64, 64), dtype=np.uint8)]
    try:
        predict(crops, Path("does/not/exist.bin"), Path("does/not/exist.json"))
        raised = False
    except RuntimeError:
        raised = True
    assert raised, "predict() must raise, never silently fall back"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_ts_bridge.py -v`
Expected: FAIL — `killer_sudoku.training.ts_bridge` does not exist.

- [ ] **Step 3: Write `ts_bridge.py`**

Create `killer_sudoku/training/ts_bridge.py`:
```python
"""Thin Python wrapper around web/scripts/ts-bridge.ts.

Every function here shells out to the real TypeScript implementation rather
than reimplementing feature extraction or classification in Python -- see
docs/superpowers/specs/2026-07-26-ts-single-source-of-truth-design.md.
Failure (bad exit code, unparseable output) always raises; there is
deliberately no fallback path.
"""
import json
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BRIDGE_SCRIPT = _REPO_ROOT / "web" / "scripts" / "ts-bridge.ts"


def _run_bridge(op: str, payload: dict[str, Any], extra_args: list[str] | None = None) -> dict[str, Any]:
    args = ["npx", "tsx", str(_BRIDGE_SCRIPT), "--op", op, *(extra_args or [])]
    result = subprocess.run(
        args,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=_REPO_ROOT / "web",
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ts-bridge --op {op} failed (exit {result.returncode}): {result.stderr}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"ts-bridge --op {op} produced unparseable output: {result.stdout!r}"
        ) from exc


def extract_features(
    crops: list[npt.NDArray[np.uint8]],
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    payload = {"crops": [c.flatten().tolist() for c in crops]}
    out = _run_bridge("extract-features", payload)
    hog = np.array(out["hog"], dtype=np.float64)
    hole = np.array(out["hole"], dtype=np.float64)
    return hog, hole


def predict(
    crops: list[npt.NDArray[np.uint8]], model_bin: Path, model_json: Path,
) -> list[dict[str, Any]]:
    payload = {"crops": [c.flatten().tolist() for c in crops]}
    out = _run_bridge(
        "predict", payload,
        extra_args=["--model-bin", str(model_bin), "--model-json", str(model_json)],
    )
    return out["predictions"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_ts_bridge.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add killer_sudoku/training/ts_bridge.py tests/test_ts_bridge.py
git commit -m "feat: add ts_bridge.py Python wrapper around ts-bridge.ts"
```

---

### Task 4: Generalize `given_digit_reads` into `cell_reads`; add structure columns to `evaluations`

**Files:**
- Modify: `web/scripts/corpus-db.ts`
- Modify: `web/scripts/corpus-db.test.ts`

**Interfaces:**
- Produces: `CellReadRow` interface — `{ puzzleHash: string; gitHash: string;
  cellType: 'given_digit' | 'cage_total_digit'; row: number; col: number;
  digitIndex: number; predictedLabel: number; confident: boolean;
  clashesWith: ReadonlyArray<{ row: number; col: number }>; cropPixels:
  number[]; hogFeatures: number[]; holeFeatures: number[] }`.
  `insertCellRead(db, r: CellReadRow): void`.
  `evaluations` table gains `border_x`, `border_y`, `cage_totals` TEXT
  (JSON) columns, nullable (classic puzzles or older rows may not have them).

- [ ] **Step 1: Write the failing tests**

In `web/scripts/corpus-db.test.ts`, add:
```ts
describe('cell_reads (generalized from given_digit_reads)', () => {
  it('creates the cell_reads table with cell_type support', () => {
    const db = tmpDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map(r => r.name).filter(n => !n.startsWith('sqlite_'));
    expect(names).toContain('cell_reads');
    db.close();
  });

  it('inserts and reads back a cage-total-digit row', () => {
    const db = tmpDb();
    insertPuzzle(db, { contentHash: 'p1', path: '/x.jpg', corpus: 'guardian' });
    insertCellRead(db, {
      puzzleHash: 'p1', gitHash: 'h1', cellType: 'cage_total_digit',
      row: 0, col: 0, digitIndex: 1, predictedLabel: 6, confident: true,
      clashesWith: [], cropPixels: [0, 1], hogFeatures: [0.1], holeFeatures: [0.2],
    });
    const row = db.prepare('SELECT * FROM cell_reads WHERE puzzle_hash = ?').get('p1') as any;
    expect(row.cell_type).toBe('cage_total_digit');
    expect(row.digit_index).toBe(1);
    expect(JSON.parse(row.hog_features)).toEqual([0.1]);
    db.close();
  });
});

describe('evaluations border/cage-total structure columns', () => {
  it('adds border_x, border_y, cage_totals columns', () => {
    const db = tmpDb();
    const cols = (db.prepare('PRAGMA table_info(evaluations)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['border_x', 'border_y', 'cage_totals']));
    db.close();
  });
});
```
(`insertPuzzle`/`tmpDb` already exist in this test file per the existing
`describe('openDb', ...)` block — reuse them, don't redefine.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run scripts/corpus-db.test.ts`
Expected: FAIL — `cell_reads` table and `insertCellRead` don't exist yet.

- [ ] **Step 3: Rename the table and extend the schema**

In `web/scripts/corpus-db.ts`, replace the `given_digit_reads` table
definition inside `openDb`'s `CREATE TABLE` block with:
```sql
    CREATE TABLE IF NOT EXISTS cell_reads (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      puzzle_hash           TEXT NOT NULL REFERENCES puzzles(content_hash),
      git_hash              TEXT NOT NULL,
      cell_type             TEXT NOT NULL, -- 'given_digit' | 'cage_total_digit'
      row                   INTEGER NOT NULL,
      col                   INTEGER NOT NULL,
      digit_index           INTEGER NOT NULL DEFAULT 0,
      predicted_label       INTEGER NOT NULL,
      confident             INTEGER NOT NULL, -- 0/1
      clashes_with          TEXT NOT NULL, -- JSON array of {row,col}, [] if none
      crop_pixels           TEXT NOT NULL, -- JSON array, flattened 64x64
      hog_features          TEXT NOT NULL, -- JSON array, 1764 floats
      hole_features         TEXT NOT NULL, -- JSON array, 5 floats
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
```
Add to the migrations section (after the existing `newCols` loop for
`evaluations`):
```ts
  for (const [col, type] of [['border_x', 'TEXT'], ['border_y', 'TEXT'], ['cage_totals', 'TEXT']] as const) {
    if (!evalCols.includes(col)) {
      db.exec(`ALTER TABLE evaluations ADD COLUMN ${col} ${type}`);
    }
  }
```
Replace the `GivenDigitReadRow` interface and `insertGivenDigitRead` function
with:
```ts
export interface CellReadRow {
  puzzleHash: string;
  gitHash: string;
  cellType: 'given_digit' | 'cage_total_digit';
  row: number;
  col: number;
  digitIndex: number;
  predictedLabel: number;
  confident: boolean;
  clashesWith: ReadonlyArray<{ row: number; col: number }>;
  cropPixels: number[];
  hogFeatures: number[];
  holeFeatures: number[];
}

export function insertCellRead(db: Database.Database, r: CellReadRow): void {
  db.prepare(`
    INSERT INTO cell_reads
      (puzzle_hash, git_hash, cell_type, row, col, digit_index, predicted_label,
       confident, clashes_with, crop_pixels, hog_features, hole_features)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.puzzleHash, r.gitHash, r.cellType, r.row, r.col, r.digitIndex,
    r.predictedLabel, r.confident ? 1 : 0,
    JSON.stringify(r.clashesWith), JSON.stringify(r.cropPixels),
    JSON.stringify(r.hogFeatures), JSON.stringify(r.holeFeatures),
  );
}
```

- [ ] **Step 4: Update `evaluate-corpus.ts` for the rename**

In `web/scripts/evaluate-corpus.ts`, update the import and the insert loop
that previously called `insertGivenDigitRead` (added when `given_digit_reads`
was first built) to call `insertCellRead` instead, with `cellType:
'given_digit'`, `digitIndex: 0`, and `hogFeatures`/`holeFeatures` populated
from the outcome payload (added to `UploadOutcomeJson`/`main.ts`'s
`givenDigitReads` field in Task 5, alongside the cache-population work —
until then, pass `[]` for both feature arrays so existing behavior is
preserved without a hard dependency ordering issue).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run scripts/corpus-db.test.ts`
Expected: PASS

- [ ] **Step 6: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add web/scripts/corpus-db.ts web/scripts/corpus-db.test.ts web/scripts/evaluate-corpus.ts
git commit -m "feat: generalize given_digit_reads into cell_reads, add evaluations structure columns"
```

---

### Task 5: Cache-population script (full corpus, every cell, every puzzle type)

**Files:**
- Create: `web/scripts/populate-cell-cache.ts`
- Test: `web/scripts/populate-cell-cache.test.ts`
- Modify: `web/src/main.ts` (extend the `givenDigitReads` outcome payload with
  `hogFeatures`/`holeFeatures`, and add an analogous `cageTotalReads` payload
  for killer puzzles, plus `borderX`/`borderY`/`cageTotals` structure fields)

**Interfaces:**
- Consumes: `claimEvaluation`/`completeEvaluation`/`insertCellRead`
  (`corpus-db.ts`), `makeWarmPage` (`evaluate-corpus.ts` — export it if not
  already exported, for reuse here).
- Produces: a runnable script, `npx tsx web/scripts/populate-cell-cache.ts
  --git-hash <hash> [--filter <sql>] [--limit N]`, that walks every puzzle in
  the `puzzles` table (not just previously-flagged ones), uploads each to a
  live preview-server-backed browser page exactly as `evaluate-corpus.ts`
  does, and persists every given-digit cell, every cage-total digit, and the
  puzzle's border/cage-total structure into `cell_reads`/`evaluations`.

- [ ] **Step 1: Extend `main.ts`'s outcome payload with feature vectors and cage-total reads**

This step's exact diff depends on reading the current state of
`handleProcess`'s killer-path branch (`web/src/main.ts`, the block building
`cageTotals`/`selectedNumbers` around where `buildCageTotals`/`includeTree`
are used) and `buildGivenDigitReads` (`web/src/engine/retrainingSuggestions.ts`,
Task from the given-digit-reads work earlier this session). Before writing
code: read both with serena's `find_symbol` to confirm current signatures,
since this file has been touched multiple times this session and may have
shifted line numbers.

The shape to add to `buildGivenDigitReads`'s return type and the killer-path
cage-total equivalent: `hogFeatures: number[]` and `holeFeatures: number[]`
per read, computed via the already-exported `hogExtract`/`extractHoleFeatures`
(Task 1) called directly in `main.ts` (in-browser, same as `ts-bridge.ts`
does in Node — same functions, two entry points, per the design's core
principle).

- [ ] **Step 2: Write the failing test for the population script**

Create `web/scripts/populate-cell-cache.test.ts` following the existing
pattern in `evaluate-corpus.test.ts` (check that file first for the
established test-harness style — it stubs the DB and a fake page rather than
running a real browser, for speed).

- [ ] **Step 3: Implement `populate-cell-cache.ts`**

Base it on `evaluate-corpus.ts`'s `runWorker`/`main` structure: same
claim-and-complete loop pattern, but reading from a query that selects every
row in `puzzles` (optionally filtered) rather than only unevaluated-under-
this-git-hash ones, and inserting into `cell_reads` for every given-digit and
cage-total-digit cell the page reports, plus `evaluations.border_x`/
`border_y`/`cage_totals` for the puzzle's structure.

- [ ] **Step 4: Run the test suite**

Run: `cd web && npx vitest run scripts/populate-cell-cache.test.ts`
Expected: PASS

- [ ] **Step 5: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add web/src/main.ts web/src/engine/retrainingSuggestions.ts web/scripts/populate-cell-cache.ts web/scripts/populate-cell-cache.test.ts
git commit -m "feat: add full-corpus cache-population script covering every cell and puzzle type"
```

---

### Task 6: Migrate `review_low_confidence.py` to the cache/bridge

**Files:**
- Modify: `killer_sudoku/training/review_low_confidence.py`
- Modify: `tests/test_review_low_confidence.py`

**Interfaces:**
- Consumes: `killer_sudoku.training.ts_bridge.predict` (Task 3), `cell_reads`
  table (Task 4, queried directly via `sqlite3`).
- Produces: `_classic_puzzles_from_flagged` and `_make_current_hog_recogniser`
  are removed; callers instead query `cell_reads` by `puzzle_hash` for
  already-cached crops/predictions, or call `ts_bridge.predict()` directly
  when scoring against a model other than the one already cached (e.g. a
  freshly-refit candidate).

- [ ] **Step 1: Read the current file in full**

Before changing anything: `find_symbol` on every function in
`review_low_confidence.py` that calls `_make_current_hog_recogniser` or
`_classic_puzzles_from_flagged`, to enumerate every call site precisely (this
file has grown across the session and the exact current call graph needs
verifying, not assumed from memory).

- [ ] **Step 2: Update or remove the tests exercising the retired functions**

`tests/test_review_low_confidence.py` — any test constructing an `InpImage`-
backed puzzle fixture to exercise `_classic_puzzles_from_flagged` gets
replaced with a test that inserts rows directly into a `cell_reads` fixture
DB and asserts the (new) cache-reading function returns them correctly.

- [ ] **Step 3: Implement the migration**

Replace `_make_current_hog_recogniser`/`_classic_puzzles_from_flagged` with a
function that queries `cell_reads` for a given `puzzle_hash`/`git_hash` and
reconstructs whatever `ReviewCandidate`/`ScoredCandidate` shape the rest of
the file's `--mode duplicates`/`--mode confidence` logic expects — those
downstream consumers (`crops_from_duplicate_conflicts`, `score_candidates`,
etc.) keep their existing signatures; only the crop/prediction *source*
changes.

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_review_low_confidence.py -v`
Expected: PASS

- [ ] **Step 5: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add killer_sudoku/training/review_low_confidence.py tests/test_review_low_confidence.py
git commit -m "refactor: read cell_reads cache instead of re-deriving crops in review_low_confidence.py"
```

---

### Task 7: Migrate `agreement_pool.py`'s `_make_hog_recogniser()`

**Files:**
- Modify: `killer_sudoku/training/agreement_pool.py`
- Modify: `tests/test_agreement_pool.py` (or equivalent — confirm exact
  filename with `Glob` before editing)

**Interfaces:**
- Consumes: `killer_sudoku.training.ts_bridge.predict` (Task 3).
- Produces: `_make_hog_recogniser()` (currently returns a `HogNumber`,
  `agreement_pool.py:49`) is removed. Its one caller inside
  `build_agreement_pool` calls `ts_bridge.predict(crops,
  Path("killer_sudoku/data/hog_recogniser_99cbb70.bin"),
  Path("killer_sudoku/data/hog_recogniser_99cbb70.json"))` instead of
  `HogNumber.get_sums(nums)`.

- [ ] **Step 1: Find every call site of `_make_hog_recogniser`**

`find_referencing_symbols` on `_make_hog_recogniser` in `agreement_pool.py`
— confirm it's only called from within `build_agreement_pool` before
editing (per the earlier read this session, it appeared to be a single call
site, but confirm rather than assume).

- [ ] **Step 2: Replace the call**

Wherever `build_agreement_pool` currently does something like
`recogniser = _make_hog_recogniser(); ... recogniser.get_sums(crops)`,
replace with a direct `ts_bridge.predict(crops, Path("killer_sudoku/data/hog_recogniser_99cbb70.bin"), Path("killer_sudoku/data/hog_recogniser_99cbb70.json"))`
call, then map the returned `label` fields back into whatever integer-array
shape `get_sums` previously returned (check its return type — `npt.NDArray[np.intp]`
per `HogNumber.get_sums`'s signature — so wrap: `np.array([r["label"] for r in predict(...)], dtype=np.intp)`).

- [ ] **Step 3: Remove `_make_hog_recogniser` and its now-unused imports**

Delete the function; remove `load_hog_classifier`/`HogRecogniser`/`HogNumber`
imports from `agreement_pool.py` if nothing else in the file still uses them
(check with `find_referencing_symbols` first).

- [ ] **Step 4: Run tests**

Run: `pytest tests/ -k agreement_pool -v`
Expected: PASS, same behavior as before (frozen-checkpoint cross-checking
still works, now via the bridge instead of a Python-side classifier
reconstruction).

- [ ] **Step 5: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add killer_sudoku/training/agreement_pool.py tests/
git commit -m "refactor: agreement_pool cross-checking calls ts_bridge instead of reconstructing a Python classifier"
```

---

### Task 8: Migrate `web/train_recogniser.py`'s HOG/hole extraction

**Files:**
- Modify: `web/train_recogniser.py`
- Modify: `tests/test_train_recogniser.py`

**Interfaces:**
- Consumes: `cell_reads.hog_features`/`hole_features` (Task 4, for real
  corpus crops); `killer_sudoku.training.ts_bridge.extract_features` (Task 3,
  for dithered synthetic variants, which can't be pre-cached).
- Produces: `HogRecogniser.extract_features` (currently
  `np.hstack([extract_hog(imgs), extract_hole_features(imgs)])`) is replaced
  — real-corpus samples read cached features directly; only the dithered
  variants generated at training time still call into feature extraction,
  now via `ts_bridge.extract_features` rather than the numba kernels
  `extract_hog`/`extract_hole_features`.

- [ ] **Step 1: Confirm the current call graph**

`find_referencing_symbols` on `extract_hog` and `extract_hole_features` in
`web/train_recogniser.py` — this file is large and has several entry points
(`main()`'s CLI path, `build_dataset`, `HogRecogniser.extract_features`);
enumerate all of them before editing.

- [ ] **Step 2: Split the "real crop" and "dithered variant" paths**

Training's `train`/`holdout` lists (from `balanced_split`) are real corpus
crops — for these, features should come from `cell_reads` (joined by
`sample_key`/crop identity) rather than recomputed. `dither_batch`'s output
(the augmented variants) has no cache entry — call
`ts_bridge.extract_features(dithered_imgs)` for those, batched once per
training run.

- [ ] **Step 3: Remove the numba HOG/hole kernels once nothing calls them**

After confirming (via `find_referencing_symbols`) that `extract_hog`,
`extract_hole_features`, `_extract_hog_numba`, `_extract_hole_numba` have no
remaining callers, delete them along with their numba imports.

- [ ] **Step 4: Update tests**

`tests/test_train_recogniser.py`'s `build_dataset`-based tests
(`test_train_recogniser.py:40,58,92` per this session's earlier read) need
updating to reflect that feature extraction for real samples comes from a
cache fixture, not a live numba call — mock `cell_reads` lookups the same
way Task 6/7's tests mock the cache.

- [ ] **Step 5: Run tests**

Run: `pytest tests/test_train_recogniser.py -v`
Expected: PASS

- [ ] **Step 6: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add web/train_recogniser.py tests/test_train_recogniser.py
git commit -m "refactor: train_recogniser.py reads cached features for real crops, calls ts_bridge for dithered variants"
```

---

### Task 9: Retire `grid_location.py` and `inp_image.py`'s grid/border logic

**Files:**
- Modify: `killer_sudoku/image/inp_image.py`
- Delete: `killer_sudoku/image/grid_location.py` (after confirming no
  remaining callers)
- Modify: any test files covering the deleted paths (find via `Glob` +
  `find_referencing_symbols` before editing — do not assume filenames)

**Interfaces:**
- Consumes: `cell_reads` + `evaluations.border_x`/`border_y`/`cage_totals`
  (Task 4/5) queried by `puzzle_hash`.
- Produces: `InpImage.__init__` no longer calls `locate_grid`,
  `_identify_borders`, `_build_cage_totals`, or `read_classic_digits` for
  puzzles already present in the cache — it queries the cache instead. For
  puzzles NOT yet in the cache (a genuinely new corpus image), this is a hard
  error per the Global Constraints ("cache miss is a hard error"), directing
  the caller to run `populate-cell-cache.ts` first — not a fallback to the
  Python pipeline being removed.

- [ ] **Step 1: Enumerate every caller of `InpImage`**

`find_referencing_symbols` on the `InpImage` class across the whole repo —
this is the highest-fan-in file in the migration (used by `agreement_pool.py`,
`review_low_confidence.py`, `digit_rects.py`, and possibly others found this
session). Confirm the full list before touching `InpImage.__init__`, since
every caller's expectations about `self.info`, `self.warped_blk`, `self.spec`
etc. need to keep working against cache-sourced data.

- [ ] **Step 2: Replace the pipeline calls in `InpImage.__init__` with cache reads**

Given the fan-in, this is the highest-risk single task in the plan — do it
with the full test suite run after each sub-change, not just at the end.

- [ ] **Step 3: Delete `grid_location.py` once nothing references it**

Confirm via `find_referencing_symbols` on `locate_grid` first.

- [ ] **Step 4: Run the full test suite**

Run: `pytest tests/ -v`
Expected: PASS — this task has the widest blast radius, so a full run (not a
scoped `-k` filter) is required here specifically.

- [ ] **Step 5: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add killer_sudoku/image/inp_image.py
git rm killer_sudoku/image/grid_location.py
git commit -m "refactor: InpImage reads grid/border/crop data from the cell_reads cache instead of re-deriving it"
```

---

### Task 10: Retire `digit_rects.py`

**Files:**
- Delete: `killer_sudoku/training/digit_rects.py` (after confirming no
  remaining callers post-Task 9)
- Modify: any test files covering it

**Interfaces:**
- Consumes: nothing new — by this point `cell_reads` already carries
  pre-computed crops for every cell.

- [ ] **Step 1: Confirm no remaining callers**

`find_referencing_symbols` on `locate_classic_digit_rects` — expect it to
already be unused after Task 9's `InpImage` migration; if something else
still calls it, migrate that caller first (don't delete out from under it).

- [ ] **Step 2: Delete the file and its tests**

- [ ] **Step 3: Run the full test suite**

Run: `pytest tests/ -v`
Expected: PASS

- [ ] **Step 4: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git rm killer_sudoku/training/digit_rects.py
git commit -m "chore: remove digit_rects.py, superseded by cell_reads cache"
```

---

### Task 11: Retire `number_recognition.py`'s `RBFClassifier` and `hog_model_loader.py`

**Files:**
- Modify or delete: `killer_sudoku/image/number_recognition.py`
- Modify or delete: `killer_sudoku/training/hog_model_loader.py`
- Modify: `tests/test_hog_model_loader.py`

**Interfaces:**
- Consumes: `killer_sudoku.training.ts_bridge.predict` (Task 3) — the sole
  remaining way to answer "what does this model predict for this crop" in
  Python.
- Produces: any remaining caller of `RBFClassifier.predict`/`HogNumber`/
  `load_hog_classifier` (should be none, if Tasks 6, 7, 9 were done
  correctly) is migrated to `ts_bridge.predict`. `test_hog_model_loader.py`'s
  `test_recovered_hog_model_matches_documented_accuracy` — the one test
  giving real signal about loader correctness — gets rewritten against
  `ts_bridge.predict` instead of the Python `HogNumber` reconstruction, since
  that reconstruction is exactly what's being retired.

- [ ] **Step 1: Confirm no remaining callers**

`find_referencing_symbols` on `RBFClassifier`, `HogNumber`,
`load_hog_classifier` across the whole repo. By this point in the plan
(Tasks 6, 7, 9 done), expect zero remaining production callers — if any
turn up, that's a sign an earlier task's migration was incomplete; go back
and fix it there rather than patching around it here.

- [ ] **Step 2: Rewrite or remove the accuracy-check test**

Replace `test_recovered_hog_model_matches_documented_accuracy`'s use of
`HogNumber`/`load_hog_classifier` with a call to
`ts_bridge.predict(imgs, Path("web/public/num_recogniser.bin"),
Path("web/public/num_recogniser.json"))`, keeping the same `>= 0.95`
accuracy assertion against `web/browser_train.json`.

- [ ] **Step 3: Delete the retired code**

Remove `RBFClassifier`/`LinearOvOClassifier` from
`killer_sudoku/image/number_recognition.py` and `HogNumber`/
`load_hog_classifier` from `killer_sudoku/training/hog_model_loader.py` (or
delete the files entirely if nothing else in them is still used — check with
`get_symbols_overview` first).

- [ ] **Step 4: Run the full test suite**

Run: `pytest tests/ -v`
Expected: PASS

- [ ] **Step 5: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add -A
git commit -m "refactor: remove Python RBFClassifier/HogNumber, ts_bridge.predict is now the only way to classify a crop in Python"
```

---

## Final Verification

- [ ] **Full-repo grep for anything still importing the retired modules**

Run (from repo root):
```bash
python3 -c "
import subprocess
for mod in ['grid_location', 'digit_rects', 'hog_model_loader']:
    out = subprocess.run(['git', 'grep', '-l', mod, '--', '*.py'], capture_output=True, text=True)
    print(mod, ':', out.stdout or '(no references)')
"
```
Expected: only test/doc references, if any — no production imports.

- [ ] **Re-run the corpus evaluation used throughout this session's investigation**

Run the same 86-puzzle filtered evaluation this session used to find and fix
the 7-vs-3 confusion, against the now-migrated pipeline, and confirm bucket
counts match what the pre-migration pipeline produced — this is the
regression check that the migration didn't silently change behavior.

- [ ] **Update `CLAUDE.md`'s Codebase Map**

`killer_sudoku/training/` — Python scripts only — update the description now
that grid location, crop extraction, and classification route through
`ts_bridge.py`; add a row for `web/scripts/ts-bridge.ts`.
