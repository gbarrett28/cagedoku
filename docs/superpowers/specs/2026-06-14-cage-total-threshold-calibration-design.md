# Per-Image Cage-Total Fill-Ratio Calibration

## Motivation

`cellScan.ts`'s `scanCells` detects cage-total digits in each cell's top-left
quadrant using a contour fill-ratio threshold (`CellScanConfig.cageTotalMinFillRatio`,
currently a fixed 0.3). This threshold separates thin dashed cage-border-line
segments (observed fillRatio ~0.15) from real digit glyphs (observed fillRatio
0.50-0.81).

A single global constant does not generalise: testing across sample images
shows it is correct for ~75% of cases but wrong for others — sometimes too
low (accepts dash segments as digits), sometimes too high (rejects real
digits). This spec adds a calibration stage that searches for a fill-ratio
threshold *per image*, choosing the value that yields the most plausible cage
layout.

## Architecture

### 1. `collectCageTotalContours(cv, warpedGry, subres): ContourMetrics[][]`

Runs the existing `adaptiveThreshold` + `findContours` pass once per cell's
top-left quadrant (as `scanCells` does today), but instead of immediately
applying the fill-ratio check, returns each cell's list of
`{ width, height, area }` for contours that pass the *size* heuristic
(`isCageTotalContour`'s width/height bounds). This is the only OpenCV-heavy
pass and is run exactly once regardless of how many threshold candidates are
evaluated.

`ContourMetrics = { width: number; height: number; area: number }`, returned
as a 9x9 array of `ContourMetrics[]` (one list per cell, usually short).

Classic-digit detection in `scanCells` is unaffected and is extracted into its
own function so it can be called independently of the cage-total path.

### 2. `cageConfFromContours(contours: ContourMetrics[][], subres, minFillRatio): number[][]`

Pure function. For each cell, returns `1.0` if any of its contours satisfies
`isCageTotalContour`'s fill-ratio check (`area >= minFillRatio * width * height`)
at the given threshold, else `0.0`. Cheap — called once per candidate
threshold during calibration, and once more for the final chosen threshold.

### 3. `validateCageGeometry(cageHeadFlags, borderX, borderY): boolean`

New function in `validation.ts`. Extracts the *structural* checks from
`validateCageLayout`'s union-find logic — every cell belongs to exactly one
cage with exactly one head cell, no orphaned cells, no double-assigned
regions — but **without** the total-range check (`cagesize=N, total=T: must
be in [lo, hi]`), which requires real digit-recognition output not available
at this stage. Returns `false` on structural failure instead of throwing,
since failure is an expected, common outcome during the search.

`validateCageLayout` may internally reuse the same union-find helper to avoid
duplication, but that is an implementation detail and not required by this
spec.

### 4. `calibrateCageTotalThreshold(...)`

The calibration stage itself. Signature (illustrative):

```ts
function calibrateCageTotalThreshold(
  contours: ContourMetrics[][],
  warpedGry: OpenCVMat,
  subres: number,
  candidates: readonly number[],
  borderClusteringConfig: BorderClusteringConfig,
  anchorConfidenceThreshold: number,
  fallbackThreshold: number,
  cv: Cv,
): {
  threshold: number;
  fallbackUsed: boolean;
  cageConf: number[][];
  borderX: boolean[][];
  borderY: boolean[][];
  candidateResults: { threshold: number; valid: boolean; margin: number }[];
}
```

For each `threshold` in `candidates`:
1. `cageConf = cageConfFromContours(contours, subres, threshold)`
2. `{ borderX, borderY } = clusterBorders(cv, warpedGry, cageConf, subres, borderClusteringConfig, anchorConfidenceThreshold)`
3. `valid = validateCageGeometry(cageConf, borderX, borderY)`
4. `margin = thresholdMargin(contours, threshold)` (see below) — computed for
   every candidate, valid or not, so the telemetry report (component 6) has
   complete data.

Among candidates with `valid === true`, pick the one with the largest
`margin` via `pickBestThreshold` (component 5). If no candidate is valid, set
`fallbackUsed = true`, use `fallbackThreshold` (`cageTotalMinFillRatio`,
0.3), and still run `clusterBorders` once for it so the return shape is
always complete (the pipeline proceeds as it does today, which may later hit
`validateCageLayout`'s total-range error — unchanged existing behaviour).

The returned `cageConf`/`borderX`/`borderY` are for the **chosen** threshold
only — Stage 4's `clusterBorders` is not re-run again afterward.

### 5. `pickBestThreshold` / `thresholdMargin`

Isolated, swappable pure functions:

```ts
/** Minimum distance from `threshold` to any individual contour's fillRatio
 *  (across all size-valid contours in the image). Larger = cleaner split. */
function thresholdMargin(contours: ContourMetrics[][], threshold: number): number;

/** Among candidates with valid===true, return the one with the largest margin. */
function pickBestThreshold(
  candidateResults: { threshold: number; valid: boolean; margin: number }[],
): number | null; // null if none valid
```

`thresholdMargin` computes `fillRatio = area / (width * height)` for every
contour across all 81 cells and returns
`min(|fillRatio - threshold|)`. A future tie-break rule can replace
`pickBestThreshold`'s body without touching the search loop.

### 6. `CageThresholdCalibrationReport` (telemetry)

New report type in `shared/src/reports/`, following the existing
`TriggerMissReport`/`StallStateExport` pattern (same `reportType`,
`reportedAt`, `appVersion`, `userAgent` fields, an `is()` type guard, and
`storageKey`/`r2Metadata`/`githubAction` helpers as appropriate).

```ts
interface CageThresholdCalibrationReport {
  readonly reportType: 'cage-threshold-calibration';
  readonly reportedAt: string;
  readonly appVersion: string;
  readonly userAgent: string;
  readonly chosenThreshold: number;
  readonly fallbackUsed: boolean;
  readonly candidates: readonly { threshold: number; valid: boolean; margin: number }[];
  readonly contourFillRatios: readonly number[];
}
```

`contourFillRatios` is the flattened `area / (width * height)` for every
size-valid contour across the image — the raw data needed to re-tune the
candidate sweep or margin rule from real-world data later.

Submitted via a new `submitCageThresholdCalibrationReport(...)` in
`trainingUpload.ts`, mirroring `submitTriggerMissReport`: silently dropped if
`!hasConsent()`, fire-and-forget POST via `postToWorker`, called once per
successful image scan from `inpImage.ts`.

## Pipeline Integration (`inpImage.ts`)

Replaces the current single `scanCells(...)` call for the cage-total path:

```
1. contourMetrics = collectCageTotalContours(cv, warpedGryMat, subres)
2. classicConf    = <extracted classic-digit detection, unchanged logic>
3. { threshold, fallbackUsed, cageConf, borderX, borderY, candidateResults } =
     calibrateCageTotalThreshold(
       contourMetrics, warpedGryMat, subres,
       config.cellScan.cageTotalFillRatioCandidates,
       config.borderClustering, config.cellScan.anchorConfidenceThreshold,
       config.cellScan.cageTotalMinFillRatio, cv)
4. submitCageThresholdCalibrationReport({ chosenThreshold: threshold, fallbackUsed, candidates: candidateResults, contourFillRatios: ... })
5. ... continue with cageConf, classicConf, borderX, borderY as today
   (Stage 4's clusterBorders is NOT re-run; results from step 3 are reused)
```

## Config Additions (`CellScanConfig`)

```ts
/**
 * Candidate fill-ratio thresholds tried during per-image cage-total
 * calibration, spanning the observed dash cluster (~0.15) to digit cluster
 * (~0.50-0.81).
 */
readonly cageTotalFillRatioCandidates: readonly number[]; // default: [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50]

/** Fallback fill-ratio threshold used when no candidate yields a valid cage geometry. */
readonly cageTotalMinFillRatio: number; // existing field, default 0.3, now fallback-only
```

## Testing

TDD, pure functions first:

- `cageConfFromContours` — pure; reuse fixture values from existing
  `isCageTotalContour` tests in `cellScan.test.ts`.
- `validateCageGeometry` (in `validation.test.ts`) — valid partition,
  unassigned-region, and double-assigned-region cases, mirroring existing
  `validateCageLayout` fixtures but without total values.
- `thresholdMargin` / `pickBestThreshold` — contrived fillRatio lists; verify
  max-margin selection among valid candidates, and `null` when none valid.
- `calibrateCageTotalThreshold` — inject a fake `clusterBorders`-shaped
  function (dependency injection) so it is testable without OpenCV; verify
  correct selection, fallback when nothing validates, and the shape of
  `candidateResults`.
- `CageThresholdCalibrationReport.is()` — type guard tests mirroring other
  report types in `shared/src/reports/*.test.ts`.
- `collectCageTotalContours` — requires real OpenCV like `scanCells` does
  today; no pure unit test. Verified via the `/tmp/cvrun` Node harness
  against `KS1019_P.jpg`'s real data to confirm the calibrated threshold for
  that image is sensible (ideally matching or improving on the manually
  chosen 0.3).

## Out of Scope

- Investigating the unrelated digit-recognition/retraining failures
  mentioned during brainstorming. This calibration stage may incidentally
  help (better `cageConf` anchors feed Stage 4/5), and the new telemetry may
  aid that investigation, but fixing recognition itself is separate follow-up
  work.
