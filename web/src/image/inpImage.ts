/**
 * Image pipeline orchestrator: parses a puzzle image into a PuzzleSpec.
 *
 * Runs entirely in the browser:
 *   - Input is an HTML File (from <input type="file">) instead of a file path.
 *   - No .jpk cache (stateless browser session).
 *   - Returns a plain result object instead of storing state on self.
 *
 * Pipeline stages:
 *   1. Grid location   — contour-based grid detection (gridLocation.ts)
 *   2. Perspective warp + rotation correction
 *   3. Puzzle type / cell scan (cellScan.ts)
 *   4. Border clustering (borderClustering.ts)
 *   5. Cage total extraction + number recognition (numberRecognition.ts)
 *   6. Cage layout validation (validation.ts)
 */

import type { OpenCVModule, OpenCVMat } from './opencv.js';
type Cv = OpenCVModule;

import { defaultImagePipelineConfig, subres as cfgSubres, resolution as cfgResolution } from './config.js';
import type { ImagePipelineConfig } from './config.js';
import { locateGrid } from './gridLocation.js';
import { isPdfFile } from '../imageInput.js';
import {
  collectCageTotalContours, scanClassicDigits, cageConfFromSize,
  detectRotation, detectPuzzleType,
} from './cellScan.js';
import type { GrayImage } from './borderClustering.js';
import {
  splitNum, contourHier, getNumContours, readClassicDigits, activeRecogniser, allowedDigitsForPosition,
} from './numberRecognition.js';
import type { RawDigitCrop, Recognition } from './numberRecognition.js';
import { validateCageLayout, buildLenientCageLayout, computeCageSizes } from './validation.js';
import { buildBrdrs } from '../solver/puzzleSpec.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import { ProcessingError } from '../solver/errors.js';
import type { Brdrs } from '../solver/errors.js';
import { boundaryKind, BoundaryKind, clusterBorders } from './borderClustering.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when the input file cannot be decoded as an image. */
export class ImageDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

export class GridNotFoundError extends Error {
  constructor() {
    super('Grid not detected — try cropping your image to just the puzzle grid before uploading again.');
    this.name = 'GridNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result returned by parsePuzzleImage. */
export interface ParseResult {
  spec: PuzzleSpec | null;
  specError: string | null;
  fallbackUsed: boolean;
  puzzleType: 'killer' | 'classic';
  givenDigits: number[][] | null;
  warpedImageData: ImageData | null;
  /** Post-split thumbnails for the digit recogniser, keyed "row,col". */
  cellThumbs: ReadonlyMap<string, Uint8Array[]>;
  /** Untouched bounding-box pixels from the warped grid, aligned with cellThumbs. */
  cellSourceCrops: ReadonlyMap<string, readonly RawDigitCrop[]>;
  /** Recognition (incl. runner-up) for each classic given-digit cell, keyed "row,col". */
  classicRecognitions?: ReadonlyMap<string, import('./numberRecognition.js').Recognition> | undefined;
  /** Recognition for each cage-total digit crop, keyed "row,col", array order matching cellThumbs. Killer only. */
  cageTotalRecognitions?: ReadonlyMap<string, import('./numberRecognition.js').Recognition[]> | undefined;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse a puzzle image file into a validated PuzzleSpec.
 *
 * Loads the image, runs the full pipeline, and returns a ParseResult.
 * The OpenCV.js module must be loaded before calling this function.
 *
 * @param cv - OpenCV.js module (must be ready).
 * @param file - Image file from the browser file picker.

 * @param config - Pipeline configuration (defaults used if omitted).
 * @param providedCorners - If supplied (original-image pixel space), skip grid
 *   detection and use these corners directly. Useful when the user has manually
 *   adjusted the grid corners via the corner picker.
 */
export async function parsePuzzleImage(
  cv: Cv,
  file: File,
  config: ImagePipelineConfig = defaultImagePipelineConfig(),
): Promise<ParseResult> {
  const resolution = cfgResolution(config);
  const subres = cfgSubres(config);

  // Decode the file to ImageData via an OffscreenCanvas.
  const imageData = await decodeImageFile(file);
  // --- Stage 1: Grid location ---
  const [blkMat, gryMat] = prepareGrayMat(cv, imageData, resolution);

  let rectArr: Float32Array;
  try {
    const [blk, rect] = locateGrid(cv, gryMat, config.gridLocation.isblackOffset);
    rectArr = rect;
    // blk (a global cv2.inRange threshold) is only used internally by
    // locateGrid to find the puzzle's outer quadrilateral -- digit
    // extraction now binarises the warped grayscale itself via Canny +
    // sweep-fill (see buildSweepInkMask / warpedBlkMat below), so blk has
    // no further use here.
    blk.delete();
  } catch {
    gryMat.delete();
    blkMat.delete();
    throw new GridNotFoundError();
  }

  // --- Stage 2: Perspective warp ---
  const dstSize = resolution;
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, Array.from(rectArr));
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    dstSize - 1, 0,
    dstSize - 1, dstSize - 1,
    0, dstSize - 1,
  ]);
  let mMat = cv.getPerspectiveTransform(srcPts, dstPts);
  srcPts.delete(); dstPts.delete();

  let warpedGryMat = new cv.Mat();
  cv.warpPerspective(gryMat, warpedGryMat, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);

  // Binarise the warped grayscale for cage-digit / classic-digit contour
  // extraction via Canny + sweep-fill (see buildSweepInkMask), replacing
  // the previous approach of warping a single global threshold computed
  // once during grid location.
  let warpedBlkMat = buildSweepInkMask(cv, warpedGryMat, config.numberRecognition.cannySigma);

  // Colour warp for rendering — must be upsampled to the same resolution as
  // gryMat so that mMat (computed in upsampled coordinates) samples correctly.
  let srcMat = cv.matFromImageData(imageData);
  while (srcMat.rows < resolution || srcMat.cols < resolution) {
    const up = new cv.Mat();
    cv.pyrUp(srcMat, up);
    srcMat.delete();
    srcMat = up;
  }
  // Match the 3px white border added to the grayscale mat in prepareGrayMat,
  // so mMat (computed in that bordered coordinate system) samples correctly.
  const srcMatBordered = new cv.Mat();
  cv.copyMakeBorder(srcMat, srcMatBordered, 3, 3, 3, 3, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
  srcMat.delete();
  srcMat = srcMatBordered;
  let warpedImgMat = new cv.Mat();
  cv.warpPerspective(srcMat, warpedImgMat, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);
  srcMat.delete();

  // --- Rotation correction ---
  const rotK = detectRotation(warpedGryMat, subres, config.cellScan.rotationDominanceThreshold);
  if (rotK !== 0) {
    // Roll the rect corners by -k and re-warp.
    rectArr = rollCorners(rectArr, -rotK);
    const srcPts2 = cv.matFromArray(4, 1, cv.CV_32FC2, Array.from(rectArr));
    const dstPts2 = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, dstSize-1,0, dstSize-1,dstSize-1, 0,dstSize-1]);
    mMat.delete();
    mMat = cv.getPerspectiveTransform(srcPts2, dstPts2);
    srcPts2.delete(); dstPts2.delete();

    // Re-warp all Mats (reuse gryMat — see comment above for rationale).
    warpedGryMat.delete();
    warpedGryMat = new cv.Mat();
    cv.warpPerspective(gryMat, warpedGryMat, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);

    warpedBlkMat.delete();
    warpedBlkMat = buildSweepInkMask(cv, warpedGryMat, config.numberRecognition.cannySigma);

    let srcMat2 = cv.matFromImageData(imageData);
    while (srcMat2.rows < resolution || srcMat2.cols < resolution) {
      const up2 = new cv.Mat();
      cv.pyrUp(srcMat2, up2);
      srcMat2.delete();
      srcMat2 = up2;
    }
    const srcMat2Bordered = new cv.Mat();
    cv.copyMakeBorder(srcMat2, srcMat2Bordered, 3, 3, 3, 3, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    srcMat2.delete();
    srcMat2 = srcMat2Bordered;
    warpedImgMat.delete();
    warpedImgMat = new cv.Mat();
    cv.warpPerspective(srcMat2, warpedImgMat, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);
    srcMat2.delete();
  }
  gryMat.delete(); blkMat.delete(); mMat.delete();

  // Convert warped colour image to ImageData for the result.
  const warpedImgData = matToImageData(cv, warpedImgMat, dstSize);
  warpedImgMat.delete();

  // --- Stage 3: Puzzle type detection ---
  const contourMetrics = collectCageTotalContours(cv, warpedGryMat, subres);
  const classicConf = scanClassicDigits(cv, warpedGryMat, subres, config.cellScan.classicMinSizeFraction);
  const puzzleType = detectPuzzleType(warpedGryMat, subres, config.cellScan.tlFractionThreshold);

  // --- Classic path ---
  if (puzzleType === 'classic') {
    const {
      digits: givenDigits,
      thumbs: classicThumbs,
      sourceCrops: classicSourceCrops,
      recognitions: classicRecognitions,
    } = readClassicDigits(cv, warpedBlkMat, subres, classicConf);

    warpedGryMat.delete(); warpedBlkMat.delete();

    // Classic borders: rows separated by full walls, columns open.
    const borderX: boolean[][] = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true));
    const borderY: boolean[][] = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));

    const cageTotals: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    for (let r = 0; r < 9; r++) cageTotals[r]![0] = 45;

    let spec: PuzzleSpec | null = null;
    let specError: string | null = null;
    try {
      spec = validateCageLayout(cageTotals, borderX, borderY);
    } catch (err) {
      specError = String(err);
    }
    return {
      spec,
      specError,
      fallbackUsed: false,
      puzzleType: 'classic',
      givenDigits,
      warpedImageData: warpedImgData,
      cellThumbs: classicThumbs,
      cellSourceCrops: classicSourceCrops,
      classicRecognitions,
    };
  }

  // --- Killer path: Stage 4 anchored border clustering ---
  // Cell scan (Stage 3, pure bounding-box size check with no fill-ratio
  // threshold) feeds anchored border
  // clustering (Stage 4) directly — no per-image threshold calibration.
  const gryImg: GrayImage = { data: new Uint8Array(warpedGryMat.data), size: dstSize };
  const cageConf = cageConfFromSize(contourMetrics);
  const [bxProb, byProb] = clusterBorders(
    gryImg, cageConf, subres, config.borderClustering, config.cellScan.anchorConfidenceThreshold,
  );

  let initialBorderX = bxProb.map(row => row.map(v => v > 0.5));
  let initialBorderY = byProb.map(row => row.map(v => v > 0.5));

  let cageTotals: number[][] | null = null;
  let cellThumbs = new Map<string, Uint8Array[]>();
  let cellSourceCrops = new Map<string, RawDigitCrop[]>();
  let cellRecognitions = new Map<string, Recognition[]>();
  let lastCageTotalsResult: CageTotalsResult | null = null;
  let fallbackUsed = false;
  try {
    const brdrs = buildBrdrs(initialBorderX, initialBorderY);
    const cageSizes = computeCageSizes(initialBorderX, initialBorderY);
    lastCageTotalsResult = buildCageTotals(
      cv, warpedBlkMat, subres, brdrs, cageSizes,
    );
    ({ cageTotals, cellThumbs, cellSourceCrops, cellRecognitions } = lastCageTotalsResult);
  } catch (e) {
    console.warn('[parsePuzzleImage] buildCageTotals failed, proceeding with initial border estimate', e);
  }

  let bestBorderX = initialBorderX;
  let bestBorderY = initialBorderY;

  if (cageTotals !== null) {
    const nHeads = cageTotals.reduce((s, row) => s + row.filter(v => v > 0).length, 0);
    let bestScore = connectivityScore(bestBorderX, bestBorderY, cageTotals);

    if (bestScore < nHeads) {
      for (const [flipBox, flipCell] of [[true, false], [false, true], [true, true]] as const) {
        const cx = bxProb.map(row => [...row]);
        const cy = byProb.map(row => [...row]);
        for (let gap = 0; gap < 8; gap++) {
          const isBox = boundaryKind(gap) === BoundaryKind.BOX;
          const isCell = !isBox;
          if ((isBox && flipBox) || (isCell && flipCell)) {
            for (let a = 0; a < 9; a++) {
              cx[a]![gap] = 1.0 - cx[a]![gap]!;
              cy[gap]![a] = 1.0 - cy[gap]![a]!;
            }
          }
        }
        const bx = cx.map(row => row.map(v => v > 0.5));
        const by = cy.map(row => row.map(v => v > 0.5));
        const score = connectivityScore(bx, by, cageTotals);
        if (score > bestScore) {
          bestScore = score;
          bestBorderX = bx;
          bestBorderY = by;
          if (bestScore === nHeads) break;
        }
      }
    }

    // Retry cage total extraction with best borders.
    try {
      const brdrs2 = buildBrdrs(bestBorderX, bestBorderY);
      const cageSizes2 = computeCageSizes(bestBorderX, bestBorderY);
      lastCageTotalsResult = buildCageTotals(
        cv, warpedBlkMat, subres, brdrs2, cageSizes2,
      );
      ({ cageTotals, cellThumbs, cellSourceCrops, cellRecognitions } = lastCageTotalsResult);

      const totalSum = cageTotals.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
      if (totalSum < 360 || totalSum > 450) {
        // Adaptive threshold fallback.
        const adaptiveBlk = new cv.Mat();
        cv.adaptiveThreshold(
          warpedGryMat, adaptiveBlk, 255,
          cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
          (subres >> 2) | 1, config.numberRecognition.contourFallbackAdaptiveC,
        );
        try {
          lastCageTotalsResult = buildCageTotals(
            cv, adaptiveBlk, subres, brdrs2, cageSizes2,
          );
          ({ cageTotals, cellThumbs, cellSourceCrops, cellRecognitions } = lastCageTotalsResult);
          fallbackUsed = true;
        } finally {
          adaptiveBlk.delete();
        }
      }
    } catch (e) {
      console.warn('[parsePuzzleImage] buildCageTotals retry failed, leaving cageTotals as-is', e);
    }
  }

  // Read classic digits before deleting mats — classicConf is all-zero for true Killer
  // puzzles (cheap no-op), but captures given digits if OCR misdetected the type so that
  // the user can switch to Classic via the type dropdown and still get a correct solution.
  const { digits: givenDigits, recognitions: classicRecognitions } =
    readClassicDigits(cv, warpedBlkMat, subres, classicConf);

  warpedGryMat.delete();
  warpedBlkMat.delete();

  if (cageTotals === null) {
    return {
      spec: null,
      specError: 'Could not extract cage totals',
      fallbackUsed,
      puzzleType: 'killer',
      givenDigits,
      warpedImageData: warpedImgData,
      cellThumbs: new Map(),
      cellSourceCrops: new Map(),
      classicRecognitions,
      cageTotalRecognitions: new Map(),
    };
  }

  // Try strict validation first. On failure (structural or range), fall back
  // to a lenient layout that keeps everything actually detected -- real
  // borders, real totals, unclamped -- with only the problem cage(s)
  // implicitly flagged (via spec.regions grouping them normally; the review
  // screen's own applyDraftLayout re-check finds and highlights them),
  // rather than discarding the detection or silently rewriting a misread
  // total.
  let spec: PuzzleSpec | null = null;
  let specError: string | null = null;
  try {
    spec = validateCageLayout(cageTotals, bestBorderX, bestBorderY);
  } catch (strictErr) {
    const { regions } = buildLenientCageLayout(cageTotals, bestBorderX, bestBorderY);
    spec = { regions, cageTotals, borderX: bestBorderX, borderY: bestBorderY };
    specError = String(strictErr);
  }

  if (specError === null) {
    const totalSum = cageTotals.reduce((s, col) => s + col.reduce((a, b) => a + b, 0), 0);
    if (totalSum < 360 || totalSum > 450) {
      specError = `Cage totals sum to ${totalSum} (expected 405) — some may be misread; please review.`;
    }
  }

  return {
    spec,
    specError,
    fallbackUsed,
    puzzleType: 'killer',
    givenDigits,
    warpedImageData: warpedImgData,
    cellThumbs,
    cellSourceCrops,
    classicRecognitions,
    cageTotalRecognitions: cellRecognitions,
  };
}

// ---------------------------------------------------------------------------
/** Returns true for structural cage errors (region clash or unassigned cell) that cannot be repaired by clamping totals. */
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the cage-totals (9×9) [col][row] array from the warped binary image.
 *
 * Finds all digit contours, classifies them, and assembles the grid.
 */
export interface CageTotalsResult {
  cageTotals: number[][];
  /** Post-split thumbnails presented to the digit recogniser, keyed "row,col". */
  cellThumbs: Map<string, Uint8Array[]>;
  /** Untouched bounding-box pixels from the warped grid, aligned with cellThumbs. */
  cellSourceCrops: Map<string, RawDigitCrop[]>;
  /** Recognition for each cage-total digit crop, keyed "row,col", array order matching cellThumbs. */
  cellRecognitions: Map<string, Recognition[]>;
}

/**
 * Auto-Canny threshold rule (Rosebrock): derive the low/high hysteresis
 * thresholds from the image's own median intensity rather than a fixed
 * absolute cutoff, so contrast/lighting differences across the corpus don't
 * require a hand-tuned per-puzzle value.
 */
function autoCannyThresholds(gry: OpenCVMat, sigma: number): [number, number] {
  const pixels = gry.data as Uint8Array;
  const counts = new Uint32Array(256);
  for (const v of pixels) counts[v] = counts[v]! + 1;
  const half = pixels.length / 2;
  let cum = 0;
  let median = 255;
  for (let v = 0; v < 256; v++) {
    cum += counts[v]!;
    if (cum >= half) { median = v; break; }
  }
  const low = Math.max(0, Math.round((1 - sigma) * median));
  const high = Math.min(255, Math.round((1 + sigma) * median));
  return [low, high];
}

/**
 * 1D k-means (Lloyd's algorithm), deterministic percentile-based init. The
 * segment-average distributions this feeds it are cleanly tri-modal (dark
 * ink / mid grey / light background on real corpus images), so a fixed
 * init converges reliably without needing k-means++'s random restarts.
 */
function kmeans1D(values: Float64Array, k: number, maxIterations = 50): { centers: number[]; labels: Int32Array } {
  const n = values.length;
  const sorted = Float64Array.from(values).sort();
  const centers: number[] = [];
  for (let i = 0; i < k; i++) {
    centers.push(sorted[Math.min(Math.floor(((i + 0.5) / k) * n), n - 1)]!);
  }
  const labels = new Int32Array(n);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = Math.abs(values[i]! - centers[c]!);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; changed = true; }
    }
    const sums = new Array<number>(k).fill(0);
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const li = labels[i]!;
      sums[li] = sums[li]! + values[i]!;
      counts[li] = counts[li]! + 1;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c]! > 0) centers[c] = sums[c]! / counts[c]!;
    }
    if (!changed) break;
  }
  return { centers, labels };
}

interface SweepSegment {
  axis: 0 | 1; // 0 = fixed row, varying col; 1 = fixed col, varying row
  line: number;
  lo: number;
  hi: number; // exclusive
  avg: number;
}

/**
 * Binarises a warped grayscale image into a solid ink mask (ink=255,
 * non-ink=0) via Canny edge detection + a "sweep and cluster" fill. This
 * replaces warping a single global threshold (cv2.inRange, computed once
 * during grid location on the original pre-warp photo and reused for digit
 * extraction) as the source of warpedBlk: a single global cutoff can
 * swallow a digit into an adjacent gridline's connected component (e.g. a
 * "22" total whose base stroke touches the solid vertical gridline came out
 * as a single misread "8"). Canny's local gradient magnitude keeps a
 * digit's outline as a distinct edge even where its ink is pixel-connected
 * to a border line under simple thresholding -- but Canny edges are 1px
 * wires, and findContours on them traces the wire's own thin ribbon
 * boundary, not the glyph's solid interior (no amount of fillPoly fixes
 * that, since the contour itself isn't a solid-region boundary). This
 * reconstructs a solid mask directly from pixel shade instead of relying on
 * contour fill.
 *
 * Algorithm: sweep every row and every column of the whole image. On each
 * scanline, Canny edge pixels split it into segments and are excluded from
 * both the segment span and its average (edges are never ink -- they only
 * serve as segment dividers). Every segment's average shade, from both
 * sweeps across the whole image, is clustered into 3 groups (dark ink / mid
 * grey / light background) via 1D k-means, ranked darkest to lightest.
 *
 * Where the row-sweep and column-sweep segment covering a pixel agree on
 * rank, that shared rank decides it: darkest-or-middle is ink, lightest is
 * not. Where they disagree, a segment average can be diluted by an
 * incompletely-closed Canny edge (e.g. a gap in the outline around a
 * stroke's tip lets that segment run into neighboring background,
 * pulling its average toward "grey"/"white" even though the individual
 * pixel is genuinely dark) -- so disagreement is resolved using the
 * conflicting pixel's own raw shade against the same k-means centers
 * (nearest-center classification) rather than either segment average:
 * nearest-to-darkest is ink, nearest-to-grey-or-white is not.
 */
function buildSweepInkMask(cv: Cv, warpedGry: OpenCVMat, cannySigma: number): OpenCVMat {
  const size = warpedGry.rows;
  const gryData = warpedGry.data as Uint8Array;

  const [cannyLow, cannyHigh] = autoCannyThresholds(warpedGry, cannySigma);
  const edges = new cv.Mat();
  // apertureSize=5 and 7 (larger Sobel kernels) introduced visible noise in
  // a visual sweep across a range of aperture/L2gradient/sigma combos on a
  // real corpus crop (guardian/killer_sudoku_0.jpg r8c5); apertureSize=3
  // with L2gradient=true (accurate sqrt(dx^2+dy^2) magnitude instead of the
  // default |dx|+|dy| approximation) was the clear winner and is not
  // sensitive to cannySigma in the range tested (0.20-0.70).
  cv.Canny(warpedGry, edges, cannyLow, cannyHigh, 3, true);
  const edgeData = edges.data as Uint8Array;

  const segments: SweepSegment[] = [];

  for (let r = 0; r < size; r++) {
    const base = r * size;
    let lo = 0;
    for (let x = 0; x <= size; x++) {
      if (x === size || edgeData[base + x]! > 0) {
        if (x > lo) {
          let sum = 0;
          for (let p = lo; p < x; p++) sum += gryData[base + p]!;
          segments.push({ axis: 0, line: r, lo, hi: x, avg: sum / (x - lo) });
        }
        lo = x + 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let lo = 0;
    for (let y = 0; y <= size; y++) {
      if (y === size || edgeData[y * size + c]! > 0) {
        if (y > lo) {
          let sum = 0;
          for (let p = lo; p < y; p++) sum += gryData[p * size + c]!;
          segments.push({ axis: 1, line: c, lo, hi: y, avg: sum / (y - lo) });
        }
        lo = y + 1;
      }
    }
  }

  const avgs = Float64Array.from(segments, s => s.avg);
  const { centers, labels } = kmeans1D(avgs, 3);
  const order = centers
    .map((center, cluster) => ({ center, cluster }))
    .sort((a, b) => a.center - b.center)
    .map(({ cluster }) => cluster);
  const rankOfCluster = new Array<number>(3);
  order.forEach((cluster, rank) => { rankOfCluster[cluster] = rank; });

  // Per-axis, per-pixel raw cluster rank: 0 = darkest ("black"), 1 = middle
  // ("grey"), 2 = lightest ("white"), -1 = edge pixel (excluded from every
  // segment on both axes, so never covered by this scatter).
  const rowRank = new Int8Array(size * size).fill(-1);
  const colRank = new Int8Array(size * size).fill(-1);

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    const rank = rankOfCluster[labels[s]!]!;
    if (seg.axis === 0) {
      const base = seg.line * size;
      for (let p = seg.lo; p < seg.hi; p++) rowRank[base + p] = rank;
    } else {
      for (let p = seg.lo; p < seg.hi; p++) colRank[p * size + seg.line] = rank;
    }
  }

  const mask = new cv.Mat(size, size, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0));
  const maskData = mask.data as Uint8Array;
  for (let i = 0; i < size * size; i++) {
    const r = rowRank[i]!;
    const c = colRank[i]!;
    if (r < 0 || c < 0) continue; // edge pixel -- stays non-ink
    if (r === c) {
      // Agreement: trust the shared segment-average classification.
      if (r <= 1) maskData[i] = 255;
      continue;
    }
    // Conflict: the two segment AVERAGES disagree, but a segment average
    // can be diluted by neighboring ink/background when Canny's edge trace
    // doesn't fully close around a stroke (e.g. a "1"'s bottom tip with a
    // gap in its edge outline lets the segment run past the stroke into
    // background, pulling that segment's average toward "grey"/"white"
    // even though the pixel's own local neighborhood is genuinely dark).
    // Rather than defaulting to non-ink, reclassify a small 9x9 window
    // centered on this pixel (clamped at the image border) against the
    // same k-means centers: nearest-to-darkest wins ink, nearest-to-grey-
    // or-white wins non-ink. A 9x9 local average is noise-robust (unlike
    // the single raw pixel) while still being tight enough not to blend
    // across a genuine stroke/background boundary the way a whole segment
    // average can when its edge trace leaks.
    const cy = (i / size) | 0;
    const cx = i % size;
    let localSum = 0;
    let localCount = 0;
    for (let dy = -4; dy <= 4; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= size) continue;
      const base = ny * size;
      for (let dx = -4; dx <= 4; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= size) continue;
        localSum += gryData[base + nx]!;
        localCount++;
      }
    }
    const localAvg = localSum / localCount;
    let best = 0;
    let bestDist = Infinity;
    for (let cl = 0; cl < centers.length; cl++) {
      const d = Math.abs(localAvg - centers[cl]!);
      if (d < bestDist) { bestDist = d; best = cl; }
    }
    if (rankOfCluster[best] === 0) maskData[i] = 255;
  }

  // Edges are never ink -- redundant given the above (an edge pixel is
  // always excluded from every segment on both axes, so it's always -1/-1
  // and already fails the r>=0/c>=0 check), but stated explicitly since
  // it's a hard invariant, not an emergent property callers should rely on
  // staying true if the rule above changes.
  for (let i = 0; i < size * size; i++) {
    if (edgeData[i]! > 0) maskData[i] = 0;
  }

  edges.delete();

  return mask;
}

export function buildCageTotals(
  cv: Cv,
  warpedBlk: OpenCVMat,
  subres: number,
  brdrs: Brdrs,
  cageSizes: number[][],
): CageTotalsResult {
  const numPixels: Array<Array<Uint8Array[] | null>> = Array.from(
    { length: 9 }, () => new Array<Uint8Array[] | null>(9).fill(null),
  );
  const sourceCrops: Array<Array<RawDigitCrop[] | null>> = Array.from(
    { length: 9 }, () => new Array<RawDigitCrop[] | null>(9).fill(null),
  );

  const contours = new cv.MatVector();
  const hierMat = new cv.Mat();
  cv.findContours(warpedBlk, contours, hierMat, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

  if (contours.size() > 0 && hierMat.rows > 0) {
    const chiers = contourHier(cv, contours, hierMat, new Set<number>(), 0);
    const rawNums = getNumContours(chiers, subres);
    rawNums.sort((a, b) => a[0][0] - b[0][0]);

    for (const [br] of rawNums) {
      const [brx, bry, brw, brh] = br;
      // Standard mapping: x-coordinate (brx) is the horizontal/column
      // position, y-coordinate (bry) is the vertical/row position. Verified
      // against guardian/killer_sudoku_0.jpg with a grid-line-overlay crop
      // of the source photo (precise pixel-to-cell mapping, not an indirect
      // connectivityScore proxy): cageTotals[row][col] must equal the true
      // value printed in that cell.
      const col = ((brx + (brw >> 1)) / subres) | 0;
      const row = ((bry + (brh >> 1)) / subres) | 0;
      if (col < 0 || col >= 9 || row < 0 || row >= 9) continue;

      let numThumbArr: Uint8Array[];
      let sourceCropArr: RawDigitCrop[];
      try {
        [numThumbArr, sourceCropArr] = splitNum(cv, br, warpedBlk, subres);
      } catch (err) {
        console.warn('splitNum failed for contour', br, err);
        continue;
      }

      if (numPixels[row]![col] === null) numPixels[row]![col] = [];
      if (sourceCrops[row]![col] === null) sourceCrops[row]![col] = [];
      numPixels[row]![col]!.push(...numThumbArr);
      sourceCrops[row]![col]!.push(...sourceCropArr);
    }
  }
  contours.delete();
  hierMat.delete();

  const cageTotals: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const cellThumbs = new Map<string, Uint8Array[]>();
  const cellSourceCrops = new Map<string, RawDigitCrop[]>();
  const cellRecognitions = new Map<string, Recognition[]>();
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const sums = numPixels[row]![col]!;
      if (sums !== null) {
        const crops = sourceCrops[row]![col] ?? null;
        const cageSize = cageSizes[row]![col]!;
        const allowedLabels = sums.map((_, digitIndex) =>
          allowedDigitsForPosition(cageSize, digitIndex, sums.length));
        const ntrs = activeRecogniser().recognise(sums, allowedLabels);
        const key = `${row},${col}`;
        if (crops === null || crops.length !== sums.length || ntrs.length !== sums.length) {
          throw new Error(
            `Digit evidence misaligned for ${key}: crops=${crops?.length ?? 0}, thumbnails=${sums.length}, recognitions=${ntrs.length}`,
          );
        }
        if (ntrs.length > 4) {
          throw new ProcessingError(
            `Too many digits (${ntrs.length}) in cell (row=${row},col=${col})`,
            Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
            brdrs,
          );
        }
        for (const { label, confident } of ntrs) {
          if (!confident) console.warn(`Low-confidence digit read in (row=${row},col=${col})`);
          if (label >= 0) cageTotals[row]![col] = 10 * cageTotals[row]![col]! + label;
        }
        cellThumbs.set(key, sums);
        cellSourceCrops.set(key, crops);
        cellRecognitions.set(key, ntrs);
      }
    }
  }
  return {
    cageTotals, cellThumbs, cellSourceCrops, cellRecognitions,
  };
}

/**
 * Count connected cage regions that contain exactly one printed total.
 *
 * @param borderX - (9×8) [col][rowGap] cage-wall flags.
 * @param borderY - (8×9) [colGap][row] cage-wall flags.
 * @param cageTotals - (9×9) [row][col] non-zero at cage heads.
 */
/** @internal Exported for unit tests only. */
export function connectivityScore(
  borderX: boolean[][],
  borderY: boolean[][],
  cageTotals: number[][],
): number {
  const visited: boolean[][] = Array.from({ length: 9 }, () => new Array<boolean>(9).fill(false));
  let score = 0;

  for (let sr = 0; sr < 9; sr++) {
    for (let sc = 0; sc < 9; sc++) {
      if (visited[sr]![sc]!) continue;
      const region: Array<[number, number]> = [[sr, sc]];
      visited[sr]![sc] = true;
      let heads = 0;
      let i = 0;
      while (i < region.length) {
        const [r, c] = region[i++]!;
        if (cageTotals[r]![c]! > 0) heads++;
        // down
        if (r + 1 < 9 && !visited[r + 1]![c]! && !borderX[c]![r]!) {
          visited[r + 1]![c] = true; region.push([r + 1, c]);
        }
        // up
        if (r > 0 && !visited[r - 1]![c]! && !borderX[c]![r - 1]!) {
          visited[r - 1]![c] = true; region.push([r - 1, c]);
        }
        // right
        if (c + 1 < 9 && !visited[r]![c + 1]! && !borderY[c]![r]!) {
          visited[r]![c + 1] = true; region.push([r, c + 1]);
        }
        // left
        if (c > 0 && !visited[r]![c - 1]! && !borderY[c - 1]![r]!) {
          visited[r]![c - 1] = true; region.push([r, c - 1]);
        }
      }
      if (heads === 1) score++;
    }
  }
  return score;
}

/**
 * Decode an image File to an ImageData using an OffscreenCanvas.
 */
async function decodeImageFile(file: File): Promise<ImageData> {
  if (isPdfFile(file)) {
    return decodePdfFile(file);
  }
  let bitmap: ImageBitmap;
  try {
    // colorSpaceConversion: 'none' skips ICC profile application, matching
    // cv2.imread's behaviour (which ignores embedded colour profiles).
    bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none' });
  } catch {
    throw new ImageDecodeError(`"${file.name}" is not a recognised image format`);
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function decodePdfFile(file: File): Promise<ImageData> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data, verbosity: 0 }).promise;
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = new OffscreenCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d')!;
    await page.render({
      canvas: null,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    await pdf.destroy();
  }
}

/**
 * Warp the original image using the given corners to produce a perspective-corrected
 * ImageData. Used for the live corner-picker preview in the review screen.
 *
 * @param cv - OpenCV.js module.
 * @param imageData - Original (un-warped) image data.
 * @param corners - Grid corners in original-image pixel space [x_TL,y_TL,x_TR,y_TR,x_BR,y_BR,x_BL,y_BL].
 * @param dstSize - Output image size (square, in pixels).
 */

/**
 * Compute the power-of-2 scale factor applied by prepareGrayMat/pyrUp loops.
 * Returns `2^n` where `n` is the number of pyrUp passes needed so that both
 * `width` and `height` reach at least `resolution`.
 */

/**
 * Build two independent grayscale Mats from an ImageData, scaled up as needed.
 *
 * Returns two distinct Mat objects (not aliases) so callers can delete each
 * independently without triggering a double-free.  The first Mat is reserved
 * for binary cage-digit extraction (callers apply adaptiveThreshold after
 * warping); the second is the bordered grayscale used by locateGrid.
 *
 * @param cv - OpenCV.js module.
 * @param imageData - Raw RGBA pixel data.
 * @param resolution - Minimum pixel dimension (9 × subres).
 * @returns [mat1, mat2] — two independent bordered-grayscale Mats.
 */
function prepareGrayMat(cv: Cv, imageData: ImageData, resolution: number): [OpenCVMat, OpenCVMat] {
  let src = cv.matFromImageData(imageData);
  let gry = new cv.Mat();
  cv.cvtColor(src, gry, cv.COLOR_RGBA2GRAY);
  src.delete();

  // Scale up until both dimensions are at least resolution.
  while (gry.rows < resolution || gry.cols < resolution) {
    const up = new cv.Mat();
    cv.pyrUp(gry, up);
    gry.delete();
    gry = up;
  }

  // Add a 3px white border on all sides, matching Python's get_gry_img — this
  // ensures Hough/contour detection near the true image edge is fully enclosed.
  const bordered = new cv.Mat();
  cv.copyMakeBorder(gry, bordered, 3, 3, 3, 3, cv.BORDER_CONSTANT, new cv.Scalar(255));
  gry.delete();
  gry = bordered;

  // Return a clone so the two handles are independent (caller deletes both).
  return [gry.clone(), gry];
}

/**
 * Roll (rotate) the corner array by `shift` positions.
 * Corners are stored as flat [x0,y0, x1,y1, x2,y2, x3,y3].
 */
function rollCorners(corners: Float32Array, shift: number): Float32Array {
  const n = 4;
  const result = new Float32Array(8);
  for (let i = 0; i < n; i++) {
    const src = ((i - shift) % n + n) % n;
    result[i * 2] = corners[src * 2]!;
    result[i * 2 + 1] = corners[src * 2 + 1]!;
  }
  return result;
}

/**
 * Convert an OpenCV Mat to an ImageData (RGBA).
 */
function matToImageData(cv: Cv, mat: OpenCVMat, size: number): ImageData {
  let rgba: OpenCVMat;
  if (mat.channels() === 4) {
    rgba = mat.clone();
  } else {
    rgba = new cv.Mat();
    if (mat.channels() === 3) {
      cv.cvtColor(mat, rgba, cv.COLOR_BGR2RGBA);
    } else {
      cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
    }
  }
  const imageData = new ImageData(new Uint8ClampedArray(rgba.data), size, size);
  rgba.delete();
  return imageData;
}
