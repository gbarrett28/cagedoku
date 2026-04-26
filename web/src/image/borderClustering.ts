/**
 * Format-agnostic anchored border clustering: Stage 4 of the image pipeline.
 *
 * Mirrors Python's `killer_sudoku.image.border_clustering` module.
 *
 * Classifies all 144 inner borders as cage/non-cage using per-image k-means
 * clustering, anchored by cage-total cells detected in Stage 3.
 *
 * sklearn replacements:
 *   StandardScaler  → standardScale() (~15 lines)
 *   KMeans(k=2, n_init=10) → kmeans2() (~40 lines)
 *
 * Image convention: warpedGry is a standard row-major grayscale image where
 * pixel(row, col) = data[row * size + col].  (The Python source uses a
 * column-first convention that is geometrically equivalent for a square grid.)
 */

import type { BorderClusteringConfig } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Standard row-major square grayscale image: pixel(row, col) = data[row * size + col]. */
export interface GrayImage {
  readonly data: Uint8Array;
  readonly size: number; // width = height = resolution
}

/** Whether a border lies on a 3×3 box boundary or an ordinary cell boundary. */
export const enum BoundaryKind {
  BOX = 'box',
  CELL = 'cell',
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Return the structural kind of a border gap.
 *
 * Box boundaries occur between the 3rd and 4th rows/columns (gapIdx=2) and
 * between the 6th and 7th (gapIdx=5). In 0-indexed 8-gap space, the
 * condition is gapIdx % 3 === 2.
 *
 * @param gapIdx - 0-indexed gap index (0..7) between adjacent rows or columns.
 */
export function boundaryKind(gapIdx: number): BoundaryKind {
  return gapIdx % 3 === 2 ? BoundaryKind.BOX : BoundaryKind.CELL;
}

/**
 * Extract 4 position-independent features from a 1-D min-projected border strip.
 *
 * Uses order statistics (percentiles) so features depend only on the
 * *distribution* of brightness values, not where in the strip the ink sits.
 *
 * Features: [p5, p25, p50, mean].
 *   p5  (≈ minimum): how dark is the darkest part?  Cage border → ~50–150.
 *   p25: how broad is the dark region?
 *   p50 (median): is most of the strip dark or light?
 *   mean: overall ink level.
 *
 * @param strip - 1-D array of uint8 pixel values from the border region.
 * @returns Float64 array of shape (4,).
 */
export function stripFeatures(strip: Uint8Array): [number, number, number, number] {
  const sorted = Float64Array.from(strip).sort();
  const n = sorted.length;
  return [
    percentile(sorted, 5),
    percentile(sorted, 25),
    percentile(sorted, 50),
    mean(sorted, n),
  ];
}

/**
 * Classify all 144 inner borders as cage/non-cage without format-specific code.
 *
 * Extracts features from each border strip, groups by BoundaryKind, uses
 * cage-total anchors to resolve cluster polarity, and returns soft
 * cage-border probabilities.
 *
 * @param warpedGry - Perspective-corrected grayscale image (standard row-major).
 * @param cageTotalConfidence - Shape (9, 9) [row][col] confidence array from Stage 3.
 * @param subresParam - Pixels per cell side.
 * @param config - Clustering parameters.
 * @param anchorConfidenceThreshold - Minimum confidence for a cell to contribute anchors.
 * @returns [borderXProb, borderYProb] — shapes (9, 8) [col][rowGap] and (8, 9)
 *   [colGap][row] with values in [0, 1]. Values > 0.5 indicate a likely cage
 *   border; 0.5 means uncertain.
 */
export function clusterBorders(
  warpedGry: GrayImage,
  cageTotalConfidence: number[][],
  subresParam: number,
  config: BorderClusteringConfig,
  anchorConfidenceThreshold: number = 0.5,
): [number[][], number[][]] {
  const sampleHalf = (subresParam / config.sampleFraction) | 0;
  const sampleMarginPx = (subresParam / config.sampleMargin) | 0;
  const anchors = anchorSet(cageTotalConfidence, anchorConfidenceThreshold);

  // Group borders by BoundaryKind only — horizontal and vertical borders of
  // the same structural type are clustered together.  This doubles the anchor
  // count per group and halves the number of polarity choices.
  type EdgeEntry = [isH: boolean, gapIdx: number, alongIdx: number, feat: [number, number, number, number]];
  const groups = new Map<BoundaryKind, EdgeEntry[]>([
    [BoundaryKind.CELL, []],
    [BoundaryKind.BOX, []],
  ]);

  for (let gapIdx = 0; gapIdx < 8; gapIdx++) {
    const kind = boundaryKind(gapIdx);
    const group = groups.get(kind)!;
    for (let alongIdx = 0; alongIdx < 9; alongIdx++) {
      for (const isH of [true, false] as const) {
        const strip = sampleStrip(
          warpedGry,
          isH,
          gapIdx,
          alongIdx,
          subresParam,
          sampleHalf,
          sampleMarginPx,
        );
        const feat = stripFeatures(strip);
        group.push([isH, gapIdx, alongIdx, feat]);
      }
    }
  }

  // (9, 8) [col][rowGap] and (8, 9) [colGap][row]
  const borderXProb: number[][] = Array.from({ length: 9 }, () => new Array<number>(8).fill(0));
  const borderYProb: number[][] = Array.from({ length: 8 }, () => new Array<number>(9).fill(0));

  for (const [, entries] of groups) {
    const features = entries.map(e => e[3]);
    const anchorPos = entries
      .map((e, i) => ({ i, key: anchorKey(e[0], e[1], e[2]) }))
      .filter(({ key }) => anchors.has(key))
      .map(({ i }) => i);

    const probs = clusterGroup(features, anchorPos);

    for (let i = 0; i < entries.length; i++) {
      const [isH, gapIdx, alongIdx] = entries[i]!;
      if (isH) {
        // borderXProb[col][rowGap]: isH=true, gapIdx=rowGap, alongIdx=col
        borderXProb[alongIdx]![gapIdx] = probs[i]!;
      } else {
        // borderYProb[colGap][row]: isH=false, gapIdx=colGap, alongIdx=row
        borderYProb[gapIdx]![alongIdx] = probs[i]!;
      }
    }
  }

  return [borderXProb, borderYProb];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Encode an anchor triple as a string key for Set membership. */
function anchorKey(isH: boolean, gapIdx: number, alongIdx: number): string {
  return `${isH ? 'h' : 'v'},${gapIdx},${alongIdx}`;
}

/**
 * Return the set of anchor border keys from high-confidence cage-total cells.
 *
 * For a cage-total cell at (row, col), the borders above it (horizontal,
 * gapIdx=row-1) and to its left (vertical, gapIdx=col-1) are cage borders.
 * Outer-edge borders (row=0 or col=0) have no inner border above/left.
 *
 * @param cageTotalConfidence - (9, 9) [row][col] confidence array.
 * @param threshold - Minimum confidence to use a cell as an anchor.
 */
function anchorSet(cageTotalConfidence: number[][], threshold: number): Set<string> {
  const anchors = new Set<string>();
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (cageTotalConfidence[row]![col]! >= threshold) {
        if (row > 0) {
          // Horizontal border above: isH=true, gapIdx=row-1, alongIdx=col
          anchors.add(anchorKey(true, row - 1, col));
        }
        if (col > 0) {
          // Vertical border to the left: isH=false, gapIdx=col-1, alongIdx=row
          anchors.add(anchorKey(false, col - 1, row));
        }
      }
    }
  }
  return anchors;
}

/**
 * Sample a 1-D min-projected strip for one interior border edge.
 *
 * Uses standard row-major indexing: pixel(row, col) = data[row * size + col].
 *
 * For a horizontal border (between rows gap_idx and gap_idx+1):
 *   - Perpendicular direction = rows, range = boundary ± sampleHalf.
 *   - Along direction = cols, sampled from centre of alongIdx cell ± margin.
 *   - Min projected over columns → 1-D array of length 2*sampleHalf in row direction.
 *
 * For a vertical border (between cols gap_idx and gap_idx+1):
 *   - Perpendicular direction = cols, range = boundary ± sampleHalf.
 *   - Along direction = rows, sampled from centre of alongIdx cell ± margin.
 *   - Min projected over rows → 1-D array of length 2*sampleHalf in col direction.
 *
 * @param warpedGry - Standard row-major square grayscale image.
 * @param isHorizontal - True for horizontal border (between rows), false for vertical.
 * @param gapIdx - 0-indexed gap position (0..7) perpendicular to the border.
 * @param alongIdx - 0-indexed cell position (0..8) along the border.
 * @param subresParam - Pixels per cell side.
 * @param sampleHalf - Half-width of the sampling strip in pixels.
 * @param sampleMarginPx - Pixels removed from each end along the border.
 * @returns 1-D Uint8Array of min-projected pixel values, length 2*sampleHalf.
 */
function sampleStrip(
  warpedGry: GrayImage,
  isHorizontal: boolean,
  gapIdx: number,
  alongIdx: number,
  subresParam: number,
  sampleHalf: number,
  sampleMarginPx: number,
): Uint8Array {
  const { data, size } = warpedGry;
  // Centre of the cell in the "along" direction.
  const cm = (((2 * alongIdx + 1) * subresParam) / 2) | 0;
  const cStart = cm + sampleMarginPx;
  const cEnd = cm + sampleHalf - sampleMarginPx;
  // Boundary position in the perpendicular direction.
  const bndry = (gapIdx + 1) * subresParam;
  const pStart = bndry - sampleHalf;
  const pEnd = bndry + sampleHalf;
  const len = pEnd - pStart; // = 2 * sampleHalf

  const result = new Uint8Array(len).fill(255);

  if (isHorizontal) {
    // Min over columns in [cStart, cEnd), result indexed by row offset from pStart.
    for (let row = pStart; row < pEnd; row++) {
      for (let col = cStart; col < cEnd; col++) {
        const v = data[row * size + col]!;
        if (v < result[row - pStart]!) result[row - pStart] = v;
      }
    }
  } else {
    // Min over rows in [cStart, cEnd), result indexed by col offset from pStart.
    for (let col = pStart; col < pEnd; col++) {
      for (let row = cStart; row < cEnd; row++) {
        const v = data[row * size + col]!;
        if (v < result[col - pStart]!) result[col - pStart] = v;
      }
    }
  }

  return result;
}

/**
 * Cluster one group of border strips into cage/non-cage.
 *
 * Uses k-means(k=2, n_init=10); anchor positions resolve which cluster label
 * is "cage". Returns 0.5 for all strips when no anchors are provided.
 *
 * @param features - List of 4-element feature vectors.
 * @param anchorPositions - Indices into features of known cage-border strips.
 * @returns Array of length features.length with values in {0.0, 0.5, 1.0}.
 */
function clusterGroup(
  features: Array<[number, number, number, number]>,
  anchorPositions: number[],
): number[] {
  const n = features.length;
  if (n === 0) return [];
  if (anchorPositions.length === 0) return new Array<number>(n).fill(0.5);

  const xScaled = standardScale(features);
  const labels = kmeans2(xScaled, 10);

  // Resolve polarity: whichever cluster label appears most among anchors is "cage".
  const counts = [0, 0];
  for (const idx of anchorPositions) {
    counts[labels[idx]!] = counts[labels[idx]!]! + 1;
  }
  const cageCluster = counts[0]! >= counts[1]! ? 0 : 1;

  return labels.map(l => (l === cageCluster ? 1.0 : 0.0));
}

// ---------------------------------------------------------------------------
// sklearn replacements
// ---------------------------------------------------------------------------

/**
 * Zero-mean unit-variance scaling per feature column.
 * Replaces sklearn's StandardScaler.fit_transform(X).
 */
function standardScale(X: Array<[number, number, number, number]>): number[][] {
  const n = X.length;
  const d = 4;
  const means = [0, 0, 0, 0];
  const stds = [0, 0, 0, 0];

  for (const row of X) {
    for (let j = 0; j < d; j++) means[j] = means[j]! + row[j]!;
  }
  for (let j = 0; j < d; j++) means[j] = means[j]! / n;

  for (const row of X) {
    for (let j = 0; j < d; j++) {
      const diff = row[j]! - means[j]!;
      stds[j] = stds[j]! + diff * diff;
    }
  }
  // Avoid division by zero for constant features (std=0 → leave as-is).
  for (let j = 0; j < d; j++) {
    stds[j] = Math.sqrt(stds[j]! / n) || 1;
  }

  return X.map(row => row.map((v, j) => (v - means[j]!) / stds[j]!));
}

/**
 * K-means clustering with k=2 and nInit random restarts.
 * Replaces sklearn's KMeans(n_clusters=2, n_init=nInit, random_state=42).
 *
 * Returns labels array (0 or 1 per point) from the best run (lowest inertia).
 */
function kmeans2(X: number[][], nInit: number): number[] {
  const n = X.length;
  const d = X[0]!.length;
  let bestLabels: number[] = new Array<number>(n).fill(0);
  let bestInertia = Infinity;

  for (let init = 0; init < nInit; init++) {
    // Pick 2 distinct random points as initial centroids.
    const i0 = (Math.random() * n) | 0;
    let i1 = (Math.random() * (n - 1)) | 0;
    if (i1 >= i0) i1++;
    const centroids = [X[i0]!.slice(), X[i1]!.slice()];
    let labels = new Array<number>(n).fill(0);

    for (let iter = 0; iter < 100; iter++) {
      // Assign each point to the nearest centroid.
      const newLabels = X.map(p => dist2(p, centroids[0]!) <= dist2(p, centroids[1]!) ? 0 : 1);

      // Check for convergence.
      let changed = false;
      for (let i = 0; i < n; i++) {
        if (newLabels[i]! !== labels[i]!) { changed = true; break; }
      }
      labels = newLabels;
      if (!changed) break;

      // Update centroid positions.
      for (let k = 0; k < 2; k++) {
        const cnt = new Array<number>(d).fill(0);
        let sz = 0;
        for (let i = 0; i < n; i++) {
          if (labels[i]! === k) {
            for (let j = 0; j < d; j++) cnt[j] = cnt[j]! + X[i]![j]!;
            sz++;
          }
        }
        if (sz > 0) {
          for (let j = 0; j < d; j++) centroids[k]![j] = cnt[j]! / sz;
        }
      }
    }

    // Compute inertia for this run.
    let inertia = 0;
    for (let i = 0; i < n; i++) {
      inertia += dist2(X[i]!, centroids[labels[i]!]!);
    }
    if (inertia < bestInertia) {
      bestInertia = inertia;
      bestLabels = labels.slice();
    }
  }

  return bestLabels;
}

/** Squared Euclidean distance between two vectors. */
function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/** Compute a percentile of a pre-sorted Float64Array. */
function percentile(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Compute mean of a typed array. */
function mean(arr: Float64Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += arr[i]!;
  return s / n;
}
