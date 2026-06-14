# Cage-Total Threshold Calibration — Sprint 2: OpenCV Integration, Telemetry, Pipeline Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Sprint 1 pure calibration core into the real pipeline:
extract OpenCV-based `collectCageTotalContours` and `scanClassicDigits` from
`scanCells` (removing `scanCells`), add the `CageThresholdCalibrationReport`
telemetry type end-to-end (shared type, worker case, submit helper), and replace
`inpImage.ts`'s Stage 3/4 cage-total path with the calibration stage. Verify
against `KS1019_P.jpg` via the `/tmp/cvrun` harness.

**Architecture:** `collectCageTotalContours` runs the existing adaptiveThreshold +
findContours pass once per cell, returning `ContourMetrics[][][]` for
`cageConfFromContours`/`calibrateCageTotalThreshold` (Sprint 1) to consume.
`scanClassicDigits` is the unchanged classic-digit half of the old `scanCells`,
extracted into its own function. `CageThresholdCalibrationReport` follows the
`StallStateExport` pattern (R2 storage only, no GitHub comment — it's tuning data,
not an actionable alert).

**Tech Stack:** TypeScript, Vitest, OpenCV.js (via `/tmp/cvrun` Node harness for
verification). Reference design:
`docs/superpowers/specs/2026-06-14-cage-total-threshold-calibration-design.md`.
Depends on Sprint 1 (`docs/superpowers/plans/2026-06-14-cage-total-threshold-calibration-sprint1.md`)
being complete and committed.

---

## Task 1: `collectCageTotalContours` and `scanClassicDigits`; remove `scanCells`

**Files:**
- Modify: `web/src/image/cellScan.ts`
- Modify: `web/src/image/cellScan.test.ts`

`scanCells` currently does both cage-total and classic-digit detection in one
OpenCV pass per cell. Split it: `collectCageTotalContours` does the cage-total
half (returns `ContourMetrics[][][]` instead of a confidence array), and
`scanClassicDigits` does the classic-digit half (unchanged logic, just
extracted). `scanCells` is removed entirely.

Both new functions require real OpenCV and have no pure unit test — this is
consistent with the existing `scanCells` (also untested at the unit level).
They will be verified via the `/tmp/cvrun` harness in Task 5.

- [ ] **Step 1: Replace `scanCells` with `collectCageTotalContours` and `scanClassicDigits`**

In `web/src/image/cellScan.ts`, delete the entire `scanCells` function (lines ~69-147
in the current file — the whole `export function scanCells(...) { ... }` block,
including its JSDoc comment), and replace it with:

```ts
/**
 * Collect size-valid cage-total contour metrics for all 81 cells.
 *
 * Runs the adaptiveThreshold + findContours pass once per cell's top-left
 * quadrant, applying only the bounding-box size heuristic
 * (`isCageTotalContourSize`). The fill-ratio check is deferred to
 * `cageConfFromContours`/`calibrateCageTotalThreshold`, which can be evaluated
 * cheaply for many candidate thresholds without re-running OpenCV.
 *
 * @param cv - OpenCV.js module.
 * @param warpedGry - Perspective-corrected grayscale Mat, (9*subres × 9*subres).
 * @param subres - Pixels per cell side.
 * @returns (9, 9) array [row][col] of size-valid contour metrics (usually 0-2 per cell).
 */
export function collectCageTotalContours(
  cv: Cv,
  warpedGry: OpenCVMat,
  subres: number,
): ContourMetrics[][][] {
  const half = subres >> 1;
  const blockSize = Math.max(3, (half >> 2) | 1);

  const result: ContourMetrics[][][] = Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, (): ContourMetrics[] => []),
  );

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const y0 = row * subres;
      const x0 = col * subres;

      const patchTL = warpedGry.roi(new cv.Rect(x0, y0, half, half));
      const blkTL = new cv.Mat();
      cv.adaptiveThreshold(
        patchTL, blkTL, 255,
        cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
        blockSize, 2,
      );
      patchTL.delete();

      const contoursTL = new cv.MatVector();
      const hierTL = new cv.Mat();
      cv.findContours(blkTL, contoursTL, hierTL, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      blkTL.delete();
      hierTL.delete();

      const cellContours: ContourMetrics[] = [];
      for (let i = 0; i < contoursTL.size(); i++) {
        const contour = contoursTL.get(i);
        const br = cv.boundingRect(contour);
        if (isCageTotalContourSize(br.width, br.height, subres)) {
          cellContours.push({ width: br.width, height: br.height, area: cv.contourArea(contour) });
        }
      }
      contoursTL.delete();
      result[row]![col] = cellContours;
    }
  }

  return result;
}

/**
 * Scan all 81 cells for large centred contours (classic sudoku pre-filled digit).
 *
 * @param cv - OpenCV.js module.
 * @param warpedGry - Perspective-corrected grayscale Mat, (9*subres × 9*subres).
 * @param subres - Pixels per cell side.
 * @param classicMinSizeFraction - Min contour dimension fraction for classic digits.
 * @returns (9, 9) array [row][col] with values in {0.0, 1.0}.
 */
export function scanClassicDigits(
  cv: Cv,
  warpedGry: OpenCVMat,
  subres: number,
  classicMinSizeFraction: number,
): number[][] {
  const classicConf: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  const classicMin = Math.floor(subres * classicMinSizeFraction);
  const margin = (subres / 6) | 0;
  const patchSize = subres - 2 * margin;
  const classicBlock = Math.max(3, (patchSize >> 2) | 1);

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const y0 = row * subres;
      const x0 = col * subres;

      const patchC = warpedGry.roi(new cv.Rect(x0 + margin, y0 + margin, patchSize, patchSize));
      const blkC = new cv.Mat();
      cv.adaptiveThreshold(
        patchC, blkC, 255,
        cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
        classicBlock, 2,
      );
      patchC.delete();

      const contoursC = new cv.MatVector();
      const hierC = new cv.Mat();
      cv.findContours(blkC, contoursC, hierC, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      blkC.delete();
      hierC.delete();

      for (let i = 0; i < contoursC.size(); i++) {
        const br = cv.boundingRect(contoursC.get(i));
        if (br.width >= classicMin || br.height >= classicMin) {
          classicConf[row]![col] = 1.0;
          break;
        }
      }
      contoursC.delete();
    }
  }

  return classicConf;
}
```

- [ ] **Step 2: Add `contourFillRatios` helper for telemetry**

In `web/src/image/cellScan.ts`, add after `collectCageTotalContours`/`scanClassicDigits`:

```ts
/**
 * Flatten all size-valid contour fill ratios across the image, for the
 * `contourFillRatios` field of `CageThresholdCalibrationReport` — the raw data
 * needed to re-tune the candidate sweep or margin rule from real-world data.
 *
 * @param contours - (9, 9) array [row][col] of size-valid contour metrics.
 */
export function contourFillRatios(contours: ContourMetrics[][][]): number[] {
  const ratios: number[] = [];
  for (const rowContours of contours) {
    for (const cellContours of rowContours) {
      for (const c of cellContours) {
        ratios.push(c.area / (c.width * c.height));
      }
    }
  }
  return ratios;
}
```

- [ ] **Step 3: Add a unit test for `contourFillRatios`**

Add to `web/src/image/cellScan.test.ts`, extending the import:

```ts
import {
  computeQuadSums, detectPuzzleType, detectRotation, isCageTotalContour,
  cageConfFromContours, thresholdMargin, pickBestThreshold, calibrateCageTotalThreshold,
  contourFillRatios,
} from './cellScan.js';
```

Then add:

```ts
// ---------------------------------------------------------------------------
// contourFillRatios
// ---------------------------------------------------------------------------

describe('contourFillRatios', () => {
  it('returns an empty array when there are no contours', () => {
    const contours: ContourMetrics[][][] = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
    expect(contourFillRatios(contours)).toEqual([]);
  });

  it('flattens fill ratios across cells, preserving multiple contours per cell', () => {
    const contours: ContourMetrics[][][] = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
    contours[0]![0] = [{ width: 24, height: 30, area: 581 }]; // ~0.8069
    contours[3]![4] = [
      { width: 11, height: 52, area: 84 },  // ~0.1469
      { width: 20, height: 20, area: 80 },  // 0.2
    ];
    const ratios = contourFillRatios(contours);
    expect(ratios).toHaveLength(3);
    expect(ratios[0]).toBeCloseTo(581 / (24 * 30), 5);
    expect(ratios[1]).toBeCloseTo(84 / (11 * 52), 5);
    expect(ratios[2]).toBeCloseTo(80 / (20 * 20), 5);
  });
});
```

- [ ] **Step 4: Run tests to verify pass (and check for any remaining `scanCells` references)**

Run: `cd web && npx vitest run src/image/cellScan.test.ts`
Expected: PASS.

Then check no other file still imports `scanCells`:

Run: `cd web && grep -rn "scanCells" src/`
Expected: no matches (Task 5 of this sprint updates `inpImage.ts`, which is the
only other caller — if this grep returns a match in `inpImage.ts` at this point,
that's expected and will be fixed in Task 5; if it appears anywhere else,
investigate before proceeding).

- [ ] **Step 5: Commit**

```bash
git add web/src/image/cellScan.ts web/src/image/cellScan.test.ts
git commit -m "refactor: split scanCells into collectCageTotalContours and scanClassicDigits"
```

Note: this commit leaves `inpImage.ts` referencing the now-deleted `scanCells` —
`tsc` will fail. That's expected; Task 5 fixes it. If your bronze-gate pre-commit
hook blocks this commit due to the `tsc` failure in `inpImage.ts`, combine this
task's commit with Task 5's (do Tasks 1-5 of this sprint, then commit once at the
end of Task 5). Either ordering is fine — the step numbering above is for clarity,
not a strict commit boundary.

---

## Task 2: `CageThresholdCalibrationReport` (shared telemetry type)

**Files:**
- Create: `shared/src/reports/CageThresholdCalibrationReport.ts`
- Modify: `shared/src/reports/index.ts`
- Test: `web/src/shared-reports.test.ts`

- [ ] **Step 1: Write the failing round-trip test**

Add to `web/src/shared-reports.test.ts`, in the `describe('parseAnyReport', ...)`
block (alongside the other `round-trips a ... report` tests):

```ts
  it('round-trips a cage-threshold-calibration report', () => {
    const r = {
      ...base,
      reportType: 'cage-threshold-calibration',
      chosenThreshold: 0.3,
      fallbackUsed: false,
      candidates: [
        { threshold: 0.1, valid: false, margin: 0.05 },
        { threshold: 0.3, valid: true, margin: 0.12 },
      ],
      contourFillRatios: [0.15, 0.81, 0.2],
    };
    const parsed = parseAnyReport(r);
    expect(parsed).not.toBeNull();
    expect(parsed!.reportType).toBe('cage-threshold-calibration');
  });

  it('returns null for a cage-threshold-calibration report missing contourFillRatios', () => {
    const r = {
      ...base,
      reportType: 'cage-threshold-calibration',
      chosenThreshold: 0.3,
      fallbackUsed: false,
      candidates: [],
    };
    expect(parseAnyReport(r)).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/shared-reports.test.ts`
Expected: FAIL — `parseAnyReport` returns `null` for the first new test (unknown
reportType), so `expect(parsed).not.toBeNull()` fails.

- [ ] **Step 3: Create `CageThresholdCalibrationReport.ts`**

Create `shared/src/reports/CageThresholdCalibrationReport.ts`:

```ts
import type { ReportBase } from '../report.js';

/** Per-candidate calibration outcome — mirrors `ThresholdCandidateResult` in cellScan.ts. */
export interface CageThresholdCandidateResult {
  readonly threshold: number;
  readonly valid: boolean;
  readonly margin: number;
}

/**
 * Telemetry for per-image cage-total fill-ratio calibration
 * (`calibrateCageTotalThreshold` in `web/src/image/cellScan.ts`).
 *
 * Captures the chosen threshold, whether the fallback was used, the full
 * candidate sweep, and the raw flattened contour fill ratios — enough data to
 * re-tune the candidate sweep or margin rule from real-world images later.
 */
export interface CageThresholdCalibrationReport extends ReportBase {
  readonly reportType: 'cage-threshold-calibration';
  readonly chosenThreshold: number;
  readonly fallbackUsed: boolean;
  readonly candidates: readonly CageThresholdCandidateResult[];
  readonly contourFillRatios: readonly number[];
}

export namespace CageThresholdCalibrationReport {
  export function is(value: unknown): value is CageThresholdCalibrationReport {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v['reportType'] !== 'cage-threshold-calibration') return false;
    if (typeof v['reportedAt'] !== 'string') return false;
    if (typeof v['appVersion'] !== 'string') return false;
    if (typeof v['userAgent'] !== 'string') return false;
    if (typeof v['chosenThreshold'] !== 'number') return false;
    if (typeof v['fallbackUsed'] !== 'boolean') return false;
    if (!isCandidates(v['candidates'])) return false;
    if (!isNumberArray(v['contourFillRatios'])) return false;
    return true;
  }

  function isCandidates(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return (value as unknown[]).every(c => {
      if (typeof c !== 'object' || c === null) return false;
      const cv = c as Record<string, unknown>;
      return typeof cv['threshold'] === 'number'
        && typeof cv['valid'] === 'boolean'
        && typeof cv['margin'] === 'number';
    });
  }

  function isNumberArray(value: unknown): boolean {
    return Array.isArray(value) && (value as unknown[]).every(x => typeof x === 'number');
  }

  export function storageKey(r: CageThresholdCalibrationReport, uuid: string): string {
    return `cage-threshold-calibration/${r.reportedAt}-${uuid}.json`;
  }

  export function r2Metadata(r: CageThresholdCalibrationReport): Record<string, string> {
    return {
      appVersion: r.appVersion,
      chosenThreshold: String(r.chosenThreshold),
      fallbackUsed: String(r.fallbackUsed),
    };
  }
}
```

- [ ] **Step 4: Register the new report type in `shared/src/reports/index.ts`**

In `shared/src/reports/index.ts`:

1. Add the export near the top:
```ts
export { CageThresholdCalibrationReport } from './CageThresholdCalibrationReport.js';
```

2. Add the type import:
```ts
import type { CageThresholdCalibrationReport } from './CageThresholdCalibrationReport.js';
```

3. Add the namespace import (for `parseAnyReport`):
```ts
import { CageThresholdCalibrationReport as CTCR } from './CageThresholdCalibrationReport.js';
```

4. Add to the `AnyReport` union:
```ts
export type AnyReport =
  | TrainingExport
  | PuzzleSpecExport
  | StallStateExport
  | FeedbackReport
  | RuleBugReport
  | TriggerMissReport
  | CageThresholdCalibrationReport;
```

5. Add to `parseAnyReport` (its `reportType` string is unique, so position
   relative to the others doesn't matter for correctness — add it first):
```ts
export function parseAnyReport(value: unknown): AnyReport | null {
  if (CTCR.is(value)) return value;
  if (RBR.is(value)) return value;
  if (TMR.is(value)) return value;
  if (FR.is(value)) return value;
  if (SSE.is(value)) return value;
  if (PSE.is(value)) return value;
  if (TE.is(value)) return value;
  return null;
}
```

The exact final file should look like:

```ts
export { TrainingExport } from './TrainingExport.js';
export type { TrainingSample } from './TrainingExport.js';
export { PuzzleSpecExport } from './PuzzleSpecExport.js';
export { StallStateExport } from './StallStateExport.js';
export { FeedbackReport } from './FeedbackReport.js';
export { RuleBugReport } from './RuleBugReport.js';
export { TriggerMissReport } from './TriggerMissReport.js';
export type { TriggerMissReproductionBundle } from './TriggerMissReport.js';
export { CageThresholdCalibrationReport } from './CageThresholdCalibrationReport.js';

import type { TrainingExport } from './TrainingExport.js';
import type { PuzzleSpecExport } from './PuzzleSpecExport.js';
import type { StallStateExport } from './StallStateExport.js';
import type { FeedbackReport } from './FeedbackReport.js';
import type { RuleBugReport } from './RuleBugReport.js';
import type { TriggerMissReport } from './TriggerMissReport.js';
import type { CageThresholdCalibrationReport } from './CageThresholdCalibrationReport.js';
import { RuleBugReport as RBR } from './RuleBugReport.js';
import { TriggerMissReport as TMR } from './TriggerMissReport.js';
import { FeedbackReport as FR } from './FeedbackReport.js';
import { StallStateExport as SSE } from './StallStateExport.js';
import { PuzzleSpecExport as PSE } from './PuzzleSpecExport.js';
import { TrainingExport as TE } from './TrainingExport.js';
import { CageThresholdCalibrationReport as CTCR } from './CageThresholdCalibrationReport.js';

export type AnyReport =
  | TrainingExport
  | PuzzleSpecExport
  | StallStateExport
  | FeedbackReport
  | RuleBugReport
  | TriggerMissReport
  | CageThresholdCalibrationReport;

/**
 * Parse an unknown value as any known report type. Returns null if none match.
 * Validators are tried in specificity order — more-discriminating checks first.
 */
export function parseAnyReport(value: unknown): AnyReport | null {
  if (CTCR.is(value)) return value;
  if (RBR.is(value)) return value;
  if (TMR.is(value)) return value;
  if (FR.is(value)) return value;
  if (SSE.is(value)) return value;
  if (PSE.is(value)) return value;
  if (TE.is(value)) return value;
  return null;
}

/**
 * Exhaustiveness guard for switch statements over AnyReport.reportType.
 * Place in the default branch: assertNeverReport(report);
 */
export function assertNeverReport(report: never): never {
  throw new Error(`Unhandled report type: ${(report as { reportType: string }).reportType}`);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/shared-reports.test.ts`
Expected: PASS, both new tests.

- [ ] **Step 6: Commit**

```bash
git add shared/src/reports/CageThresholdCalibrationReport.ts shared/src/reports/index.ts web/src/shared-reports.test.ts
git commit -m "feat: add CageThresholdCalibrationReport telemetry type"
```

---

## Task 3: Worker case for `cage-threshold-calibration`

**Files:**
- Modify: `worker/src/index.ts`

`assertNeverReport`'s exhaustiveness check means `worker/src/index.ts` will now
fail to compile until a `case 'cage-threshold-calibration'` is added. This report
is pure tuning telemetry — store it in R2, no GitHub comment (unlike `stall` /
`trigger-miss`).

- [ ] **Step 1: Add the import**

In `worker/src/index.ts`, add to the import block at the top:

```ts
import { CageThresholdCalibrationReport } from '../../shared/src/reports/CageThresholdCalibrationReport.js';
```

- [ ] **Step 2: Add the switch case**

Add a new case in the `switch (report.reportType)` block, before `default:`
(position doesn't matter functionally — add it after the `'trigger-miss'` case
for readability):

```ts
      case 'cage-threshold-calibration': {
        const key = CageThresholdCalibrationReport.storageKey(report, crypto.randomUUID());
        await env.TRAINING_BUCKET.put(key, JSON.stringify(body), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: CageThresholdCalibrationReport.r2Metadata(report),
        });
        return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
      }
```

- [ ] **Step 3: Type-check the worker**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors. (This is not covered by the bronze gate, which only runs
`tsc` from `web/` — run it explicitly here.)

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: store cage-threshold-calibration reports in R2"
```

---

## Task 4: `submitCageThresholdCalibrationReport`

**Files:**
- Modify: `web/src/image/trainingUpload.ts`

- [ ] **Step 1: Add the type export and submit function**

In `web/src/image/trainingUpload.ts`, add the type re-export near the top
(alongside the other report type re-exports):

```ts
export type { CageThresholdCalibrationReport } from '../../../shared/src/reports/CageThresholdCalibrationReport.js';
```

And add the import used by the submit function, alongside the other type imports:

```ts
import type { CageThresholdCalibrationReport } from '../../../shared/src/reports/CageThresholdCalibrationReport.js';
```

Then add the submit function, after `submitTriggerMissReport`:

```ts
/** Submit a cage-threshold-calibration report. Silently dropped when consent is absent. */
export function submitCageThresholdCalibrationReport(
  report: Omit<CageThresholdCalibrationReport, 'reportType' | 'reportedAt' | 'appVersion' | 'userAgent'>,
): void {
  if (!hasConsent()) return;
  const payload: CageThresholdCalibrationReport = {
    reportType: 'cage-threshold-calibration',
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  };
  postToWorker(payload);
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/image/trainingUpload.ts
git commit -m "feat: add submitCageThresholdCalibrationReport"
```

---

## Task 5: Wire calibration into `inpImage.ts`

**Files:**
- Modify: `web/src/image/inpImage.ts`

- [ ] **Step 1: Update imports**

In `web/src/image/inpImage.ts`, replace:

```ts
import { scanCells, detectRotation, detectPuzzleType } from './cellScan.js';
```

with:

```ts
import {
  collectCageTotalContours, scanClassicDigits, calibrateCageTotalThreshold,
  contourFillRatios, detectRotation, detectPuzzleType,
} from './cellScan.js';
```

Also add the telemetry submit import, alongside any existing `trainingUpload.js`
imports in this file (check with `grep -n "trainingUpload" web/src/image/inpImage.ts`
— if `inpImage.ts` does not currently import from `trainingUpload.js`, add a new
import line):

```ts
import { submitCageThresholdCalibrationReport } from './trainingUpload.js';
```

- [ ] **Step 2: Replace the Stage 3 `scanCells` call**

Replace:

```ts
  // --- Stage 3: Puzzle type detection ---
  const [cageConf, classicConf] = scanCells(
    cv, warpedGryMat, subres, config.cellScan.classicMinSizeFraction, config.cellScan.cageTotalMinFillRatio,
  );
  const puzzleType = detectPuzzleType(warpedGryMat, subres, config.cellScan.tlFractionThreshold);
```

with:

```ts
  // --- Stage 3: Puzzle type detection ---
  const contourMetrics = collectCageTotalContours(cv, warpedGryMat, subres);
  const classicConf = scanClassicDigits(cv, warpedGryMat, subres, config.cellScan.classicMinSizeFraction);
  const puzzleType = detectPuzzleType(warpedGryMat, subres, config.cellScan.tlFractionThreshold);
```

Note: `cageConf` is no longer computed here — the classic path below doesn't use
it, and the killer path computes it as part of calibration in Step 3.

- [ ] **Step 3: Replace Stage 4's `clusterBorders` call with calibration**

Replace:

```ts
  // --- Killer path: Stage 4 border clustering ---
  const gryImg: GrayImage = { data: new Uint8Array(warpedGryMat.data), size: dstSize };

  const [bxProb, byProb] = clusterBorders(
    gryImg, cageConf, subres, config.borderClustering,
    config.cellScan.anchorConfidenceThreshold,
  );

  // Compute cage totals once (image-dependent only).
  let initialBorderX = bxProb.map(row => row.map(v => v > 0.5));
  let initialBorderY = byProb.map(row => row.map(v => v > 0.5));
```

with:

```ts
  // --- Killer path: Stage 4 border clustering (via per-image calibration) ---
  const gryImg: GrayImage = { data: new Uint8Array(warpedGryMat.data), size: dstSize };

  const calibration = calibrateCageTotalThreshold(
    contourMetrics, gryImg, subres,
    config.cellScan.cageTotalFillRatioCandidates,
    config.borderClustering, config.cellScan.anchorConfidenceThreshold,
    config.cellScan.cageTotalMinFillRatio,
  );
  const cageConf = calibration.cageConf;
  const bxProb = calibration.borderXProb;
  const byProb = calibration.borderYProb;

  submitCageThresholdCalibrationReport({
    chosenThreshold: calibration.threshold,
    fallbackUsed: calibration.fallbackUsed,
    candidates: calibration.candidateResults,
    contourFillRatios: contourFillRatios(contourMetrics),
  });

  // Compute cage totals once (image-dependent only).
  let initialBorderX = calibration.borderX;
  let initialBorderY = calibration.borderY;
```

This preserves `bxProb`/`byProb` (needed by the existing flip-search loop further
down, which reads `bxProb.map(...)`/`byProb.map(...)`) while avoiding a second
`clusterBorders` call — `calibrateCageTotalThreshold` already ran it once for the
chosen threshold.

- [ ] **Step 4: Check `clusterBorders` is still imported if used elsewhere**

Run: `cd web && grep -n "clusterBorders" src/image/inpImage.ts`

If `clusterBorders` is no longer referenced anywhere in `inpImage.ts` after Step 3,
remove its import:

```ts
import { clusterBorders } from './borderClustering.js';
```

(Keep `import type { GrayImage } from './borderClustering.js';` — `gryImg` still
uses this type.)

- [ ] **Step 5: Type-check and run the full test suite**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. This confirms `scanCells` is no longer referenced anywhere.

Run: `cd web && npx vitest run`
Expected: all existing tests pass (no pipeline-level test exercises this path with
real OpenCV, so this mainly confirms nothing else broke).

- [ ] **Step 6: Verify against `KS1019_P.jpg` via `/tmp/cvrun`**

The `/tmp/cvrun` harness (esbuild-bundled, real opencv.js) already has
`warpedgry.json` (warped grayscale data for `KS1019_P.jpg`) from earlier
debugging. Add the new functions to the harness entry point and rebuild:

In `/tmp/cvrun/entry.ts`, add:

```ts
export { collectCageTotalContours, calibrateCageTotalThreshold, cageConfFromContours } from '/home/user/cagedoku/web/src/image/cellScan.ts';
```

Rebuild with the same esbuild invocation used to produce the existing
`pipeline.cjs`/`cellScan.cjs` (check `/tmp/cvrun` for the build command in shell
history, or re-run, e.g.):

```bash
cd /tmp/cvrun && npx esbuild entry.ts --bundle --platform=node --format=cjs --outfile=pipeline.cjs
```

Then write a small verification script `/tmp/cvrun/verify_calibration.cjs`:

```js
const cvReady = require('./opencv.js');
const fs = require('fs');
const p = require('./pipeline.cjs');
const { defaultBorderClusteringConfig, defaultCellScanConfig } = require('./pipeline.cjs');
const { size, data } = JSON.parse(fs.readFileSync('/tmp/cvrun/warpedgry.json'));

(cvReady.then ? cvReady : Promise.resolve(cvReady)).then(cv => {
  const warpedGry = cv.matFromArray(size, size, cv.CV_8UC1, Uint8Array.from(data));
  const subres = 128;

  const contours = p.collectCageTotalContours(cv, warpedGry, subres);

  const cellScanConfig = defaultCellScanConfig();
  const borderClusteringConfig = defaultBorderClusteringConfig();
  const grayImg = { data: Uint8Array.from(data), size };

  const result = p.calibrateCageTotalThreshold(
    contours, grayImg, subres,
    cellScanConfig.cageTotalFillRatioCandidates,
    borderClusteringConfig, cellScanConfig.anchorConfidenceThreshold,
    cellScanConfig.cageTotalMinFillRatio,
  );

  console.log('chosen threshold:', result.threshold);
  console.log('fallback used:', result.fallbackUsed);
  console.log('candidates:', result.candidateResults);

  // cell (0,5) was the known false-positive dash segment (fillRatio ~0.15).
  console.log('cageConf[0][5] (should be 0, was the dash false-positive):', result.cageConf[0][5]);
  // cells (0,0) and (0,1) had real digit contours ("20" and "11", fillRatio 0.50-0.81).
  console.log('cageConf[0][0]:', result.cageConf[0][0]);
  console.log('cageConf[0][1]:', result.cageConf[0][1]);
}).catch(e => console.error('ERR', e));
```

Run: `cd /tmp/cvrun && node verify_calibration.cjs`

Expected: `result.cageConf[0][5]` is `0` (dash segment correctly excluded), and
`cageConf[0][0]`/`cageConf[0][1]` are `1` (real digit contours correctly included)
— matching or improving on the manually-chosen 0.3 threshold's behaviour from the
prior bugfix. `fallbackUsed` should ideally be `false` for this image (a candidate
threshold validates).

If `cageConf[0][5]` is `1` (regression) or `cageConf[0][0]`/`cageConf[0][1]` are
`0`, use `superpowers:systematic-debugging`: print `result.candidateResults` to
see which thresholds validated and their margins, and inspect
`contourFillRatios(contours)` to see the actual fillRatio distribution for this
image — do not adjust the production code until you understand why the chosen
threshold differs from expectations.

- [ ] **Step 7: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh` (from repo root)
Expected: `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test` all pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/image/inpImage.ts
git commit -m "feat: wire per-image cage-total threshold calibration into the pipeline"
```

---

## Task 6: Silver gate and doc hygiene

**Files:**
- Modify: `docs/architecture.md` (or `docs/image-pipeline.md` if cell-scan/Stage 3-4
  details live there — check which doc currently describes `scanCells`/Stage 3/4
  before editing)
- Delete: `docs/superpowers/specs/2026-06-14-cage-total-threshold-calibration-design.md`
- Delete: `docs/superpowers/plans/2026-06-14-cage-total-threshold-calibration-sprint1.md`
- Delete: `docs/superpowers/plans/2026-06-14-cage-total-threshold-calibration-sprint2.md`

This task is only run when merging to `master` — per CLAUDE.md, do not merge with
any spec or plan file remaining, and the live doc must describe what was actually
built (not a summary or pointer back to the spec).

- [ ] **Step 1: Find which live doc describes Stage 3/4 of the cell-scan pipeline**

Run: `grep -rln "scanCells\|cageTotalMinFillRatio\|Stage 3\|Stage 4" docs/architecture.md docs/image-pipeline.md 2>/dev/null`

- [ ] **Step 2: Update the live doc**

Replace any description of the fixed `cageTotalMinFillRatio`-only cage-total
detection with a description of the new flow: `collectCageTotalContours` →
`calibrateCageTotalThreshold` (search over `cageTotalFillRatioCandidates`,
validated via `validateCageGeometry`, falling back to `cageTotalMinFillRatio` if
none validate) → `cageConf`/`borderX`/`borderY` feed Stage 4/5 as before. Mention
the `CageThresholdCalibrationReport` telemetry (consent-gated, stored in R2 under
`cage-threshold-calibration/`).

- [ ] **Step 3: Verify all plan steps are checked off, then delete spec and plan files**

```bash
git rm docs/superpowers/specs/2026-06-14-cage-total-threshold-calibration-design.md \
       docs/superpowers/plans/2026-06-14-cage-total-threshold-calibration-sprint1.md \
       docs/superpowers/plans/2026-06-14-cage-total-threshold-calibration-sprint2.md
```

- [ ] **Step 4: Run the silver gate from `web/`**

```bash
cd web
tsc --noEmit
npm test -- --reporter=verbose
npx playwright test
npx playwright test --config playwright.dev.config.ts
```

Expected: all pass.

- [ ] **Step 5: Merge to master per `superpowers:finishing-a-development-branch`**

Follow the master commit sequence in CLAUDE.md (`bash scripts/run-silver-gate.sh`
then `git merge`/`git commit`), and delete the feature branch afterward.

---

## Sprint 2 Completion Check

At the end of this sprint:
- `scanCells` no longer exists; `collectCageTotalContours` and
  `scanClassicDigits` are exported from `web/src/image/cellScan.ts`.
- `CageThresholdCalibrationReport` is registered in `AnyReport`, handled by the
  worker, and submitted from `inpImage.ts` via `submitCageThresholdCalibrationReport`.
- `inpImage.ts`'s killer path uses `calibrateCageTotalThreshold` instead of a
  fixed-threshold `scanCells` + separate `clusterBorders` call.
- Verified against `KS1019_P.jpg` via `/tmp/cvrun`: the known dash false-positive
  at cell (0,5) is excluded, and real digit cells (0,0)/(0,1) are included.
- Bronze gate passes after every commit; silver gate passes before merge.
- Doc hygiene complete: spec and both plan files deleted, live doc updated.
