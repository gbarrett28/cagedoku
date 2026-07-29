# OCR Pipeline Specification

> **Supersedes `docs/image-pipeline.md`.** That document describes the original
> pipeline and is now partially out of date. Known divergences are called out
> in the [Divergences from image-pipeline.md](#divergences-from-image-pipelinemd)
> section below. Do not edit `image-pipeline.md`; once the refactor described here
> is complete it will be archived.

---

## Overview

The pipeline converts a photograph of a killer or classic sudoku puzzle into a
`PuzzleSpec` (cage layout + totals). It is **format-agnostic**: no newspaper-specific
configuration, no pre-trained border model, no user-facing format switch.

```
jpg → Stage 1: Grid warp
         ↓
      Stage 2: Border clustering → puzzle type (killer / classic)
         ↓
      Stage 3: Digit contour detection → rotation, cage-total candidates
         ↓ (killer only)
      Stage 4: Cage boundary labelling → border_x, border_y
         ↓
      Stage 5: Digit recognition → cage totals
         ↓
      Stage 6: Validation → PuzzleSpec
```

**Design principles:**

- **Cluster first, label second.** K-means clustering on border strips produces raw
  cluster labels before any cage-total information is available. Cage-total confidence
  is only used later (Stage 4) to orient the clusters — to resolve which label means
  "cage border" and which means "non-cage border". The clustering step itself is
  anchor-free and therefore available for type detection before Stage 3 runs.

- **Separation of concerns.** `computeBorderClusters` (pure clustering) and
  `labelBorderClusters` (polarity resolution) are separate functions. Type detection
  uses only the former; Stage 4 uses both.

- **Soft outputs, hard assignments deferred.** Each stage produces confidence scores
  or probabilities. Hard assignments live in Stage 6 only.

---

## Stage 1: Grid Detection and Warp

No change from `image-pipeline.md`. The grayscale image is upscaled to at least
`resolution = 9 × subres` pixels, then `locateGrid` finds the four corners of the
puzzle grid. A perspective warp maps the grid to a square at `resolution × resolution`
pixels.

Two warp products are kept for downstream stages:

- `warpedGryMat` — grayscale, used for border strip sampling.
- `warpedBlkMat` — adaptively thresholded binary, used for contour finding.

Parameters are unchanged from `image-pipeline.md` (see that document for full
derivation tables).

---

## Stage 2: Puzzle Type Detection via Border Clustering

**Purpose:** determine killer vs classic without any prior knowledge of the puzzle.

**Input:** `warpedGry` — perspective-corrected grayscale image.

**Output:** `puzzleType ∈ { 'killer', 'classic', 'unknown' }`.

### Approach

Every inner border has a 1-D feature vector extracted from a min-projected strip
centred on that border. Borders are partitioned by structural kind:

- **CELL boundaries** (108 total): gap indices where `gapIdx % 3 ≠ 2`.
- **BOX boundaries** (36 total): gap indices where `gapIdx % 3 = 2`.

K-means (k=2, n\_init=10) is run independently on each group. The result is inspected
via **centroid separation** in standardised feature space:

| Condition | Interpretation |
|---|---|
| `cellGroup.centroidDistSq > clusterSeparationThreshold` | Killer — two distinct border types (cage lines + empty borders) |
| `cellGroup.centroidDistSq ≤ clusterSeparationThreshold` | Classic — all cell borders are homogeneous (empty) |

Both CELL and BOX groups show bimodality in killer puzzles — cage lines are present in
both types of border. The reason they are clustered independently is that their visual
characteristics differ: BOX borders are thicker (box-boundary lines dominate), while
CELL borders mix thin cage lines with empty-cell gaps. Treating them as a single pool
would confound two distributions with different feature means.

Currently only `cellGroup.centroidDistSq` is compared against the threshold for type
detection. Whether `boxGroup.centroidDistSq` should also contribute is an open question
— see Migration Plan Step 1.

**Why centroid distance works:**

- Killer: CELL borders are bimodal — cage lines (dark ink, low percentile features)
  and empty cell borders (white, high percentile features). K-means finds two
  well-separated clusters. Standardised centroid distance is large (> ~1.0). BOX
  borders are similarly bimodal: box-boundary lines always present, cage lines
  crossing some box borders add a second ink cluster.
- Classic: CELL and BOX borders are all homogeneous (no cage lines). K-means finds
  two clusters but they reflect random noise. Standardised centroid distance is
  small for both groups (< ~0.5).

### Feature Vector

Each border strip uses **4 order-statistic features** of the min-projected 1-D strip:

```
[p5, p25, p50, mean]
```

where `p5` = 5th percentile (≈ minimum darkness), `p25`, `p50` = median, `mean`.
All values are uint8 (0 = black, 255 = white). Dark cage lines produce low values;
empty borders produce values near 255.

> **Note:** `image-pipeline.md` Stage 4 lists `[peak count, variance, mean, maximum
> gradient]` as the feature vector. This is out of date. The live code uses percentiles.

### Strip Sampling

For each border, a strip of half-width `subres / sampleFraction` pixels is sampled
perpendicular to the border, centred at the boundary. An inset of
`subres / sampleMargin` pixels is removed from each end to avoid sampling digit ink
in adjacent cells. The strip is min-projected along the border direction into a 1-D
array.

| Parameter | Default | Derivation |
|---|---|---|
| `sampleFraction` | 4 → ±32 px half-width | ~8× border line width |
| `sampleMargin` | 16 → ±8 px inset | Maximum x-offset of digit ink from bounding box |
| `clusterSeparationThreshold` | 1.0 | Empirical — **requires validation against ground truth** (see Migration Plan) |

### Implementation

`computeBorderClusters(warpedGry, subres, config)` in `web/src/image/borderClustering.ts`.
Called from `detectPuzzle` in `web/src/image/cellScan.ts`.

---

## Stage 3: Digit Contour Detection

**Purpose:** find digit-sized ink blobs in each cell, detect image rotation.

**Input:** `warpedGryMat`, `warpedBlkMat`, contour tree from `buildContourTree`.

**Output:**
- `contourMetrics[9][9][]` — raw contour candidates per cell.
- `rotK ∈ {0, 1, 2, 3}` — 90° clockwise rotation count needed to correct orientation.

### 3a. Contour Collection

`collectCageTotalContours` scans the top-left `subres/2 × subres/2` quadrant of each
cell in the adaptive-threshold binary image. Any contour passing
`isCageTotalContourSize` (bounding box in `[subres/16, subres/2]` × `[subres/8, subres/2]`)
is recorded as a `ContourMetrics` entry (width, height, fill ratio).

No fill-ratio threshold is applied here. That decision is deferred to Stage 4
calibration so multiple candidate thresholds can be evaluated without re-running
OpenCV.

### 3b. Non-Digit Artefact Rejection *(not yet implemented)*

Two distinct artefact types contaminate the cage-total region:

1. **Dashes** — thin short strokes from dashed cage-border lines. Filtered by **area**
   (bounding-box area): dashes fall below the minimum area threshold in
   `isCageTotalContourSize`.
2. **Cage boundary artefacts** — fragments of solid cage-border ink that pass the area
   check but are not digits. Filtered by **fill ratio**: cage border fragments are thin
   and elongated (low fill ratio ≈ 0.15), while digit glyphs are compact (fill ratio
   0.50–0.81).

This works but is fragile for unusual print styles.

**Planned:** a lightweight binary classifier — "digit" vs "non-digit" — trained on
the existing contour metrics (fill ratio, aspect ratio, width, height, depth in
contour tree) plus the existing recogniser confidence. This replaces the hardcoded
fill-ratio candidates and provides a single probability per contour.

Until this is implemented, the per-image fill-ratio calibration in Stage 4 serves
as the artefact filter.

### 3c. Rotation Detection

Image rotation is determined differently for killer and classic puzzles.

**Killer puzzles:**
Cage-total digits are always printed in the top-left corner of the cage head cell.
The correct orientation is the one where digit contours cluster in the top-left
quadrant. For each of 4 candidate rotations, count contours whose centroid falls in
the TL quadrant (`cx < 0.35 × subres`, `cy < 0.35 × subres`). The rotation with
the most TL-quadrant contours is selected.

Non-digit artefacts (cage border fragments, dashes) can appear in any quadrant and
must be filtered before the quadrant count — otherwise a single artefact cluster in
the wrong quadrant can override the correct rotation. The area and fill-ratio filters
from Stage 3b must therefore run before the TL-centroid count.

> **Current code:** `detectPuzzle` in `cellScan.ts` uses a 4-rotation recogniser
> pass (running the digit recogniser at each rotation and choosing the rotation with
> the most confident digit reads) for BOTH killer and classic. The killer path should
> be refactored to use the TL-centroid approach instead — it is cheaper and more
> reliable for dashed-border puzzles where false-positive contours dominate the
> recogniser input.

**Classic puzzles:**
Given digits are centred in their cells and can appear in any rotation. Run the digit
recogniser at each of 4 rotations; choose the rotation with the most confident
non-zero digit reads.

---

## Stage 4: Cage Boundary Labelling *(killer only)*

**Purpose:** classify each of the 144 inner borders as cage / non-cage and produce
a hard `border_x[9][8]` / `border_y[8][9]` map.

**Input:** `warpedGry`; `cageConf[9][9]` from `calibrateCageTotalThreshold` (Stage 3
output refined by fill-ratio sweep).

**Output:** `borderXProb[9][8]`, `borderYProb[8][9]` — probabilities in [0, 1].

### Anchor-based polarity resolution

After clustering (which assigns arbitrary label 0 or 1 to each border),
`labelBorderClusters` resolves which label means "cage border":

For each cell where `cageConf[row][col] ≥ anchorConfidenceThreshold`, the border
*above* the cell (if `row > 0`) and the border *to the left* (if `col > 0`) are
known cage borders — they separate the cage head from a neighbour in a different cage.
These are **positive anchors**. Whichever cluster label appears most among anchors is
the "cage" cluster; its members get probability 1.0, the other cluster gets 0.0.
Borders in groups with no anchors get 0.5 (uncertain).

### Per-image fill-ratio calibration

`calibrateCageTotalThreshold` searches `[0.10, 0.15, …, 0.50]` for the fill-ratio
threshold that produces the cleanest cage geometry (all cages connected, each cage
has exactly one head, verified by `validateCageGeometry`). The chosen threshold's
`cageConf`, `borderX`, `borderY`, `borderXProb`, `borderYProb` are used directly
for Stage 5 — no second `clusterBorders` call. If no threshold validates, falls back
to `cageTotalMinFillRatio = 0.3`.

| Parameter | Default |
|---|---|
| `anchorConfidenceThreshold` | 0.5 |
| `cageTotalMinFillRatio` | 0.3 (fallback) |
| `cageTotalFillRatioCandidates` | [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50] |

### Implementation

`computeBorderClusters` + `labelBorderClusters` in `web/src/image/borderClustering.ts`.
`calibrateCageTotalThreshold` in `web/src/image/cellScan.ts`.

---

## Stage 5: Digit Recognition

No significant change from `image-pipeline.md`. For reference:

`buildCageTotals` walks the `RETR_TREE` contour hierarchy to find digit-sized
contours. `splitNum` decides 1 vs 2 digits per contour. Each digit is letterbox-warped
to a 64 × 64 binary thumbnail.

A cage-total region may contain 1 or 2 digit contours **plus** non-digit artefacts
(cage border fragments, dashes) that bleed into the region. `splitNum` and the
fill-ratio filter must separate these before recognition. The non-digit filter here is
the same fill-ratio mechanism as Stage 3b, applied within `buildCageTotals` rather than
as a pre-scan.

> **Future direction:** the feature extraction below operates on pre-warped 64 × 64
> thumbnails. Working directly on the raw contour polygons (without the warp step)
> could reduce preprocessing artefacts — worth exploring when the non-digit binary
> classifier (Migration Plan Step 2) is trained.

**Feature extraction:**

| Feature | Dimensions | Description |
|---|---|---|
| HOG | 1764 | `cv.HOGDescriptor` — 64 px window, 8 px cells, 16 px blocks, 9 bins |
| Hole-count | 5 | BFS flood-fill; encodes 0/1/2+ holes + 2 size fractions |
| Combined | 1769 | Concatenated HOG ⊕ hole-count |

**Classifier:** RBF SVM OvO, 45 binary classifiers (digits 0–9). Confidence =
vote fraction; flagged uncertain below 0.7. The browser accepts only the production
`classifier_type: "rbf"` manifest and rejects the retired PCA/template and linear
formats explicitly. HOG/hole feature extraction and inference are TypeScript-owned;
Python fitting calls the TypeScript feature implementation through `ts_bridge.py`.

The non-digit binary classifier (Stage 3b, not yet implemented) is distinct from the
digit recogniser. It operates on contour metrics (fill ratio, aspect ratio, area,
contour tree depth) to gate contours before they reach the digit recogniser. Once
implemented, it replaces the fill-ratio candidate sweep for artefact rejection and
feeds Stage 5 with pre-filtered digit contours only.

Classic given digits: `readClassicDigits` uses `classicConf[r][c]` from Stage 3 to
locate pre-filled cells.

---

## Stage 6: Cage Layout Validation

No change from `image-pipeline.md`. `validateCageLayout` checks connectivity, unique
cage heads, and legal totals. On any failure (unassigned region, two heads in one
region, or an out-of-range total), `buildLenientCageLayout` groups cells by border
connectivity only (never throws) and reports which cells belong to an invalid cage —
totals are never clamped, so the review screen shows the actual detected value for
the user to correct.

---

## Divergences from `image-pipeline.md`

| Topic | `image-pipeline.md` | This spec (current code) |
|---|---|---|
| Puzzle type detection | Aggregate `cage_total_confidence` sums vs threshold | `cellGroup.centroidDistSq` from k-means, no cage confidence needed |
| Border strip features | `[peak count, variance, mean, max gradient]` | `[p5, p25, p50, mean]` (percentiles) |
| Rotation detection | `computeQuadSums` (quadrant ink sums) | 4-rotation recogniser pass (needs refactor — see Stage 3c) |
| Clustering / labelling | Inseparable in `clusterBorders` | Split into `computeBorderClusters` + `labelBorderClusters` |
| Stage ordering | Stage 3 (cell scan) → Stage 4 (border clustering) | Stage 2 clustering runs before Stage 3 contours for type detection |

---

## Migration Plan

### Step 1: Validate puzzle type detection against ground truth *(immediate)*

The `clusterSeparationThreshold = 1.0` is an initial estimate. Before relying on it,
validate it against the full corpus, and determine whether `boxGroup.centroidDistSq`
should also contribute to the type detection decision:

1. Run `evaluate-corpus.ts` (with `--workers 1` to avoid WASM exhaustion) across all
   four corpora (`guardian/`, `observer/`, `classic_guardian/`, `classic_observer/`).
2. For each image, record both `cellGroupCentroidDistSq` and `boxGroupCentroidDistSq`
   from the debug hook, and compare the detected `puzzleType` against the ground truth
   (directory name encodes type).
3. Plot the distributions for killer vs classic images for both groups. Determine
   whether `boxGroup` provides additional separating power (wider valley, fewer
   ambiguous cases) or whether `cellGroup` alone is sufficient.
4. If both groups contribute: decide on the combination rule — requiring BOTH to exceed
   the threshold (AND, lower false-positive rate) or EITHER (OR, lower false-negative
   rate). False negatives (killer detected as classic) are worse here — a misclassified
   killer produces a blank spec.
5. Adjust the threshold(s) to the valley between the distributions and update the code.
6. Acceptance criterion: ≥ 95% correct type detection on each corpus, with no killer
   puzzle detected as classic.

### Step 2: Non-digit artefact recogniser *(medium term)*

Train a binary "digit vs non-digit" classifier using contour metrics as features
(fill ratio, aspect ratio, width, height, contour depth). Replace the fill-ratio
candidate sweep with a single-pass probability threshold per contour.

Input signals already available per contour: fill ratio, bounding-box dimensions,
depth in contour tree, recogniser confidence at the candidate rotation. These form
a compact feature vector suitable for a simple logistic regression or decision tree.

Label source: any contour that, after the fill-ratio sweep, ends up as a cage-total
digit is a positive; any contour that is filtered out is a negative. Can be extracted
from existing corpus runs.

### Step 3: Rotation detection refactor *(medium term)*

Separate the rotation logic for killer and classic:

- **Killer:** replace 4-rotation recogniser pass with TL-centroid count (Stage 3c
  above). Cheaper (no recogniser calls) and more reliable for dashed-border styles.
- **Classic:** keep 4-rotation recogniser pass. No change needed.

Validate rotation accuracy on the 1-2 rotated images known in the corpus before
merging.

### Step 4: Full pipeline re-evaluation

After Steps 1–3: re-run the full corpus evaluator. Target: match or exceed the
current master-branch solve rates for both killer and classic corpora. Merge to
master only once both targets are met.
