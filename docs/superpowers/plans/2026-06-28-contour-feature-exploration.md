# Contour Feature Exploration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dump raw contour trees from 50 clean corpus puzzles per (corpus × ground\_truth) via the production browser pipeline, then compute a labelled per-contour feature CSV in Python for exploratory analysis.

**Architecture:** Three layers — (1) extend `inpImage.ts` / `actions.ts` / `main.ts` to push contour data through `__reportOutcome` when `window.__reportContourTree` is set; (2) new `dump-contour-trees.ts` Playwright script that collects the dumps; (3) new `analyse-contours.py` that computes features and writes `features.csv`.

**Tech Stack:** TypeScript (Playwright, better-sqlite3), Python (opencv-python, numpy, pandas)

## Global Constraints

- Feature branch: `feature/contour-feature-exploration`
- Bronze gate must pass before every commit (`bash scripts/run-bronze-gate.sh` from repo root)
- Use Serena MCP tools for all TypeScript and Python edits
- No tests for the two new scripts (research tooling)
- `contour-dumps/` is gitignored and never committed
- Coordinate convention: `[row, col]` throughout; `borderX[col][rowGap]`, `borderY[colGap][row]`

---

### Task 1: Extend `buildCageTotals` to optionally return contour tree data

**Files:**
- Modify: `web/src/image/inpImage.ts` — `CageTotalsResult`, `buildCageTotals`

**Interfaces:**
- Produces: `CageTotalsResult` gains two optional fields:
  ```typescript
  contourTree?: ContourInfo[];    // full tree (chiers) when includeTree=true
  selectedNumbers?: BRect[];      // bounding rects of rawNums when includeTree=true
  outerGridBR?: BRect;            // bounding rect of chiers[0] when includeTree=true
  ```
- `buildCageTotals` gains a new optional last parameter: `includeTree?: boolean`

- [ ] **Step 1.1: Add optional fields to `CageTotalsResult`**

  Use `replace_symbol_body` on `CageTotalsResult` in `web/src/image/inpImage.ts`:
  ```typescript
  export interface CageTotalsResult {
    cageTotals: number[][];
    cellThumbs: Map<string, Uint8Array[]>;
    mergedThumbs: Map<string, Uint8Array>;
    /** Present only when buildCageTotals is called with includeTree=true */
    contourTree?: ContourInfo[];
    selectedNumbers?: BRect[];
    outerGridBR?: BRect;
  }
  ```

- [ ] **Step 1.2: Import `ContourInfo` and `BRect` at top of `inpImage.ts`**

  These types are already imported from `numberRecognition.js`. Verify with `find_symbol`; add if missing.

- [ ] **Step 1.3: Add `includeTree` parameter and capture inside `buildCageTotals`**

  Use `replace_symbol_body` on `buildCageTotals`. After `const chiers = contourHier(...)` and `const rawNums = getNumContours(...)`, add:
  ```typescript
  let contourTree: ContourInfo[] | undefined;
  let selectedNumbers: BRect[] | undefined;
  let outerGridBR: BRect | undefined;
  if (includeTree) {
    contourTree = chiers;
    selectedNumbers = rawNums.map(([, br]) => br);
    outerGridBR = chiers[0]?.[1];
  }
  ```
  And in the return value add `...(includeTree ? { contourTree, selectedNumbers, outerGridBR } : {})`.

- [ ] **Step 1.4: Run bronze gate**
  ```bash
  cd /path/to/repo && bash scripts/run-bronze-gate.sh
  ```
  Expected: all checks pass.

- [ ] **Step 1.5: Commit**
  ```bash
  git add web/src/image/inpImage.ts
  git commit -m "feat: extend buildCageTotals to optionally return contour tree data"
  ```

---

### Task 2: Extend `ParseResult` and `parsePuzzleImage` to propagate contour data

**Files:**
- Modify: `web/src/image/inpImage.ts` — `ParseResult`, `parsePuzzleImage`

**Interfaces:**
- Consumes: `buildCageTotals` with `includeTree` flag (Task 1)
- Produces: `ParseResult` gains optional contour fields; `parsePuzzleImage` reads `window.__reportContourTree`

- [ ] **Step 2.1: Add optional fields to `ParseResult`**

  Use `replace_symbol_body` on `ParseResult`:
  ```typescript
  export interface ParseResult {
    spec: PuzzleSpec | null;
    specError: string | null;
    puzzleType: 'killer' | 'classic';
    givenDigits: number[][] | null;
    warpedImageData: ImageData | null;
    cellThumbs: ReadonlyMap<string, Uint8Array[]>;
    mergedThumbs: ReadonlyMap<string, Uint8Array>;
    /** Present only when window.__reportContourTree is set */
    contourTree?: ContourInfo[] | null;
    selectedNumbers?: BRect[];
    outerGridBR?: BRect | null;
  }
  ```

- [ ] **Step 2.2: Detect flag and pass `includeTree` to `buildCageTotals` calls**

  In `parsePuzzleImage`, before the first `buildCageTotals` call, add:
  ```typescript
  const includeTree = typeof window !== 'undefined'
    && !!(window as unknown as Record<string, unknown>)['__reportContourTree'];
  ```
  Pass `includeTree` as the last argument to all three `buildCageTotals` calls.

- [ ] **Step 2.3: Capture and propagate tree fields in killer path returns**

  After the final `buildCageTotals` call, capture the tree from the result and include in each
  `return` statement in the killer path:
  ```typescript
  ...(includeTree ? {
    contourTree: cageTotalsResult.contourTree ?? null,
    selectedNumbers: cageTotalsResult.selectedNumbers ?? [],
    outerGridBR: cageTotalsResult.outerGridBR ?? null,
  } : {}),
  ```
  The classic path always returns `contourTree: null` when `includeTree` is true (no cage total
  contours in classic). The outer grid BR for classic can still come from `readClassicDigits`'s
  contour tree — but for simplicity, set `outerGridBR: null` for classic (the dump script only
  samples killer puzzles for tree analysis anyway).

- [ ] **Step 2.4: Run bronze gate and commit**
  ```bash
  bash scripts/run-bronze-gate.sh
  git add web/src/image/inpImage.ts
  git commit -m "feat: propagate contour tree through ParseResult when __reportContourTree set"
  ```

---

### Task 3: Extend `UploadResult` and `uploadPuzzle`

**Files:**
- Modify: `web/src/session/actions.ts` — `UploadResult`, `uploadPuzzle`

**Interfaces:**
- Consumes: `ParseResult` with optional contour fields (Task 2)
- Produces: `UploadResult` with same optional contour fields; `uploadPuzzle` passes them through

- [ ] **Step 3.1: Add optional fields to `UploadResult`**

  Use `replace_symbol_body` on `UploadResult`:
  ```typescript
  export interface UploadResult {
    state: PuzzleState;
    warpedImageUrl: string | null;
    warning: string | null;
    cellThumbs: ReadonlyMap<string, Uint8Array[]>;
    mergedThumbs: ReadonlyMap<string, Uint8Array>;
    detectedBigApple: boolean;
    /** Present only when window.__reportContourTree is set */
    contourTree?: ContourInfo[] | null;
    selectedNumbers?: BRect[];
    outerGridBR?: BRect | null;
    /** Raw OCR given digits (0 = empty cell) for classic; null for killer */
    givenDigits?: number[][] | null;
  }
  ```
  Add `import type { ContourInfo, BRect } from '../image/numberRecognition.js';` if not present.

- [ ] **Step 3.2: Pass through fields in `uploadPuzzle`**

  In the `uploadPuzzle` return value, spread the optional fields:
  ```typescript
  ...(result.contourTree !== undefined ? {
    contourTree: result.contourTree,
    selectedNumbers: result.selectedNumbers ?? [],
    outerGridBR: result.outerGridBR ?? null,
    givenDigits: result.givenDigits,
  } : {}),
  ```

- [ ] **Step 3.3: Run bronze gate and commit**
  ```bash
  bash scripts/run-bronze-gate.sh
  git add web/src/session/actions.ts
  git commit -m "feat: propagate contour tree through UploadResult"
  ```

---

### Task 4: Extend `ReportOutcomeFn` and `main.ts` `__reportOutcome` calls

**Files:**
- Modify: `web/src/main.ts` — `ReportOutcomeFn`, all `__reportOutcome` calls in `handleProcess`

**Interfaces:**
- Consumes: `UploadResult` with optional contour fields (Task 3)
- Produces: `__reportOutcome` payload includes contour dump when `window.__reportContourTree` is set

- [ ] **Step 4.1: Extend `ReportOutcomeFn` type**

  Use `replace_symbol_body` on `ReportOutcomeFn` (lines 87–90):
  ```typescript
  type ReportOutcomeFn = (o: {
    bucket: string; reason: string; puzzleType: string | null;
    detectedBigApple: boolean; specHash: string | null;
    /** Present only when window.__reportContourTree is set */
    contourTree?: ContourInfo[] | null;
    selectedNumbers?: BRect[];
    outerGridBR?: BRect | null;
    borderX?: boolean[][] | null;
    borderY?: boolean[][] | null;
    cageTotals?: number[][] | null;
    givenDigits?: number[][] | null;
  }) => void;
  ```
  Add necessary imports (`ContourInfo`, `BRect`) from `./image/numberRecognition.js`.

- [ ] **Step 4.2: Build contour payload helper in `main.ts`**

  After the `ReportOutcomeFn` type, add a small helper that builds the optional contour fields
  from an `UploadResult` when `window.__reportContourTree` is set:
  ```typescript
  function contourPayload(upload: UploadResult | null, spec: PuzzleSpec | null): object {
    const win = window as unknown as Record<string, unknown>;
    if (!win['__reportContourTree'] || upload?.contourTree === undefined) return {};
    return {
      contourTree: upload.contourTree,
      selectedNumbers: upload.selectedNumbers ?? [],
      outerGridBR: upload.outerGridBR ?? null,
      borderX: spec?.borderX ?? null,
      borderY: spec?.borderY ?? null,
      cageTotals: spec?.cageTotals ?? null,
      givenDigits: upload.givenDigits ?? null,
    };
  }
  ```
  Import `PuzzleSpec` if not already imported.

- [ ] **Step 4.3: Spread contour payload into every `__reportOutcome` call**

  There are 9 `__reportOutcome` call sites. For each one, spread `...contourPayload(uploadResult, spec)` into the object literal. In error paths where `uploadResult` is null, pass null. Use `replace_content` for the repetitive changes.

- [ ] **Step 4.4: Run bronze gate and commit**
  ```bash
  bash scripts/run-bronze-gate.sh
  git add web/src/main.ts
  git commit -m "feat: push contour tree through __reportOutcome when __reportContourTree flag set"
  ```

---

### Task 5: `dump-contour-trees.ts` script

**Files:**
- Create: `web/scripts/dump-contour-trees.ts`
- Modify: `web/tsconfig.json` — add to `include`
- Modify: `.gitignore` — add `contour-dumps/`

**Interfaces:**
- Consumes: corpus.db (`puzzles`, `evaluations` tables), production preview server at `http://localhost:4173`
- Produces: `contour-dumps/<puzzle_hash>.json` per puzzle

- [ ] **Step 5.1: Add `contour-dumps/` to `.gitignore`**

  Append after the existing `corpus.db` entries:
  ```
  contour-dumps/
  ```

- [ ] **Step 5.2: Add script to `tsconfig.json` include array**

  Add `"scripts/dump-contour-trees.ts"` to the `include` array.

- [ ] **Step 5.3: Write `dump-contour-trees.ts`**

  ```typescript
  #!/usr/bin/env vite-node
  /**
   * Dumps raw contour trees from a sample of clean corpus puzzles.
   * Requires: npm run build && npm run preview (in another terminal)
   *
   * Run from web/:
   *   npx vite-node --script scripts/dump-contour-trees.ts [--limit N] [--out-dir DIR]
   */
  import { chromium } from '@playwright/test';
  import * as fs from 'node:fs';
  import * as path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { openDb, DEFAULT_DB_PATH } from './corpus-db.js';
  import { waitForPipelineReady } from '../e2e/helpers.js';

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const SAMPLES_PER_BUCKET = 50;
  const BASE_URL = 'http://localhost:4173';
  const GIT_HASH = 'ae4889612a2e16931eac88eebef576968af6e1ba'; // master baseline

  // Types mirroring inpImage.ts / numberRecognition.ts for the JSON output
  type BRect = [number, number, number, number];
  type ContourNode = [pts: number[][], br: BRect, area: number, children: ContourNode[]];

  interface ContourDump {
    puzzle_hash: string;
    corpus: string;
    ground_truth: string;
    detected_type: string;
    bucket: string;
    subres: number;
    tree: ContourNode[];
    selectedNumbers: BRect[];
    outerGridBR: BRect | null;
    borderX: boolean[][] | null;
    borderY: boolean[][] | null;
    cageTotals: number[][] | null;
    givenDigits: (number | null)[][] | null;
  }

  async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const limitIdx = args.indexOf('--limit');
    const limitPerBucket = limitIdx >= 0 ? Number(args[limitIdx + 1]) : SAMPLES_PER_BUCKET;
    const outIdx = args.indexOf('--out-dir');
    const outDir = outIdx >= 0 ? args[outIdx + 1]! : path.resolve(__dirname, '../../contour-dumps');
    fs.mkdirSync(outDir, { recursive: true });

    const db = openDb(DEFAULT_DB_PATH);

    // Select up to limitPerBucket clean/backtracked puzzles per (corpus x ground_truth),
    // where the pipeline detected the correct type.
    const rows = db.prepare(`
      SELECT p.content_hash, p.path, p.corpus,
             json_extract(p.ground_truth, '$[0]') as gt,
             e.detected_type, e.bucket
      FROM evaluations e
      JOIN puzzles p ON p.content_hash = e.puzzle_hash
      WHERE e.git_hash = ?
        AND e.status = 'done'
        AND e.bucket IN ('clean', 'backtracked')
        AND e.detected_type = json_extract(p.ground_truth, '$[0]')
      GROUP BY p.corpus, json_extract(p.ground_truth, '$[0]'), p.content_hash
      HAVING row_number() OVER (
        PARTITION BY p.corpus, json_extract(p.ground_truth, '$[0]')
        ORDER BY p.content_hash
      ) <= ?
    `).all(GIT_HASH, limitPerBucket) as Array<{
      content_hash: string; path: string; corpus: string;
      gt: string; detected_type: string; bucket: string;
    }>;

    // Fallback: SQLite may not support window functions in all builds — use JS grouping
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.corpus}|${row.gt}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }
    const sample: typeof rows = [];
    for (const group of grouped.values()) {
      sample.push(...group.slice(0, limitPerBucket));
    }
    db.close();

    console.log(`[dump-contour-trees] ${sample.length} puzzles selected`);

    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('coach_tutorial_suppressed', 'true');
      HTMLDialogElement.prototype.showModal = () => {};
      (window as any).__reportContourTree = true;
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForPipelineReady(page, 90_000);

    let resolveOutcome: ((o: unknown) => void) | null = null;
    await page.exposeFunction('__reportOutcome', (o: unknown) => {
      resolveOutcome?.(o);
      resolveOutcome = null;
    });

    let done = 0;
    for (const row of sample) {
      const outPath = path.join(outDir, `${row.content_hash}.json`);
      if (fs.existsSync(outPath)) { done++; continue; }

      const outcomePromise = new Promise<unknown>(r => { resolveOutcome = r; });
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000));

      await page.locator('#file-input').setInputFiles(row.path);
      let outcome: any;
      try {
        outcome = await Promise.race([outcomePromise, timeout]);
      } catch {
        console.warn(`[dump-contour-trees] timeout: ${row.content_hash}`);
        continue;
      }

      if (!outcome?.contourTree) {
        console.warn(`[dump-contour-trees] no contour tree in outcome for ${row.content_hash}`);
        continue;
      }

      const subres: number = await page.evaluate(() => (window as any).__lastSubres ?? 128);

      const dump: ContourDump = {
        puzzle_hash: row.content_hash,
        corpus: row.corpus,
        ground_truth: row.gt,
        detected_type: row.detected_type,
        bucket: row.bucket,
        subres,
        tree: outcome.contourTree,
        selectedNumbers: outcome.selectedNumbers ?? [],
        outerGridBR: outcome.outerGridBR ?? null,
        borderX: outcome.borderX ?? null,
        borderY: outcome.borderY ?? null,
        cageTotals: outcome.cageTotals ?? null,
        givenDigits: outcome.givenDigits
          ? (outcome.givenDigits as number[][]).map(r => r.map(v => v === 0 ? null : v))
          : null,
      };
      fs.writeFileSync(outPath, JSON.stringify(dump));
      done++;
      console.log(`[${done}/${sample.length}] ${row.corpus}/${row.gt} ${row.content_hash.slice(0, 8)}`);
    }

    await browser.close();
    console.log(`[dump-contour-trees] done — ${done} files in ${outDir}`);
  }

  main().catch(e => { console.error(e); process.exit(1); });
  ```

- [ ] **Step 5.4: Run `tsc --noEmit` to verify the new script type-checks**
  ```bash
  cd web && npx tsc --noEmit
  ```

- [ ] **Step 5.5: Run bronze gate and commit**
  ```bash
  bash scripts/run-bronze-gate.sh
  git add web/scripts/dump-contour-trees.ts web/tsconfig.json .gitignore
  git commit -m "feat: add dump-contour-trees script"
  ```

---

### Task 6: `analyse-contours.py` script

**Files:**
- Create: `web/scripts/analyse-contours.py`

**Interfaces:**
- Consumes: `contour-dumps/*.json` (Task 5 output)
- Produces: `contour-dumps/features.csv`

- [ ] **Step 6.1: Write `analyse-contours.py`**

  ```python
  #!/usr/bin/env python3
  """
  Traverse contour-dumps/*.json and compute a per-contour feature CSV.

  Run from repo root:
      python web/scripts/analyse-contours.py [--dump-dir DIR] [--out PATH]
  """
  from __future__ import annotations

  import argparse
  import json
  import math
  import sys
  from pathlib import Path
  from typing import Any

  import cv2
  import numpy as np
  import pandas as pd

  ContourNode = list[Any]  # [pts, [x,y,w,h], area, children]


  def depth_below(node: ContourNode) -> int:
      children: list[ContourNode] = node[3]
      if not children:
          return 0
      return 1 + max(depth_below(c) for c in children)


  def hu_moments(pts: list[list[int]]) -> list[float]:
      arr = np.array(pts, dtype=np.float32).reshape(-1, 1, 2)
      m = cv2.moments(arr)
      hu = cv2.HuMoments(m).flatten()
      # log-scale: sign(h) * log10(|h| + 1e-10)
      return [float(math.copysign(math.log10(abs(h) + 1e-10), h)) for h in hu]


  def visit(
      node: ContourNode,
      depth: int,
      parent_area: float,
      num_peers: int,
      selected_set: set[tuple[int, int, int, int]],
      outer_br: tuple[int, int, int, int] | None,
      subres: int,
      meta: dict[str, Any],
      rows: list[dict[str, Any]],
  ) -> None:
      pts: list[list[int]] = node[0]
      br: list[int] = node[1]
      area: float = float(node[2])
      children: list[ContourNode] = node[3]

      x, y, w, h = br
      br_tuple = (x, y, w, h)

      if w == 0 or h == 0:
          for child in children:
              visit(child, depth + 1, area or 1.0, len(children),
                    selected_set, outer_br, subres, meta, rows)
          return

      hu = hu_moments(pts)
      db = depth_below(node)

      if br_tuple == outer_br:
          label = 'grid'
      elif br_tuple in selected_set:
          label = 'number'
      else:
          label = 'unlabelled'

      cx = x + w / 2
      cy = y + h / 2
      cell_col = int(cx / subres)
      cell_row = int(cy / subres)

      cage_total: int | None = None
      given_digit: int | None = None
      if label == 'number':
          cage_totals: list[list[int]] | None = meta.get('cageTotals')
          given_digits: list[list[int | None]] | None = meta.get('givenDigits')
          if cage_totals and 0 <= cell_row < 9 and 0 <= cell_col < 9:
              v = cage_totals[cell_row][cell_col]
              if v:
                  cage_total = v
          if given_digits and 0 <= cell_row < 9 and 0 <= cell_col < 9:
              given_digit = given_digits[cell_row][cell_col]  # type: ignore[assignment]

      row: dict[str, Any] = {
          'puzzle_hash': meta['puzzle_hash'],
          'corpus': meta['corpus'],
          'ground_truth': meta['ground_truth'],
          'detected_type': meta['detected_type'],
          'bucket': meta['bucket'],
          'depth': depth,
          'depth_below': db,
          'num_peers': num_peers,
          'num_children': len(children),
          'x': x, 'y': y, 'w': w, 'h': h,
          'cx_norm': cx / subres,
          'cy_norm': cy / subres,
          'w_norm': w / subres,
          'h_norm': h / subres,
          'area_norm': area / (subres * subres),
          'aspect_ratio': w / h,
          'fill_ratio': area / (w * h),
          'area_rel_parent': area / parent_area,
          'label': label,
          'cell_row': cell_row if label == 'number' else None,
          'cell_col': cell_col if label == 'number' else None,
          'cage_total': cage_total,
          'given_digit': given_digit,
          **{f'hu{i+1}': hu[i] for i in range(7)},
      }
      rows.append(row)

      for child in children:
          visit(child, depth + 1, area or 1.0, len(children),
                selected_set, outer_br, subres, meta, rows)


  def process_dump(dump_path: Path) -> list[dict[str, Any]]:
      with dump_path.open() as f:
          data = json.load(f)

      subres: int = data.get('subres', 128)
      selected: list[list[int]] = data.get('selectedNumbers', [])
      selected_set = {(s[0], s[1], s[2], s[3]) for s in selected}
      outer_br_raw: list[int] | None = data.get('outerGridBR')
      outer_br = tuple(outer_br_raw) if outer_br_raw else None  # type: ignore[assignment]

      meta: dict[str, Any] = {
          'puzzle_hash': data['puzzle_hash'],
          'corpus': data['corpus'],
          'ground_truth': data['ground_truth'],
          'detected_type': data['detected_type'],
          'bucket': data['bucket'],
          'cageTotals': data.get('cageTotals'),
          'givenDigits': data.get('givenDigits'),
      }

      rows: list[dict[str, Any]] = []
      tree: list[ContourNode] = data.get('tree', [])
      for root in tree:
          visit(root, 0, float(root[2]) or 1.0, len(tree),
                selected_set, outer_br, subres, meta, rows)
      return rows


  def main() -> None:
      parser = argparse.ArgumentParser()
      parser.add_argument('--dump-dir', default='contour-dumps')
      parser.add_argument('--out', default=None)
      args = parser.parse_args()

      dump_dir = Path(args.dump_dir)
      out_path = Path(args.out) if args.out else dump_dir / 'features.csv'

      files = sorted(dump_dir.glob('*.json'))
      if not files:
          print(f'No JSON files in {dump_dir}', file=sys.stderr)
          sys.exit(1)

      all_rows: list[dict[str, Any]] = []
      for i, f in enumerate(files):
          try:
              all_rows.extend(process_dump(f))
              print(f'[{i+1}/{len(files)}] {f.name}')
          except Exception as exc:
              print(f'WARNING: skipping {f.name}: {exc}', file=sys.stderr)

      df = pd.DataFrame(all_rows)
      df.to_csv(out_path, index=False)
      print(f'\n{len(df)} contours from {len(files)} puzzles → {out_path}')


  if __name__ == '__main__':
      main()
  ```

- [ ] **Step 6.2: Run ruff and mypy**
  ```bash
  python -m ruff check web/scripts/analyse-contours.py
  python -m mypy web/scripts/analyse-contours.py --ignore-missing-imports
  ```
  Fix any issues.

- [ ] **Step 6.3: Run bronze gate and commit**
  ```bash
  bash scripts/run-bronze-gate.sh
  git add web/scripts/analyse-contours.py
  git commit -m "feat: add analyse-contours Python script for contour feature extraction"
  ```

---

### Task 7: Push branch

- [ ] **Step 7.1: Push feature branch**
  ```bash
  git push -u origin feature/contour-feature-exploration
  ```
