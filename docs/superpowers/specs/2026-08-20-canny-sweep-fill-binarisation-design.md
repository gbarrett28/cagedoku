# Canny Sweep-Fill Binarisation Design

**Status:** proposed  
**Branch:** `codex/canny-binarisation-spike`  
**Objective:** replace the fragile master digit-segmentation mask while preserving the deployed greyscale recogniser and the rest of the OCR pipeline.

## Context

Master derives one binary mask while locating the grid:

1. Build a 16-bin histogram over the complete, unwarped source image.
2. Find a dark-tone histogram valley.
3. Subtract the fixed `isblackOffset = 56`.
4. Apply one global `inRange` threshold.
5. Perspective-warp that already-binary mask and reuse it for cage-total and given-digit contour extraction.

This couples digit segmentation to lighting and content outside the grid, quantises the threshold in 16-level steps, applies a fixed correction, and interpolates a binary mask during perspective correction. The resulting contours can merge a digit with a gridline or lose/split digit ink. The failures of interest are in `odd_training`; the original Guardian and Observer corpora provide the non-regression set.

An earlier Canny experiment was abandoned because its binary crops degraded the old recogniser. That reason no longer applies: production recognition now copies the contour bounding box from the warped greyscale image, normalises its intensity, and applies the deployed greyscale RBF/template recogniser. The candidate segmenter therefore controls geometry only.

## Scope

The change will:

- retain master’s current global threshold for locating the outer grid;
- create a fresh segmentation mask from the warped greyscale grid;
- use Canny edges plus an improved row/column sweep fill;
- leave contour filtering, digit splitting, crop coordinates, greyscale preprocessing, template matching, RBF inference, and solving unchanged;
- evaluate threshold robustness and segmentation output before production integration.

It will not change grid location, recogniser training, model weights, confidence thresholds, or puzzle-solving rules.

## Pipeline

```text
source greyscale
  -> existing grid-location threshold
  -> perspective transform
  -> warped greyscale
       -> improved Canny sweep-fill mask
       -> existing findContours / splitNum
       -> bounding boxes
       -> exact boxes copied from warped greyscale
       -> deployed greyscale recogniser
```

Keeping grid location and digit segmentation separate is the architectural fix: locating a large outer quadrilateral and segmenting small antialiased digits no longer share one threshold.

## Improved sweep-fill algorithm

### 1. Canny edges

Run Canny on the warped greyscale grid with aperture size 3 and `L2gradient = true`. Threshold selection remains an experimental variable until the robustness evaluation identifies a stable region; it must not be chosen from one visually successful crop.

### 2. Segment statistics

Canny edge pixels divide every row and column into non-edge segments. For each segment record:

- axis and position;
- start and end coordinates;
- length;
- mean greyscale intensity;
- within-segment intensity variance.

The variance is computed from the segment’s pixel sum and squared-pixel sum. These statistics let the two intersecting sweep directions provide independent evidence for every non-edge pixel.

### 3. Length-weighted intensity clustering

Cluster segment means into three ordered intensity groups. Segment length is the sample weight both when initialising weighted quantiles and when updating centres, so a one-pixel fragment cannot influence the global intensity model as much as a long, homogeneous region.

Do not assume that the darkest and middle clusters are always ink. Sort the three centres and split ink from background at the largest adjacent centre gap:

- if the larger gap is between dark and middle, only the darkest cluster is ink;
- if the larger gap is between middle and light, dark and middle are ink;
- an exact gap tie uses only the darkest cluster, the conservative deterministic choice.

Collapse duplicate ordered centres before choosing the split. With two distinct groups, the darker group is ink; with one distinct group or no segments, return an empty mask. This conservative rule avoids classifying an effectively uniform grid as entirely ink and prevents invalid indices or non-finite statistics.

### 4. Row/column evidence resolution

For each non-edge pixel:

- if its row and column segments agree on ink/background, accept that classification;
- if they disagree, use the classification from the segment with lower within-segment variance;
- a segment shorter than three pixels cannot win over an eligible segment, because its variance estimate is not meaningful;
- if neither segment is eligible, prefer the longer segment;
- a remaining exact tie resolves to background.

This replaces the fixed 9×9 neighbourhood average. The decision is based on which intersecting line is actually more internally consistent, so an edge leak that dilutes one direction does not override a clean stroke-aligned segment in the other.

### 5. Internal edge repair

Canny edges are initially excluded from the filled mask. In one non-cascading repair pass, restore an edge pixel as ink only when the pre-repair mask contains ink on both immediate horizontal sides or both immediate vertical sides.

This repairs a one-pixel Canny cut through an otherwise filled stroke, including the observed split-8 failure mode. A true stroke boundary normally has ink on only one side and remains excluded. The pass must read only the pre-repair mask so one restored pixel cannot grow an uncontrolled bridge.

## Diagnostics

Experimental evaluation must save, for every changed or failing puzzle:

- warped greyscale grid;
- raw Canny edge map;
- row and column segment classifications;
- row/column disagreement map, indicating which direction won and both variances;
- mask before and after internal-edge repair;
- final `findContours` bounding boxes;
- puzzle, cell, and digit-position identifiers.

These artefacts distinguish threshold failure, sweep classification failure, internal edge splitting, contour filtering, digit splitting, and recognition.

## Threshold robustness experiment

Use a predetermined grid of Canny low/high settings or equivalent sigma values. Run the same sweep-fill implementation for every setting; do not adjust the fill rules between threshold candidates.

Select a threshold rule from a broad performance plateau, not the single highest-scoring point:

1. Use targeted `odd_training` failures and a puzzle-disjoint development subset to compare masks and downstream results.
2. Require adjacent threshold settings to retain the targeted segmentation improvements.
3. Freeze the rule before running confirmation.
4. Confirm on the untouched original Guardian and Observer corpora.
5. Report clean/not-solved/backtracked outcomes, changed puzzle identities, contour-box changes, and failure categories for every setting.
6. Treat end-to-end puzzle outcome as confirmation; use the saved masks and boxes to attribute every changed result to segmentation rather than OCR or solving.

A per-image threshold selected from solver success is out of scope because it creates a circular, fragile feedback loop.

## Testing

Unit tests will cover:

- weighted centre updates and weighted-quantile initialisation;
- largest-gap ink/background selection, including both gap arrangements and ties;
- lower-variance row/column conflict resolution;
- short-segment handling and deterministic ties;
- agreement cases;
- internal edge repair across horizontal and vertical cuts;
- no cascading edge growth;
- degenerate segment sets;
- OpenCV resource cleanup.

A focused integration fixture will reproduce at least the split-8 contour failure. Evaluation will run the production TypeScript pipeline and deployed model; no Python reimplementation of segmentation or recognition is permitted.

## Acceptance criteria

The candidate is eligible for production only if:

- targeted `odd_training` segmentation failures improve, with saved masks and boxes demonstrating the mechanism;
- the split-8 case is no longer separated by an internal Canny cut;
- the result is stable across a neighbouring range of Canny thresholds;
- there are no regressions relative to the latest master baseline in the original Guardian and Observer corpora;
- all recognition uses the deployed greyscale preprocessing and model unchanged;
- bronze and silver quality gates pass.

If the conservative sweep-fill improvements cannot meet these criteria, stop and reassess flood-fill/reconstruction rather than layering on further local heuristics.

