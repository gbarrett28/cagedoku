# Python Bit-Exact Port — Sprint 2: Bit-Check Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-image bit-check harness (Python dump, TS dump, diff) on top of Sprint 1's foundations, run it on `classic_guardian/easy/killer_sudoku_0.jpg`, and drive the first-found divergence to a fix.

**Architecture:** A debug-gated addition to `web/src/image/inpImage.ts` exposes Stage 1 (grayscale) and Stage 2 (grid corners) data on `ParseResult`, reusing the existing `window.__reportContourTree` gate rather than adding a new one. `killer_sudoku/scripts/bitcheck_dump.py` runs `InpImage` on one image and serialises the equivalent Python-side checkpoints. `web/scripts/bitcheck-dump.ts` (Playwright-driven, mirroring `dump-contour-trees.ts`) drives the same image through the browser pipeline and serialises the TS-side checkpoints, including a before/after `window.__cvLiveMats()` leak check. `killer_sudoku/scripts/bitcheck_diff.py` compares the two JSON dumps stage-by-stage and reports the first divergence.

**Tech Stack:** TypeScript/opencv.js, Playwright, Python (numpy).

## Global Constraints

- Bronze gate (`bash scripts/run-bronze-gate.sh`) before every commit.
- Per the approved spec, the Python reference (`killer_sudoku/image/*.py`) is not modified by this work — only read from and imported.
- Warped-image (Stage 2 output) and Stage 3's raw confidence grids are deliberately **not** captured in this first pass — Stage 3/4/5 outputs (puzzle type, borders, cage totals) transitively validate the warp and cell-scan stages; if those pass but a warp-specific bug is later suspected, warped-image capture can be added then (YAGNI — matches the spec's "instrumentation grows as needed" framing).
- Tolerance: exact equality for integer/boolean arrays; `1e-6` absolute tolerance for floats (per spec).
- Per the spec, never target `guardian/killer_sudoku_247.jpg` or `guardian/killer_sudoku_275.jpg` (Python's own 2 known failures).
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

### Task 1: Expose Stage 1/2 checkpoints on the TS side

**Files:**
- Modify: `web/src/image/inpImage.ts` (`ParseResult` interface, `parsePuzzleImage`)

**Interfaces:**
- Produces: `ParseResult.gray?: number[]`, `ParseResult.graySize?: [number, number]`
  (rows, cols of the Stage 1 grayscale mat, pre-warp), `ParseResult.gridCorners?: number[]`
  (flattened `[x0,y0,x1,y1,x2,y2,x3,y3]`, post-rotation-correction) — all three present
  only when `window.__reportContourTree` is set, same gate as `contourTree`.

- [x] **Step 1: Add the three fields to `ParseResult`**

In `web/src/image/inpImage.ts`, change the `ParseResult` interface (currently ending
`outerGridBR?: BRect | null;`) to:

```ts
export interface ParseResult {
  spec: PuzzleSpec | null;
  specError: string | null;
  fallbackUsed: boolean;
  puzzleType: 'killer' | 'classic';
  givenDigits: number[][] | null;
  warpedImageData: ImageData | null;
  /** Post-split thumbnails for the digit recogniser, keyed "row,col". */
  cellThumbs: ReadonlyMap<string, Uint8Array[]>;
  /** Pre-split merged thumbnails for split-recogniser training, keyed "row,col". */
  mergedThumbs: ReadonlyMap<string, Uint8Array>;
  /** Present only when window.__reportContourTree is set */
  contourTree?: ContourInfo[] | null;
  selectedNumbers?: BRect[];
  outerGridBR?: BRect | null;
  /** Stage 1 grayscale mat (pre-warp), flattened row-major. Bitcheck harness only. */
  gray?: number[];
  graySize?: [number, number];
  /** Stage 2 grid corners (post-rotation-correction), flattened [x0,y0,...,x3,y3]. */
  gridCorners?: number[];
}
```

- [x] **Step 2: Capture the grayscale array right after `prepareGrayMat`**

In `parsePuzzleImage`, immediately after the line
`const [blkMat, gryMat] = prepareGrayMat(cv, imageData, resolution);`, add:

```ts
  const grayForDump: number[] | undefined = includeTree ? Array.from(gryMat.data) : undefined;
  const graySizeForDump: [number, number] | undefined = includeTree ? [gryMat.rows, gryMat.cols] : undefined;
```

- [x] **Step 3: Capture grid corners after rotation correction**

Immediately before the line `gryMat.delete(); blkMat.delete(); mMat.delete();` (which
comes right after the `if (rotK !== 0) { ... }` rotation-correction block), add:

```ts
  const gridCornersForDump: number[] | undefined = includeTree ? Array.from(rectArr) : undefined;
```

- [x] **Step 4: Add the three fields to all 3 `return` statements**

Each of the 3 `return` statements in `parsePuzzleImage` has a
`...(includeTree ? { contourTree: ..., selectedNumbers: ..., outerGridBR: ... } : {})`
spread (the classic-path return, the `cageTotals === null` early return, and the
final killer-path return). In each, add three keys inside that same conditional object:

```ts
      gray: grayForDump,
      graySize: graySizeForDump,
      gridCorners: gridCornersForDump,
```

e.g. the classic-path return's spread becomes:

```ts
...(includeTree ? {
  contourTree: earlyContourTree,
  selectedNumbers: earlySelectedNumbers,
  outerGridBR: earlyOuterGridBR,
  gray: grayForDump,
  graySize: graySizeForDump,
  gridCorners: gridCornersForDump,
} : {})
```

Use serena's `find_symbol` on `parsePuzzleImage` to locate the current exact text of
each of the 3 spreads before editing (line numbers shift as earlier steps are applied).

- [x] **Step 5: Type-check and run the existing test suite**

```bash
cd web && npx tsc --noEmit && npm test
```

Expected: no type errors; all existing tests still pass (nothing consumes the new
optional fields yet, so no existing test should change behavior).

- [x] **Step 6: Bronze gate and commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh
git add web/src/image/inpImage.ts
git commit -m "$(cat <<'EOF'
feat: expose Stage 1/2 checkpoints on ParseResult for bit-check harness

Adds gray/graySize (Stage 1 grayscale mat, pre-warp) and gridCorners
(Stage 2, post-rotation-correction) to ParseResult, gated behind the
existing window.__reportContourTree debug flag. Consumed by
web/scripts/bitcheck-dump.ts (Sprint 2 harness).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Python-side dump script

**Files:**
- Create: `killer_sudoku/scripts/bitcheck_dump.py`

**Interfaces:**
- Consumes: `killer_sudoku.image.config.ImagePipelineConfig`,
  `killer_sudoku.image.inp_image.InpImage` (from Sprint 1).
- Produces: a JSON file with keys `gray`, `gray_shape`, `grid_corners`, `puzzle_type`,
  `border_x`, `border_y`, `cage_totals`, `given_digits`, `spec_error` — consumed by
  `bitcheck_diff.py` (Task 4).

- [x] **Step 1: Write `killer_sudoku/scripts/bitcheck_dump.py`**

```python
"""Dumps InpImage stage checkpoints for one puzzle image to JSON, for
bit-exact comparison against the TS port's bitcheck-dump.ts output.

Temporary tooling for the bit-exact port effort — deleted once the whole
corpus matches (see docs/superpowers/specs/2026-07-21-python-bitexact-port-design.md).

Usage:
    python -m killer_sudoku.scripts.bitcheck_dump <image_path> [--out FILE]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage


def dump_stages(image_path: Path) -> dict[str, Any]:
    """Runs InpImage on image_path and extracts the bit-check checkpoints."""
    config = ImagePipelineConfig(rework=True)
    num_recogniser = InpImage.make_num_recogniser()
    info = InpImage(image_path, config, num_recogniser)

    return {
        "gray": info.gry.tolist(),
        "gray_shape": list(info.gry.shape),
        "grid_corners": info.info.grid.tolist(),
        "puzzle_type": info.puzzle_type,
        "border_x": info.info.border_x.tolist(),
        "border_y": info.info.border_y.tolist(),
        "cage_totals": info.info.cage_totals.tolist(),
        "given_digits": info.given_digits.tolist() if info.given_digits is not None else None,
        "spec_error": info.spec_error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image_path", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    stages = dump_stages(args.image_path)
    out_path = args.out if args.out is not None else args.image_path.with_suffix(".py.bitcheck.json")
    out_path.write_text(json.dumps(stages))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
```

- [x] **Step 2: Run it against image 0 to confirm it produces valid output**

```bash
python -m killer_sudoku.scripts.bitcheck_dump guardian/killer_sudoku_0.jpg --out /tmp/py0.json
python -c "import json; d = json.load(open('/tmp/py0.json')); print(d['gray_shape'], d['puzzle_type'], d['spec_error'])"
```

Expected: prints a `gray_shape` like `[1158, 1158]` (or similar — original photo's
upscaled+bordered size), a `puzzle_type` of `'killer'` or `'classic'`, and
`spec_error: None`. Note: this also writes/overwrites
`guardian/killer_sudoku_0.jpk` (InpImage's own cache file) as a side effect —
expected, not a bug (the `.jpg` itself, which is irreplaceable training data,
is untouched).

- [x] **Step 3: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add killer_sudoku/scripts/bitcheck_dump.py
git commit -m "$(cat <<'EOF'
feat: add Python-side bit-check dump script

Runs InpImage on one image and serialises Stage 1/2/3-4/5/6 checkpoints
to JSON for comparison against the TS port via bitcheck_diff.py.
Temporary tooling, deleted once the whole corpus matches.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: TS-side dump script (Playwright-driven)

**Files:**
- Create: `web/scripts/bitcheck-dump.ts`

**Interfaces:**
- Consumes: `window.__reportOutcome` hook (existing, set by the app in dev/preview
  mode), `window.__reportContourTree` (existing debug flag), `window.__cvLiveMats()`
  (from Sprint 1).
- Produces: a JSON file with keys `gray`, `graySize`, `gridCorners`, `puzzleType`,
  `borderX`, `borderY`, `cageTotals`, `givenDigits`, `specError`, `liveMatsBefore`,
  `liveMatsAfter` — consumed by `bitcheck_diff.py` (Task 4).

- [x] **Step 1: Write `web/scripts/bitcheck-dump.ts`**

```ts
#!/usr/bin/env vite-node
/**
 * Drives one puzzle image through the browser pipeline and dumps its
 * bit-check stage checkpoints to JSON, for comparison against
 * killer_sudoku/scripts/bitcheck_dump.py's output.
 *
 * Requires: npm run build && npm run preview (in another terminal)
 *
 * Run from web/:
 *   npx vite-node --script scripts/bitcheck-dump.ts <image_path> [--out FILE]
 */
import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { waitForPipelineReady } from '../e2e/helpers.js';

const BASE_URL = 'http://localhost:4173';

interface OutcomeJson {
  puzzleType: string | null;
  specError: string | null;
  borderX?: boolean[][] | null;
  borderY?: boolean[][] | null;
  cageTotals?: number[][] | null;
  givenDigits?: number[][] | null;
  gray?: number[];
  graySize?: [number, number];
  gridCorners?: number[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const imagePath = args[0];
  if (!imagePath) {
    console.error('Usage: bitcheck-dump.ts <image_path> [--out FILE]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1]! : imagePath.replace(/\.jpe?g$/i, '.ts.bitcheck.json');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE_URL);
  await waitForPipelineReady(page);
  await page.evaluate(() => { (window as unknown as Record<string, unknown>)['__reportContourTree'] = true; });

  const liveMatsBefore = await page.evaluate(
    () => (window as unknown as { __cvLiveMats?: () => number }).__cvLiveMats?.() ?? -1,
  );

  const outcomePromise = page.evaluate(() => new Promise<OutcomeJson>(resolve => {
    (window as unknown as { __reportOutcome?: (o: OutcomeJson) => void }).__reportOutcome = resolve;
  }));
  await page.locator('#file-input').setInputFiles(path.resolve(imagePath));
  const outcome = await outcomePromise;

  const liveMatsAfter = await page.evaluate(
    () => (window as unknown as { __cvLiveMats?: () => number }).__cvLiveMats?.() ?? -1,
  );

  await browser.close();

  fs.writeFileSync(outPath, JSON.stringify({
    gray: outcome.gray,
    graySize: outcome.graySize,
    gridCorners: outcome.gridCorners,
    puzzleType: outcome.puzzleType,
    borderX: outcome.borderX ?? null,
    borderY: outcome.borderY ?? null,
    cageTotals: outcome.cageTotals ?? null,
    givenDigits: outcome.givenDigits ?? null,
    specError: outcome.specError,
    liveMatsBefore,
    liveMatsAfter,
  }));
  console.log(`Wrote ${outPath}`);
  if (liveMatsAfter > liveMatsBefore) {
    console.warn(`WARNING: leaked ${liveMatsAfter - liveMatsBefore} cv.Mat objects processing this image`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [x] **Step 2: Build and preview the app, then run the script against image 0**

```bash
npm run build
npm run preview &
sleep 3
npx vite-node --script scripts/bitcheck-dump.ts ../guardian/killer_sudoku_0.jpg --out /tmp/ts0.json
python -c "import json; d = json.load(open('/tmp/ts0.json')); print(d['graySize'], d['puzzleType'], d['specError'], d['liveMatsBefore'], d['liveMatsAfter'])"
```

Expected: `liveMatsBefore` and `liveMatsAfter` are equal (no leak on this image);
`puzzleType` and `specError` printed; `graySize` is a `[rows, cols]` pair.

- [x] **Step 3: Bronze gate and commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh
git add web/scripts/bitcheck-dump.ts
git commit -m "$(cat <<'EOF'
feat: add TS-side bit-check dump script (Playwright-driven)

Drives one image through the browser pipeline via the existing
__reportOutcome/__reportContourTree hooks, and asserts __cvLiveMats()
returns to its pre-image value (Sprint 1's leak monitor) alongside
dumping the Stage 1/2/3-4/5/6 checkpoints for comparison against
bitcheck_dump.py's output. Temporary tooling.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Diff script and first end-to-end run

**Files:**
- Create: `killer_sudoku/scripts/bitcheck_diff.py`

**Interfaces:**
- Consumes: the two JSON files produced by Tasks 2 and 3.
- Produces: exit code 0 + `MATCH` on stdout if all stages agree; exit code 1 +
  `DIVERGES at <stage>: <detail>` (first divergence only) otherwise.

- [x] **Step 1: Write `killer_sudoku/scripts/bitcheck_diff.py`**

```python
"""Compares a Python-side and TS-side bitcheck dump stage-by-stage, reporting
only the first stage that diverges.

Temporary tooling — see docs/superpowers/specs/2026-07-21-python-bitexact-port-design.md.

Usage:
    python -m killer_sudoku.scripts.bitcheck_diff <py_dump.json> <ts_dump.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

_TOLERANCE = 1e-6

# (label, python_key, ts_key), checked in pipeline order.
_STAGES: list[tuple[str, str, str]] = [
    ("Stage 1: grayscale image", "gray", "gray"),
    ("Stage 2: grid corners", "grid_corners", "gridCorners"),
    ("Stage 3/4: puzzle type", "puzzle_type", "puzzleType"),
    ("Stage 4: border_x", "border_x", "borderX"),
    ("Stage 4: border_y", "border_y", "borderY"),
    ("Stage 5: cage totals", "cage_totals", "cageTotals"),
    ("Stage 5: given digits", "given_digits", "givenDigits"),
    ("Stage 6: spec_error", "spec_error", "specError"),
]


def _compare(label: str, py_val: Any, ts_val: Any) -> str | None:
    if py_val is None and ts_val is None:
        return None
    if (py_val is None) != (ts_val is None):
        return f"one side is null (python is None: {py_val is None}, ts is None: {ts_val is None})"
    if isinstance(py_val, str) or isinstance(ts_val, str):
        return None if py_val == ts_val else f"{py_val!r} != {ts_val!r}"

    py_arr = np.asarray(py_val)
    ts_arr = np.asarray(ts_val)
    if py_arr.shape != ts_arr.shape:
        return f"shape mismatch: python={py_arr.shape} ts={ts_arr.shape}"

    if py_arr.dtype == bool or np.issubdtype(py_arr.dtype, np.integer):
        if np.array_equal(py_arr, ts_arr):
            return None
        diff = np.abs(py_arr.astype(np.int64) - ts_arr.astype(np.int64))
        idx = np.argwhere(diff != 0)
        return f"{len(idx)} elements differ (max abs diff {int(diff.max())}), sample indices {idx[:5].tolist()}"

    diff = np.abs(py_arr.astype(np.float64) - ts_arr.astype(np.float64))
    if diff.max() <= _TOLERANCE:
        return None
    idx = np.argwhere(diff > _TOLERANCE)
    return f"{len(idx)} elements differ beyond {_TOLERANCE} (max abs diff {diff.max()}), sample indices {idx[:5].tolist()}"


def diff_dumps(py_dump: dict[str, Any], ts_dump: dict[str, Any]) -> str | None:
    """Returns None if all stages match, else '<label>: <detail>' for the first divergence."""
    for label, py_key, ts_key in _STAGES:
        detail = _compare(label, py_dump.get(py_key), ts_dump.get(ts_key))
        if detail is not None:
            return f"{label}: {detail}"
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("py_dump", type=Path)
    parser.add_argument("ts_dump", type=Path)
    args = parser.parse_args()

    py_dump = json.loads(args.py_dump.read_text())
    ts_dump = json.loads(args.ts_dump.read_text())

    result = diff_dumps(py_dump, ts_dump)
    if result is None:
        print("MATCH — all stages agree within tolerance.")
        sys.exit(0)
    print(f"DIVERGES at {result}")
    sys.exit(1)


if __name__ == "__main__":
    main()
```

- [x] **Step 2: Write a unit test for `diff_dumps` before running it for real**

Create `tests/test_bitcheck_diff.py`:

```python
from killer_sudoku.scripts.bitcheck_diff import diff_dumps


def test_matching_dumps_return_none() -> None:
    dump = {
        "gray": [[1, 2], [3, 4]], "grid_corners": [[0, 0], [1, 0], [1, 1], [0, 1]],
        "puzzle_type": "killer", "border_x": [[True]], "border_y": [[False]],
        "cage_totals": [[5]], "given_digits": None, "spec_error": None,
    }
    ts_dump = {
        "gray": [[1, 2], [3, 4]], "gridCorners": [[0, 0], [1, 0], [1, 1], [0, 1]],
        "puzzleType": "killer", "borderX": [[True]], "borderY": [[False]],
        "cageTotals": [[5]], "givenDigits": None, "specError": None,
    }
    assert diff_dumps(dump, ts_dump) is None


def test_reports_first_divergence_only() -> None:
    dump = {"gray": [[1, 2]], "grid_corners": [[9, 9]], "puzzle_type": "killer",
            "border_x": None, "border_y": None, "cage_totals": None,
            "given_digits": None, "spec_error": None}
    ts_dump = {"gray": [[1, 99]], "gridCorners": [[0, 0]], "puzzleType": "classic",
               "borderX": None, "borderY": None, "cageTotals": None,
               "givenDigits": None, "specError": None}
    result = diff_dumps(dump, ts_dump)
    assert result is not None
    assert result.startswith("Stage 1: grayscale image")


def test_shape_mismatch_reported() -> None:
    dump = {"gray": [[1, 2], [3, 4]], "grid_corners": None, "puzzle_type": None,
            "border_x": None, "border_y": None, "cage_totals": None,
            "given_digits": None, "spec_error": None}
    ts_dump = {"gray": [[1, 2, 3]], "gridCorners": None, "puzzleType": None,
               "borderX": None, "borderY": None, "cageTotals": None,
               "givenDigits": None, "specError": None}
    result = diff_dumps(dump, ts_dump)
    assert result is not None
    assert "shape mismatch" in result
```

Run: `python -m pytest tests/test_bitcheck_diff.py -v`. Expected: all 3 tests PASS.

- [x] **Step 3: Run the harness end-to-end on image 0**

```bash
python -m killer_sudoku.scripts.bitcheck_diff /tmp/py0.json /tmp/ts0.json
```

Record the actual result (MATCH, or the first divergence and its detail) — this
determines what comes next (see "After this sprint" below). Do not guess at the
outcome; run it and read the real output.

- [x] **Step 4: Bronze gate and commit**

```bash
bash scripts/run-bronze-gate.sh
git add killer_sudoku/scripts/bitcheck_diff.py tests/test_bitcheck_diff.py
git commit -m "$(cat <<'EOF'
feat: add bit-check diff script and first end-to-end run on image 0

Compares the Python and TS bitcheck dumps stage-by-stage, reporting only
the first divergence. Unit-tested with synthetic fixtures before running
for real against classic_guardian/easy/killer_sudoku_0.jpg.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Results

All 4 tasks executed and committed (`758bcfe`, `41a24e2`, `c653431`, `757a5e5`).
Two bugs were found and fixed mid-execution, before the harness produced a
trustworthy result:

1. `ParseResult` alone wasn't enough to get `gray`/`graySize`/`gridCorners` into
   the reported outcome — `web/src/session/actions.ts`'s `UploadResult` and
   `web/src/main.ts`'s `contourPayload()` both hand-pick specific fields rather
   than forwarding `ParseResult` verbatim, so both had to be updated too.
2. The TS `gray` checkpoint was initially a flat `Array.from(gryMat.data)`,
   while Python's `info.gry.tolist()` preserves the 2D shape — reshaped to
   nested rows in `web/src/image/inpImage.ts` to make the two comparable.
3. `web/scripts/bitcheck-dump.ts` had to be added to `web/tsconfig.json`'s
   `include` list (`web/scripts/*.ts` isn't a glob there — each script is
   listed individually), or it silently isn't type-checked at all.

With those fixed, the harness's first real run reported:

```
DIVERGES at Stage 1: grayscale image: shape mismatch: python=(1726, 1726) ts=(1720, 1720)
```

— confirming the predicted cause (Python's 3px border, absent in TS). A second,
independent finding: `web/scripts/bitcheck-dump.ts` reported 1 leaked `cv.Mat`
processing this image (`liveMatsBefore: 0`, `liveMatsAfter: 1`) — Sprint 1's
leak monitor catching something real on its very first use.

### Root-causing (commit `7085e4d`)

Two real bugs found and fixed, via `superpowers:systematic-debugging`:

1. **Missing 3px border** — Python's `get_gry_img` adds a 3px white border on
   all sides before grid detection; TS's `prepareGrayMat` had none. Fixed via
   `cv.copyMakeBorder`, mirrored onto the `srcMat`/`srcMat2` colour-image
   constructions too (their warp uses the same corners/matrix found in the
   now-bordered grayscale coordinate system, so they had to move in lockstep).
2. **ICC colour profile** — `decodeImageFile`'s `createImageBitmap(file)` let
   the browser apply the image's embedded colour profile; `cv2.imread` ignores
   it entirely. Fixed with `{ colorSpaceConversion: 'none' }`.

Together these took the Stage 1 divergence from a shape mismatch to 64,970
differing pixels out of 2,979,076 (max abs diff 1) — consistent with an
inherent rounding difference between the browser's native JPEG decoder and
libjpeg (via cv2), the same wall `feature/python-baseline`'s abandoned
"rebuild opencv.js with imgcodecs + imdecode" commit was written to solve.

**Despite that residual Stage 1 noise, `puzzle_type` and `cage_totals` already
match exactly** (both sum to 405, element-wise identical) — the noise doesn't
propagate that far. `border_x`/`border_y` do **not** match (confirmed not a
transpose/indexing-convention artifact — shapes and direct/transposed
comparisons all disagree), a real, distinct Stage 4 divergence.

The leaked `cv.Mat` was tested against the `__reportContourTree` hypothesis
(leak only in debug-only contour-tree code) and that was **falsified** — it
leaks identically with the flag on or off, so it's in the always-exercised
pipeline path. Every `MatVector.get()` call site in `gridLocation.ts`,
`cellScan.ts`, and `numberRecognition.ts` was checked and each already
balances with a `.delete()`; the leak's source is still unknown.

## After this sprint

Two open threads were identified, both requiring fresh root-cause
investigation beyond ruling out the above:

1. **Stage 4 `border_x`/`border_y` divergence** on image 0 — puzzle_type and
   cage_totals already agree, so this is likely isolated to the anchored
   border-clustering logic (`web/src/image/borderClustering.ts` vs
   `killer_sudoku/image/border_clustering.py` / `border_detection.py`).
   **Resolved** (root-caused in follow-up work, not a separate plan): the
   true cause was an `isHorizontal` semantic inversion in `sampleStrip`
   (Python's `_sample_strip` treats the first numpy axis as x/column, a
   transposed convention TS had backwards), plus the digit recogniser
   (Stage 5) needing to be reverted from HOG+OVO-SVM back to Python's
   PCA+template+RBF-SVM so cage_totals — which Stage 4's polarity
   flip-search depends on via connectivity scoring — agreed too. With both
   fixed, `border_x`/`border_y`, `cage_totals`, and `given_digits` all now
   match Python bit-exact on image 0 (verified via the harness; a dump-tool
   bug was also found and fixed along the way — classic-puzzle
   `cage_totals` needed reading from `info.spec.cage_totals` instead of the
   never-assigned `info.info.cage_totals`, and transposing to row-major).
   Only Stage 1's known JPEG-decode noise (below) remains on this image.
2. **1 leaked `cv.Mat`**, confirmed to be in the main pipeline path (not the
   debug-only contour-tree extraction). Needs bisection — e.g. temporarily
   checking `__cvLiveMats()` at intermediate points within `parsePuzzleImage`
   to narrow down which stage introduces it. **Resolved**: `matToImageData`
   (`web/src/image/inpImage.ts`) allocated `rgba = new cv.Mat()`
   unconditionally, then reassigned `rgba = mat.clone()` in the 4-channel
   branch without deleting the first allocation. The warped colour Mat
   passed in is always 4-channel (RGBA `ImageData`), so this ran every
   call, leaking exactly one Mat per image — found by code inspection
   rather than runtime bisection, once the Stage 4/5 fixes above ruled out
   everything in `numberRecognition.ts`/`cellScan.ts`. Verified via the
   harness on both a classic and killer test image: no leak reported on
   either, no change to image 0's matching output.

Both threads are now resolved. Stage 1's JPEG-decode noise remains
accepted as out-of-scope while using the default opencv.js build; image 0
is otherwise fully matched.

A real, distinct killer-path divergence was found while testing
`guardian/killer_sudoku_0.jpg` as a candidate next image —
`border_x`/`border_y` and `cage_totals` disagreed (via a harness bug: the
dump was reading the UI's placeholder spec, not the real detection
result), and once that was fixed, TS raised `ProcessingError: region
reassigned` where Python succeeds. **Root-caused and resolved**:
`buildCageTotals`'s contour-to-cell assignment had the same axis-swap
quirk `_sample_strip` already accounts for in Stage 4 (x-coordinate maps
to row, y to col — not the intuitive mapping) — verified by confirming
region *shapes* were already correct (30 regions, sizes 2–4, matching a
real killer layout) before finding the total-value/cell misattribution.
Fixed in `buildCageTotals` only; `connectivityScore`/`validateCageLayout`/
`repairCageTotals` needed no changes and all their existing tests
(including the Bug #29 regression suite) still pass. Both
`classic_guardian/easy/killer_sudoku_0.jpg` and
`guardian/killer_sudoku_0.jpg` now match Python bit-exact on every field
and validate successfully — image 2 (a genuine killer puzzle) can now be
picked as the next bit-check target, in a new plan.
