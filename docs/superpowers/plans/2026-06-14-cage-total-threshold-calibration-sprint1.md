# Cage-Total Threshold Calibration — Sprint 1: Pure Calibration Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and test all pure (no-OpenCV) functions for per-image cage-total
fill-ratio calibration: `validateCageGeometry`, `cageConfFromContours`,
`thresholdMargin`, `pickBestThreshold`, `calibrateCageTotalThreshold`, plus the
`cageTotalFillRatioCandidates` config field. Nothing in this sprint touches OpenCV,
the pipeline (`inpImage.ts`), or telemetry — those are Sprint 2.

**Architecture:** `validateCageGeometry` (validation.ts) reuses the existing private
`buildUnionFind` helper to do structural-only cage checks. `cageConfFromContours`,
`thresholdMargin`, `pickBestThreshold`, and `calibrateCageTotalThreshold` live in
`cellScan.ts` and operate on a new `ContourMetrics` type. `calibrateCageTotalThreshold`
calls the existing pure `clusterBorders` (borderClustering.ts) directly — no
dependency injection needed, since `clusterBorders` has no OpenCV dependency.

**Tech Stack:** TypeScript, Vitest. Reference design:
`docs/superpowers/specs/2026-06-14-cage-total-threshold-calibration-design.md`.

---

## Task 1: Config — `cageTotalFillRatioCandidates`

**Files:**
- Modify: `web/src/image/config.ts`

- [ ] **Step 1: Add the new field to `CellScanConfig` and its default**

In `web/src/image/config.ts`, add a new field to the `CellScanConfig` interface
(after `cageTotalMinFillRatio`):

```ts
  /**
   * Minimum contour fill ratio (area / boundingBoxArea) for a top-left-quadrant
   * contour to count as a cage-total digit. Distinguishes solid digit glyphs
   * (observed fillRatio 0.50-0.81) from thin dashed cage-border-line segments
   * (observed fillRatio ~0.15), which otherwise pass the bounding-box size check.
   *
   * This is the fallback threshold used when no candidate in
   * `cageTotalFillRatioCandidates` yields a valid cage geometry.
   */
  readonly cageTotalMinFillRatio: number;
  /**
   * Candidate fill-ratio thresholds tried during per-image cage-total
   * calibration, spanning the observed dash cluster (~0.15) to digit cluster
   * (~0.50-0.81).
   */
  readonly cageTotalFillRatioCandidates: readonly number[];
```

And update `defaultCellScanConfig()`:

```ts
export function defaultCellScanConfig(): CellScanConfig {
  return {
    classicMinSizeFraction: 1.0 / 3.0,
    anchorConfidenceThreshold: 0.5,
    tlFractionThreshold: 0.40,
    rotationDominanceThreshold: 0.50,
    cageTotalMinFillRatio: 0.3,
    cageTotalFillRatioCandidates: [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50],
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (this is a pure additive change to an existing interface).

- [ ] **Step 3: Commit**

```bash
git add web/src/image/config.ts
git commit -m "feat: add cageTotalFillRatioCandidates config for per-image calibration"
```

---

## Task 2: `validateCageGeometry` in `validation.ts`

**Files:**
- Modify: `web/src/image/validation.ts`
- Test: `web/src/image/validation.test.ts`

`validateCageGeometry` extracts the structural checks (every cell assigned exactly
once, no double-assigned regions) from `validateCageLayout`, without the
total-range check, returning `false` instead of throwing on failure.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/image/validation.test.ts` (it already imports `describe`, `expect`,
`it`, and has `allWallsBorderX`/`allWallsBorderY` fixtures). Add this import:

```ts
import { validateCageLayout, repairCageTotals, validateCageGeometry } from './validation.js';
```

Then add a new describe block:

```ts
// ---------------------------------------------------------------------------
// validateCageGeometry
// ---------------------------------------------------------------------------

describe('validateCageGeometry', () => {
  it('accepts 81 single-cell cages, each with a head flag (trivial spec)', () => {
    const heads = Array.from({ length: 9 }, () => new Array<number>(9).fill(1));
    expect(validateCageGeometry(heads, allWallsBorderX(), allWallsBorderY())).toBe(true);
  });

  it('rejects when no cell has a head flag (unassigned region)', () => {
    const heads = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    expect(validateCageGeometry(heads, allWallsBorderX(), allWallsBorderY())).toBe(false);
  });

  it('accepts a 2-cell cage spanning rows 0-1 in col 0 with one head flag', () => {
    const borderX = allWallsBorderX();
    borderX[0]![0] = false; // open wall between (0,0) and (1,0)

    const heads = Array.from({ length: 9 }, () => new Array<number>(9).fill(1));
    heads[1]![0] = 0; // merged cell has no head

    expect(validateCageGeometry(heads, borderX, allWallsBorderY())).toBe(true);
  });

  it('rejects when two head flags fall in the same connected component', () => {
    const borderX = allWallsBorderX();
    borderX[0]![0] = false; // (0,0) and (1,0) are one component

    const heads = Array.from({ length: 9 }, () => new Array<number>(9).fill(1));
    // heads[0][0] and heads[1][0] both non-zero, but they're now one component.

    expect(validateCageGeometry(heads, borderX, allWallsBorderY())).toBe(false);
  });

  it('rejects when a non-head cell is left unassigned (component has no head)', () => {
    const borderX = allWallsBorderX();
    borderX[0]![0] = false; // (0,0) and (1,0) are one component

    const heads = Array.from({ length: 9 }, () => new Array<number>(9).fill(1));
    heads[0]![0] = 0;
    heads[1]![0] = 0; // neither cell in this component has a head

    expect(validateCageGeometry(heads, borderX, allWallsBorderY())).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/image/validation.test.ts`
Expected: FAIL — `validateCageGeometry` is not exported from `./validation.js`.

- [ ] **Step 3: Implement `validateCageGeometry`**

In `web/src/image/validation.ts`, add this function after `buildUnionFind` (it must
be exported, unlike `buildUnionFind`):

```ts
/**
 * Structural-only cage-geometry check: every cell belongs to exactly one
 * connected component, every component has exactly one head cell (non-zero
 * `cageHeadFlags`), and no component has more than one head.
 *
 * Unlike `validateCageLayout`, this does NOT check cage-total ranges (real
 * digit values aren't known yet at calibration time) and returns `false` on
 * failure instead of throwing — failure is an expected, common outcome during
 * threshold search.
 *
 * @param cageHeadFlags - (9, 9) array [row][col]; non-zero marks a cage head.
 * @param borderX - (9, 8) horizontal cage-wall flags [col][rowGap].
 * @param borderY - (8, 9) vertical cage-wall flags [colGap][row].
 */
export function validateCageGeometry(
  cageHeadFlags: number[][],
  borderX: boolean[][],
  borderY: boolean[][],
): boolean {
  const { find, members } = buildUnionFind(borderX, borderY);

  const regions: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  let reg = 0;

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (cageHeadFlags[row]![col]! !== 0) {
        const repKey = find(cellKey([row, col]));
        const component = members.get(repKey)!;

        for (const k of component) {
          const [r, c] = keyToCell(k);
          if (regions[r]![c]! !== 0) return false; // region reassigned
        }

        reg += 1;
        for (const k of component) {
          const [r, c] = keyToCell(k);
          regions[r]![c] = reg;
        }
      }
    }
  }

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (regions[r]![c]! === 0) return false; // unassigned region
    }
  }

  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/image/validation.test.ts`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add web/src/image/validation.ts web/src/image/validation.test.ts
git commit -m "feat: add validateCageGeometry for structural-only cage checks"
```

---

## Task 3: `ContourMetrics` and `cageConfFromContours`

**Files:**
- Modify: `web/src/image/cellScan.ts`
- Test: `web/src/image/cellScan.test.ts`

`isCageTotalContour` currently does both a bounding-box size check and a fill-ratio
check in one function. Split out the size check so `collectCageTotalContours`
(Sprint 2) can use it without needing a fill-ratio threshold yet.

- [ ] **Step 1: Write the failing test for `cageConfFromContours`**

Add to `web/src/image/cellScan.test.ts`. Add this import:

```ts
import { computeQuadSums, detectPuzzleType, detectRotation, isCageTotalContour, cageConfFromContours } from './cellScan.js';
import type { ContourMetrics } from './cellScan.js';
```

Then add a new describe block (after the `isCageTotalContour` block):

```ts
// ---------------------------------------------------------------------------
// cageConfFromContours
// ---------------------------------------------------------------------------

describe('cageConfFromContours', () => {
  /** Build a 9x9 grid of empty contour lists. */
  function emptyContours(): ContourMetrics[][][] {
    return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
  }

  it('returns all-zero when no cell has any contours', () => {
    const result = cageConfFromContours(emptyContours(), SUBRES_FULL, 0.3);
    for (const row of result) for (const v of row) expect(v).toBe(0);
  });

  it('returns 1.0 for a cell with a real-digit contour (fillRatio 0.81) at threshold 0.3', () => {
    const contours = emptyContours();
    contours[0]![0] = [{ width: 24, height: 30, area: 581 }]; // fillRatio ~0.81
    const result = cageConfFromContours(contours, SUBRES_FULL, 0.3);
    expect(result[0]![0]).toBe(1.0);
    expect(result[0]![1]).toBe(0);
  });

  it('returns 0.0 for a cell with only a dash-segment contour (fillRatio 0.15) at threshold 0.3', () => {
    const contours = emptyContours();
    contours[0]![0] = [{ width: 11, height: 52, area: 84 }]; // fillRatio ~0.15
    const result = cageConfFromContours(contours, SUBRES_FULL, 0.3);
    expect(result[0]![0]).toBe(0);
  });

  it('returns 1.0 for the same dash-segment contour at threshold 0.10 (lower than its fillRatio)', () => {
    const contours = emptyContours();
    contours[0]![0] = [{ width: 11, height: 52, area: 84 }]; // fillRatio ~0.15
    const result = cageConfFromContours(contours, SUBRES_FULL, 0.10);
    expect(result[0]![0]).toBe(1.0);
  });

  it('returns 1.0 if any contour in a cell passes, even if others do not', () => {
    const contours = emptyContours();
    contours[3]![4] = [
      { width: 11, height: 52, area: 84 },   // fillRatio ~0.15, fails at 0.3
      { width: 24, height: 30, area: 581 },  // fillRatio ~0.81, passes at 0.3
    ];
    const result = cageConfFromContours(contours, SUBRES_FULL, 0.3);
    expect(result[3]![4]).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/image/cellScan.test.ts`
Expected: FAIL — `cageConfFromContours` and `ContourMetrics` are not exported.

- [ ] **Step 3: Implement `ContourMetrics` and `cageConfFromContours`**

In `web/src/image/cellScan.ts`, refactor `isCageTotalContour` to extract the size
check, and add `ContourMetrics` + `cageConfFromContours`. Replace the existing
`isCageTotalContour` function with:

```ts
/**
 * Bounding-box size heuristic for a cage-total digit contour in a cell's
 * top-left quadrant, independent of fill ratio. Both real digit glyphs and
 * thin dashed cage-border-line segments can pass this check — `isCageTotalContour`
 * additionally applies a fill-ratio threshold to distinguish them.
 *
 * @param width - Contour bounding-box width.
 * @param height - Contour bounding-box height.
 * @param subres - Pixels per cell side.
 */
export function isCageTotalContourSize(width: number, height: number, subres: number): boolean {
  const minW = subres >> 4;
  const maxW = subres >> 1;
  const minH = subres >> 3;
  const maxH = subres >> 1;

  return width >= minW && width < maxW && height >= minH && height < maxH;
}

/**
 * Decide whether a contour found in a cell's top-left quadrant represents a
 * cage-total digit glyph, as opposed to a thin dashed cage-border-line segment.
 *
 * Both pass `isCageTotalContourSize`, but a digit glyph fills a much larger
 * fraction of its bounding box than a thin dash does. A dash segment (e.g.
 * width=11, height=52, area=84) has fillRatio ~0.15, while real digit contours
 * observed in practice have fillRatio 0.50-0.81. `minFillRatio` separates the two.
 *
 * @param width - Contour bounding-box width.
 * @param height - Contour bounding-box height.
 * @param area - Contour area (from `cv.contourArea`).
 * @param subres - Pixels per cell side.
 * @param minFillRatio - Minimum area / (width * height) to count as a digit.
 */
export function isCageTotalContour(
  width: number,
  height: number,
  area: number,
  subres: number,
  minFillRatio: number,
): boolean {
  if (!isCageTotalContourSize(width, height, subres)) return false;

  const fillRatio = area / (width * height);
  return fillRatio >= minFillRatio;
}

/**
 * Bounding-box and area of a contour that passed `isCageTotalContourSize`,
 * collected by `collectCageTotalContours` (Sprint 2) for later fill-ratio
 * evaluation at any candidate threshold without re-running OpenCV.
 */
export interface ContourMetrics {
  readonly width: number;
  readonly height: number;
  readonly area: number;
}

/**
 * Per-cell cage-total confidence at a given fill-ratio threshold.
 *
 * Pure function: for each cell, returns `1.0` if any of its size-valid
 * contours satisfies `isCageTotalContour`'s fill-ratio check at `minFillRatio`,
 * else `0.0`.
 *
 * @param contours - (9, 9) array [row][col] of size-valid contour metrics,
 *   as returned by `collectCageTotalContours`.
 * @param subres - Pixels per cell side.
 * @param minFillRatio - Minimum area / (width * height) to count as a digit.
 * @returns (9, 9) array [row][col] with values in {0.0, 1.0}.
 */
export function cageConfFromContours(
  contours: ContourMetrics[][][],
  subres: number,
  minFillRatio: number,
): number[][] {
  return contours.map(rowContours =>
    rowContours.map(cellContours =>
      cellContours.some(c => isCageTotalContour(c.width, c.height, c.area, subres, minFillRatio)) ? 1.0 : 0.0,
    ),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/image/cellScan.test.ts`
Expected: PASS, all tests including the 5 new ones. The existing
`isCageTotalContour` tests must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/image/cellScan.ts web/src/image/cellScan.test.ts
git commit -m "feat: add ContourMetrics and cageConfFromContours for threshold calibration"
```

---

## Task 4: `thresholdMargin` and `pickBestThreshold`

**Files:**
- Modify: `web/src/image/cellScan.ts`
- Test: `web/src/image/cellScan.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/src/image/cellScan.test.ts`. Extend the import:

```ts
import {
  computeQuadSums, detectPuzzleType, detectRotation, isCageTotalContour,
  cageConfFromContours, thresholdMargin, pickBestThreshold,
} from './cellScan.js';
import type { ContourMetrics, ThresholdCandidateResult } from './cellScan.js';
```

Then add:

```ts
// ---------------------------------------------------------------------------
// thresholdMargin
// ---------------------------------------------------------------------------

describe('thresholdMargin', () => {
  function emptyContours(): ContourMetrics[][][] {
    return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
  }

  it('returns Infinity when there are no contours', () => {
    expect(thresholdMargin(emptyContours(), SUBRES_FULL, 0.3)).toBe(Infinity);
  });

  it('returns the distance from threshold to a single contour fillRatio', () => {
    const contours = emptyContours();
    contours[0]![0] = [{ width: 24, height: 30, area: 581 }]; // fillRatio ~0.8069
    const margin = thresholdMargin(contours, SUBRES_FULL, 0.3);
    expect(margin).toBeCloseTo(581 / (24 * 30) - 0.3, 5);
  });

  it('returns the minimum distance across multiple contours', () => {
    const contours = emptyContours();
    // fillRatios: ~0.1615 (dash) and ~0.8069 (digit)
    contours[0]![0] = [{ width: 11, height: 52, area: 84 }];
    contours[0]![1] = [{ width: 24, height: 30, area: 581 }];
    const margin = thresholdMargin(contours, SUBRES_FULL, 0.3);
    const dashRatio = 84 / (11 * 52);
    const digitRatio = 581 / (24 * 30);
    expect(margin).toBeCloseTo(Math.min(Math.abs(dashRatio - 0.3), Math.abs(digitRatio - 0.3)), 5);
  });
});

// ---------------------------------------------------------------------------
// pickBestThreshold
// ---------------------------------------------------------------------------

describe('pickBestThreshold', () => {
  it('returns null when no candidate is valid', () => {
    const results: ThresholdCandidateResult[] = [
      { threshold: 0.1, valid: false, margin: 0.05 },
      { threshold: 0.3, valid: false, margin: 0.20 },
    ];
    expect(pickBestThreshold(results)).toBeNull();
  });

  it('returns the only valid candidate', () => {
    const results: ThresholdCandidateResult[] = [
      { threshold: 0.1, valid: false, margin: 0.20 },
      { threshold: 0.3, valid: true, margin: 0.05 },
    ];
    expect(pickBestThreshold(results)).toBe(0.3);
  });

  it('returns the valid candidate with the largest margin', () => {
    const results: ThresholdCandidateResult[] = [
      { threshold: 0.1, valid: true, margin: 0.05 },
      { threshold: 0.3, valid: true, margin: 0.20 },
      { threshold: 0.5, valid: true, margin: 0.10 },
    ];
    expect(pickBestThreshold(results)).toBe(0.3);
  });

  it('ignores invalid candidates even if they have the largest margin', () => {
    const results: ThresholdCandidateResult[] = [
      { threshold: 0.1, valid: true, margin: 0.05 },
      { threshold: 0.3, valid: false, margin: 0.99 },
    ];
    expect(pickBestThreshold(results)).toBe(0.1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/image/cellScan.test.ts`
Expected: FAIL — `thresholdMargin`, `pickBestThreshold`, `ThresholdCandidateResult` not exported.

- [ ] **Step 3: Implement `thresholdMargin` and `pickBestThreshold`**

In `web/src/image/cellScan.ts`, add after `cageConfFromContours`:

```ts
/**
 * Minimum distance from `threshold` to any individual size-valid contour's
 * fillRatio across all 81 cells. Larger margin = cleaner separation between
 * the dash cluster and the digit cluster at this threshold. Returns `Infinity`
 * if there are no contours at all (no information to separate).
 *
 * @param contours - (9, 9) array [row][col] of size-valid contour metrics.
 * @param subres - Pixels per cell side (unused directly, kept for symmetry
 *   with `cageConfFromContours` and future fillRatio-shape changes).
 * @param threshold - Candidate fill-ratio threshold.
 */
export function thresholdMargin(contours: ContourMetrics[][][], subres: number, threshold: number): number {
  let minDist = Infinity;
  for (const rowContours of contours) {
    for (const cellContours of rowContours) {
      for (const c of cellContours) {
        const fillRatio = c.area / (c.width * c.height);
        const dist = Math.abs(fillRatio - threshold);
        if (dist < minDist) minDist = dist;
      }
    }
  }
  return minDist;
}

/** Per-candidate calibration outcome, also used as `CageThresholdCalibrationReport.candidates`. */
export interface ThresholdCandidateResult {
  readonly threshold: number;
  readonly valid: boolean;
  readonly margin: number;
}

/**
 * Among candidates with `valid === true`, return the one with the largest
 * margin (cleanest separation). Returns `null` if none are valid.
 *
 * Isolated so a future tie-break rule can replace this body without touching
 * the calibration search loop in `calibrateCageTotalThreshold`.
 */
export function pickBestThreshold(candidateResults: readonly ThresholdCandidateResult[]): number | null {
  let best: ThresholdCandidateResult | null = null;
  for (const c of candidateResults) {
    if (!c.valid) continue;
    if (best === null || c.margin > best.margin) best = c;
  }
  return best === null ? null : best.threshold;
}
```

Note: `subres` is unused in `thresholdMargin`'s body but kept in the signature per
the design spec (`thresholdMargin(contours, subres, threshold)`) for symmetry with
`cageConfFromContours` and to avoid a signature change if a future fillRatio
definition needs it. If `tsc` reports an unused-parameter error, prefix it with an
underscore (`_subres`) — check `tsconfig.json` for `noUnusedParameters` before
choosing; if the project enables that flag, use `_subres`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/image/cellScan.test.ts`
Expected: PASS, all tests including the 7 new ones.

- [ ] **Step 5: Run full type check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (resolve any unused-parameter issue per the note above).

- [ ] **Step 6: Commit**

```bash
git add web/src/image/cellScan.ts web/src/image/cellScan.test.ts
git commit -m "feat: add thresholdMargin and pickBestThreshold for calibration tie-breaking"
```

---

## Task 5: `calibrateCageTotalThreshold`

**Files:**
- Modify: `web/src/image/cellScan.ts`
- Test: `web/src/image/cellScan.test.ts`

This is the calibration search loop itself. It calls `clusterBorders`
(borderClustering.ts, pure) and `validateCageGeometry` (validation.ts) directly.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/image/cellScan.test.ts`. Extend imports:

```ts
import {
  computeQuadSums, detectPuzzleType, detectRotation, isCageTotalContour,
  cageConfFromContours, thresholdMargin, pickBestThreshold, calibrateCageTotalThreshold,
} from './cellScan.js';
import type { ContourMetrics, ThresholdCandidateResult } from './cellScan.js';
import type { GrayImage } from './borderClustering.js';
import { defaultImagePipelineConfig, subres as cfgSubres } from './config.js';
```

Then add:

```ts
// ---------------------------------------------------------------------------
// calibrateCageTotalThreshold
// ---------------------------------------------------------------------------

describe('calibrateCageTotalThreshold', () => {
  const config = defaultImagePipelineConfig();
  const subres = cfgSubres(config); // 128
  const size = subres * 9;

  /** All 81 cells have one contour with fillRatio ~0.2 (w=20,h=20,area=80). */
  function uniformContours(): ContourMetrics[][][] {
    return Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, () => [{ width: 20, height: 20, area: 80 }]),
    );
  }

  /**
   * Image where every horizontal AND vertical inter-cell border band is dark
   * (cage-border ink), everything else white.
   */
  function imageWithAllDarkBorders(): GrayImage {
    const data = new Uint8Array(size * size).fill(255);
    const halfBand = (subres / 2) | 0;
    for (let g = 0; g < 8; g++) {
      const boundary = (g + 1) * subres;
      for (let i = boundary - halfBand; i < boundary + halfBand; i++) {
        if (i < 0 || i >= size) continue;
        for (let j = 0; j < size; j++) {
          data[i * size + j] = 30; // horizontal band
          data[j * size + i] = 30; // vertical band
        }
      }
    }
    return { data, size };
  }

  it('picks the lower candidate when it yields a valid 81-cage geometry and the higher does not', () => {
    // At threshold 0.1, fillRatio 0.2 >= 0.1 -> cageConf all 1.0 -> every cell is
    // its own cage head; with all borders dark and all anchors confident,
    // clusterBorders should classify all inner borders as cage walls -> valid.
    // At threshold 0.5, fillRatio 0.2 < 0.5 -> cageConf all 0.0 -> no cage heads
    // at all -> validateCageGeometry returns false (unassigned regions).
    const result = calibrateCageTotalThreshold(
      uniformContours(),
      imageWithAllDarkBorders(),
      subres,
      [0.1, 0.5],
      config.borderClustering,
      config.cellScan.anchorConfidenceThreshold,
      0.3, // fallbackThreshold
    );

    expect(result.fallbackUsed).toBe(false);
    expect(result.threshold).toBe(0.1);
    expect(result.candidateResults).toHaveLength(2);
    expect(result.candidateResults[0]).toEqual({ threshold: 0.1, valid: true, margin: expect.closeTo(0.1, 5) });
    expect(result.candidateResults[1]!.valid).toBe(false);
    for (const row of result.cageConf) for (const v of row) expect(v).toBe(1.0);
  });

  it('falls back to fallbackThreshold when no candidate is valid', () => {
    // fillRatio 0.2 < both 0.4 and 0.5 -> cageConf all 0.0 for both candidates
    // -> validateCageGeometry false for both -> fallback to 0.3.
    const result = calibrateCageTotalThreshold(
      uniformContours(),
      imageWithAllDarkBorders(),
      subres,
      [0.4, 0.5],
      config.borderClustering,
      config.cellScan.anchorConfidenceThreshold,
      0.3, // fallbackThreshold
    );

    expect(result.fallbackUsed).toBe(true);
    expect(result.threshold).toBe(0.3);
    expect(result.candidateResults).toHaveLength(2);
    expect(result.candidateResults.every(c => !c.valid)).toBe(true);
    // fillRatio 0.2 < 0.3 -> cageConf still all 0 at the fallback threshold too.
    for (const row of result.cageConf) for (const v of row) expect(v).toBe(0.0);
  });
});
```

> Note on `expect.closeTo`: if your Vitest version does not support
> `expect.closeTo` as an object-property matcher inside `toEqual`, replace the
> first assertion with two separate checks:
> ```ts
> expect(result.candidateResults[0]!.threshold).toBe(0.1);
> expect(result.candidateResults[0]!.valid).toBe(true);
> expect(result.candidateResults[0]!.margin).toBeCloseTo(0.1, 5);
> ```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/image/cellScan.test.ts`
Expected: FAIL — `calibrateCageTotalThreshold` is not exported.

If the test instead fails with `result.fallbackUsed` being `true` in the first
test (i.e. `clusterBorders` did not produce all-true borders for the
all-dark/all-anchored case), this means the synthetic fixture's geometry
assumption is wrong. Before changing the *implementation*, use
`superpowers:systematic-debugging`: inspect what `clusterBorders` actually
returns for `imageWithAllDarkBorders()` + `cageConf` all `1.0` (e.g. via a
scratch `console.log` of `borderX`/`borderY` in the test), and adjust the
fixture (not the production code) so it produces the intended all-walls
geometry. `clusterBorders` uses `Math.random()` for k-means restarts but with
maximally-separated clusters (all-dark vs nothing) and full anchor confidence,
it should be deterministic in practice — if it is flaky, that is a pre-existing
property of `clusterBorders` and out of scope for this plan; in that case relax
the assertion to check `result.fallbackUsed === false` and
`result.threshold === 0.1` only, without asserting on `cageConf` border shape.

- [ ] **Step 3: Implement `calibrateCageTotalThreshold`**

In `web/src/image/cellScan.ts`, add the necessary imports at the top of the file:

```ts
import { clusterBorders } from './borderClustering.js';
import type { GrayImage, BorderClusteringConfig } from './borderClustering.js';
import { validateCageGeometry } from './validation.js';
```

Check `borderClustering.ts` exports `BorderClusteringConfig` as a re-export or
import it from `./config.js` instead — `BorderClusteringConfig` is defined in
`config.ts` (see `web/src/image/config.ts`), so use:

```ts
import { clusterBorders } from './borderClustering.js';
import type { GrayImage } from './borderClustering.js';
import type { BorderClusteringConfig } from './config.js';
import { validateCageGeometry } from './validation.js';
```

Then add, after `pickBestThreshold`:

```ts
/** Full result of `calibrateCageTotalThreshold`, including the chosen geometry. */
export interface CageThresholdCalibrationResult {
  readonly threshold: number;
  readonly fallbackUsed: boolean;
  readonly cageConf: number[][];
  readonly borderX: boolean[][];
  readonly borderY: boolean[][];
  readonly borderXProb: number[][];
  readonly borderYProb: number[][];
  readonly candidateResults: ThresholdCandidateResult[];
}

/**
 * Search `candidates` for the fill-ratio threshold that yields the most
 * plausible cage geometry for this image, falling back to `fallbackThreshold`
 * if no candidate validates.
 *
 * For each candidate: derive `cageConf` via `cageConfFromContours`, cluster
 * borders via `clusterBorders`, threshold the resulting probabilities at >0.5,
 * and check structural plausibility via `validateCageGeometry`. Among valid
 * candidates, `pickBestThreshold` chooses the one with the largest
 * `thresholdMargin`. The chosen candidate's `cageConf`/`borderX`/`borderY`/
 * `borderXProb`/`borderYProb` are returned directly — `clusterBorders` is not
 * re-run for the chosen threshold.
 *
 * @param contours - (9, 9) array [row][col] of size-valid contour metrics,
 *   as returned by `collectCageTotalContours`.
 * @param warpedGry - Perspective-corrected grayscale image.
 * @param subres - Pixels per cell side.
 * @param candidates - Fill-ratio thresholds to try, in order.
 * @param borderClusteringConfig - Passed through to `clusterBorders`.
 * @param anchorConfidenceThreshold - Passed through to `clusterBorders`.
 * @param fallbackThreshold - Used (and evaluated once) if no candidate validates.
 */
export function calibrateCageTotalThreshold(
  contours: ContourMetrics[][][],
  warpedGry: GrayImage,
  subres: number,
  candidates: readonly number[],
  borderClusteringConfig: BorderClusteringConfig,
  anchorConfidenceThreshold: number,
  fallbackThreshold: number,
): CageThresholdCalibrationResult {
  interface Evaluated {
    readonly threshold: number;
    readonly cageConf: number[][];
    readonly borderX: boolean[][];
    readonly borderY: boolean[][];
    readonly borderXProb: number[][];
    readonly borderYProb: number[][];
    readonly valid: boolean;
    readonly margin: number;
  }

  function evaluate(threshold: number): Evaluated {
    const cageConf = cageConfFromContours(contours, subres, threshold);
    const [borderXProb, borderYProb] = clusterBorders(
      warpedGry, cageConf, subres, borderClusteringConfig, anchorConfidenceThreshold,
    );
    const borderX = borderXProb.map(row => row.map(v => v > 0.5));
    const borderY = borderYProb.map(row => row.map(v => v > 0.5));
    const valid = validateCageGeometry(cageConf, borderX, borderY);
    const margin = thresholdMargin(contours, subres, threshold);
    return { threshold, cageConf, borderX, borderY, borderXProb, borderYProb, valid, margin };
  }

  const evaluated = candidates.map(evaluate);
  const candidateResults: ThresholdCandidateResult[] = evaluated.map(
    ({ threshold, valid, margin }) => ({ threshold, valid, margin }),
  );

  const bestThreshold = pickBestThreshold(candidateResults);
  const chosen = bestThreshold !== null
    ? evaluated.find(e => e.threshold === bestThreshold)!
    : evaluate(fallbackThreshold);

  return {
    threshold: chosen.threshold,
    fallbackUsed: bestThreshold === null,
    cageConf: chosen.cageConf,
    borderX: chosen.borderX,
    borderY: chosen.borderY,
    borderXProb: chosen.borderXProb,
    borderYProb: chosen.borderYProb,
    candidateResults,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/image/cellScan.test.ts`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 5: Run full bronze gate**

Run: `bash scripts/run-bronze-gate.sh` (from repo root)
Expected: `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test` all pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/image/cellScan.ts web/src/image/cellScan.test.ts
git commit -m "feat: add calibrateCageTotalThreshold for per-image cage-total calibration"
```

---

## Sprint 1 Completion Check

At the end of this sprint:
- `cageConfFromContours`, `thresholdMargin`, `pickBestThreshold`,
  `calibrateCageTotalThreshold`, `ContourMetrics`, `ThresholdCandidateResult`,
  `CageThresholdCalibrationResult`, `isCageTotalContourSize` are exported from
  `web/src/image/cellScan.ts`.
- `validateCageGeometry` is exported from `web/src/image/validation.ts`.
- `cageTotalFillRatioCandidates` is in `CellScanConfig`.
- All new code is pure and fully unit-tested without OpenCV.
- `scanCells` and the pipeline (`inpImage.ts`) are UNCHANGED — this sprint adds
  new code alongside the existing pipeline without wiring it in yet.
- Bronze gate passes.

This sprint does NOT yet:
- Touch OpenCV (`collectCageTotalContours`, `scanClassicDigits`).
- Add telemetry (`CageThresholdCalibrationReport`).
- Wire calibration into `inpImage.ts`.

These are Sprint 2 (`docs/superpowers/plans/2026-06-14-cage-total-threshold-calibration-sprint2.md`).
