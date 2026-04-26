/**
 * Image pipeline orchestrator: parses a puzzle image into a PuzzleSpec.
 *
 * Mirrors Python's `InpImage` class from `killer_sudoku.image.inp_image`,
 * adapted for the browser:
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
import { scanCells, detectRotation, detectPuzzleType } from './cellScan.js';
import { clusterBorders } from './borderClustering.js';
import type { GrayImage } from './borderClustering.js';
import {
  getSums, splitNum, contourHier, getNumContours, readClassicDigits,
} from './numberRecognition.js';
import type { NumRecogniser } from './numberRecognition.js';
import { validateCageLayout } from './validation.js';
import { buildBrdrs } from '../solver/puzzleSpec.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import { ProcessingError } from '../solver/errors.js';
import type { Brdrs } from '../solver/errors.js';
import { boundaryKind, BoundaryKind } from './borderClustering.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result returned by parsePuzzleImage. */
export interface ParseResult {
  /** Validated puzzle spec, or null if validation failed. */
  spec: PuzzleSpec | null;
  /** Human-readable error description, or null on success. */
  specError: string | null;
  /** 'killer' or 'classic'. */
  puzzleType: 'killer' | 'classic';
  /**
   * For classic puzzles: (9×9) given digits [row][col], 0 = empty.
   * Null for killer puzzles.
   */
  givenDigits: number[][] | null;
  /**
   * Perspective-corrected RGBA ImageData of the grid, for rendering.
   * Null if the pipeline failed before producing a warped image.
   */
  warpedImageData: ImageData | null;
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
 * @param rec - Pre-loaded digit recogniser (from loadNumRecogniser).
 * @param config - Pipeline configuration (defaults used if omitted).
 */
export async function parsePuzzleImage(
  cv: Cv,
  file: File,
  rec: NumRecogniser,
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
    blk.delete();
  } catch (err) {
    gryMat.delete();
    blkMat.delete();
    throw err; // Re-throw: grid not found means no useful data.
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

  // Warp grayscale then adaptively threshold for cage-digit contour extraction.
  const [blkMat2,] = prepareGrayMat(cv, imageData, resolution);
  const warpedGryTmp = new cv.Mat();
  cv.warpPerspective(blkMat2, warpedGryTmp, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);
  blkMat2.delete();
  let warpedBlkMat = new cv.Mat();
  cv.adaptiveThreshold(
    warpedGryTmp, warpedBlkMat, 255,
    cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
    (subres >> 2) | 1, config.borderDetection.adaptiveC,
  );
  warpedGryTmp.delete();

  let warpedGryMat = new cv.Mat();
  cv.warpPerspective(gryMat, warpedGryMat, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);

  // Colour warp for rendering.
  const srcMat = cv.matFromImageData(imageData);
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

    // Re-warp all three Mats.
    const [blkMat3,] = prepareGrayMat(cv, imageData, resolution);
    const warpedGryTmp2 = new cv.Mat();
    cv.warpPerspective(blkMat3, warpedGryTmp2, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);
    blkMat3.delete();
    warpedBlkMat.delete();
    warpedBlkMat = new cv.Mat();
    cv.adaptiveThreshold(
      warpedGryTmp2, warpedBlkMat, 255,
      cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
      (subres >> 2) | 1, config.borderDetection.adaptiveC,
    );
    warpedGryTmp2.delete();

    warpedGryMat.delete();
    warpedGryMat = new cv.Mat();
    cv.warpPerspective(gryMat, warpedGryMat, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);

    const srcMat2 = cv.matFromImageData(imageData);
    warpedImgMat.delete();
    warpedImgMat = new cv.Mat();
    cv.warpPerspective(srcMat2, warpedImgMat, mMat, new cv.Size(dstSize, dstSize), cv.INTER_LINEAR);
    srcMat2.delete();
  }
  gryMat.delete(); blkMat.delete(); mMat.delete();

  // Convert warped colour image to ImageData for the result.
  const warpedCanvas = new OffscreenCanvas(dstSize, dstSize);
  warpedCanvas.getContext('2d');
  const warpedImgData = matToImageData(cv, warpedImgMat, dstSize);
  warpedImgMat.delete();

  // --- Stage 3: Puzzle type detection ---
  const [cageConf, classicConf] = scanCells(
    cv, warpedGryMat, subres, config.cellScan.classicMinSizeFraction,
  );
  const puzzleType = detectPuzzleType(warpedGryMat, subres, config.cellScan.tlFractionThreshold);

  // --- Classic path ---
  if (puzzleType === 'classic') {
    const givenDigits = readClassicDigits(cv, warpedBlkMat, rec, subres, classicConf);
    warpedGryMat.delete(); warpedBlkMat.delete();

    // Classic borders: rows separated by full walls, columns open.
    const borderX: boolean[][] = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true));
    const borderY: boolean[][] = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));

    const cageTotals: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    for (let r = 0; r < 9; r++) cageTotals[0]![r] = 45;

    let spec: PuzzleSpec | null = null;
    let specError: string | null = null;
    try {
      spec = validateCageLayout(cageTotals, borderX, borderY);
    } catch (err) {
      specError = String(err);
    }
    return { spec, specError, puzzleType: 'classic', givenDigits, warpedImageData: warpedImgData };
  }

  // --- Killer path: Stage 4 border clustering ---
  const gryImg: GrayImage = { data: new Uint8Array(warpedGryMat.data), size: dstSize };

  const [bxProb, byProb] = clusterBorders(
    gryImg, cageConf, subres, config.borderClustering,
    config.cellScan.anchorConfidenceThreshold,
  );

  // Compute cage totals once (image-dependent only).
  let initialBorderX = bxProb.map(row => row.map(v => v > 0.5));
  let initialBorderY = byProb.map(row => row.map(v => v > 0.5));

  let cageTotals: number[][] | null = null;
  try {
    const brdrs = buildBrdrs(initialBorderX, initialBorderY);
    cageTotals = buildCageTotals(cv, warpedBlkMat, rec, subres, brdrs);
  } catch {
    // Can't score polarities without cage totals; proceed with initial estimate.
  }

  let bestBorderX = initialBorderX;
  let bestBorderY = initialBorderY;

  if (cageTotals !== null) {
    const nHeads = cageTotals.reduce((s, col) => s + col.filter(v => v > 0).length, 0);
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
      cageTotals = buildCageTotals(cv, warpedBlkMat, rec, subres, brdrs2);

      const totalSum = cageTotals.reduce((s, col) => s + col.reduce((a, b) => a + b, 0), 0);
      if (totalSum < 360 || totalSum > 450) {
        // Adaptive threshold fallback.
        const adaptiveBlk = new cv.Mat();
        cv.adaptiveThreshold(
          warpedGryMat, adaptiveBlk, 255,
          cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
          (subres >> 2) | 1, config.numberRecognition.contourFallbackAdaptiveC,
        );
        try {
          cageTotals = buildCageTotals(cv, adaptiveBlk, rec, subres, brdrs2);
        } finally {
          adaptiveBlk.delete();
        }
      }
    } catch {
      // Leave cageTotals as-is.
    }
  }

  warpedGryMat.delete();
  warpedBlkMat.delete();

  if (cageTotals === null) {
    return {
      spec: null,
      specError: 'Could not extract cage totals',
      puzzleType: 'killer',
      givenDigits: null,
      warpedImageData: warpedImgData,
    };
  }

  const totalSum = cageTotals.reduce((s, col) => s + col.reduce((a, b) => a + b, 0), 0);
  if (totalSum < 360 || totalSum > 450) {
    const brdrs = buildBrdrs(bestBorderX, bestBorderY);
    const err = new ProcessingError(
      `Cage totals sum to ${totalSum}, expected 405`,
      Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
      brdrs,
    );
    return {
      spec: null,
      specError: err.message,
      puzzleType: 'killer',
      givenDigits: null,
      warpedImageData: warpedImgData,
    };
  }

  let spec: PuzzleSpec | null = null;
  let specError: string | null = null;
  try {
    spec = validateCageLayout(cageTotals, bestBorderX, bestBorderY);
  } catch (err) {
    specError = String(err);
  }

  return { spec, specError, puzzleType: 'killer', givenDigits: null, warpedImageData: warpedImgData };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the cage-totals (9×9) [col][row] array from the warped binary image.
 *
 * Finds all digit contours, classifies them, and assembles the grid.
 */
function buildCageTotals(
  cv: Cv,
  warpedBlk: OpenCVMat,
  rec: NumRecogniser,
  subres: number,
  brdrs: Brdrs,
): number[][] {
  const numPixels: Array<Array<Uint8Array[] | null>> = Array.from(
    { length: 9 }, () => new Array<Uint8Array[] | null>(9).fill(null),
  );

  const contours = new cv.MatVector();
  const hierMat = new cv.Mat();
  cv.findContours(warpedBlk, contours, hierMat, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

  if (contours.size() > 0 && hierMat.rows > 0) {
    const chiers = contourHier(cv, contours, hierMat, new Set<number>(), 0);
    const rawNums = getNumContours(chiers, subres);

    // Process in x-order (left to right).
    rawNums.sort((a, b) => a[1][0] - b[1][0]);

    for (const [, br,] of rawNums) {
      let numThumbArr: Uint8Array[];
      let by: number;
      try {
        [numThumbArr, , by] = splitNum(cv, br, warpedBlk, subres);
      } catch {
        continue; // Unexpected geometry — skip.
      }
      void by;

      const [brx, bry, brw, brh] = br;
      const col = ((brx + (brw >> 1)) / subres) | 0;
      const row = ((bry + (brh >> 1)) / subres) | 0;
      if (col < 0 || col >= 9 || row < 0 || row >= 9) continue;

      if (numPixels[col]![row] === null) numPixels[col]![row] = [];
      numPixels[col]![row]!.push(...numThumbArr);
    }
  }
  contours.delete();
  hierMat.delete();

  const cageTotals: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 9; row++) {
      const sums = numPixels[col]![row]!;
      if (sums !== null) {
        const ntrs = getSums(cv, rec, sums);
        if (ntrs.length > 4) {
          throw new ProcessingError(
            `Too many digits (${ntrs.length}) in cell (${col},${row})`,
            Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
            brdrs,
          );
        }
        for (const v of ntrs) {
          if (v >= 0) cageTotals[col]![row] = 10 * cageTotals[col]![row]! + v;
        }
      }
    }
  }
  return cageTotals;
}

/**
 * Count connected cage regions that contain exactly one printed total.
 *
 * @param borderX - (9×8) [col][rowGap] cage-wall flags.
 * @param borderY - (8×9) [colGap][row] cage-wall flags.
 * @param cageTotals - (9×9) [col][row] non-zero at cage heads.
 */
function connectivityScore(
  borderX: boolean[][],
  borderY: boolean[][],
  cageTotals: number[][],
): number {
  const visited: boolean[][] = Array.from({ length: 9 }, () => new Array<boolean>(9).fill(false));
  let score = 0;

  for (let sc = 0; sc < 9; sc++) {
    for (let sr = 0; sr < 9; sr++) {
      if (visited[sc]![sr]!) continue;
      const region: Array<[number, number]> = [[sc, sr]];
      visited[sc]![sr] = true;
      let heads = 0;
      let i = 0;
      while (i < region.length) {
        const [c, r] = region[i++]!;
        if (cageTotals[c]![r]! > 0) heads++;
        // down
        if (r + 1 < 9 && !visited[c]![r + 1]! && !borderX[c]![r]!) {
          visited[c]![r + 1] = true; region.push([c, r + 1]);
        }
        // up
        if (r > 0 && !visited[c]![r - 1]! && !borderX[c]![r - 1]!) {
          visited[c]![r - 1] = true; region.push([c, r - 1]);
        }
        // right
        if (c + 1 < 9 && !visited[c + 1]![r]! && !borderY[c]![r]!) {
          visited[c + 1]![r] = true; region.push([c + 1, r]);
        }
        // left
        if (c > 0 && !visited[c - 1]![r]! && !borderY[c - 1]![r]!) {
          visited[c - 1]![r] = true; region.push([c - 1, r]);
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
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

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

  // Add 3-pixel black border (ensures contours near edges are closed).
  const gryMat = new cv.Mat();
  cv.copyMakeBorder(gry, gryMat, 3, 3, 3, 3, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  gry.delete();

  // Return a clone so the two handles are independent (caller deletes both).
  return [gryMat.clone(), gryMat];
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
  let rgba = new cv.Mat();
  if (mat.channels() === 4) {
    rgba = mat.clone();
  } else if (mat.channels() === 3) {
    cv.cvtColor(mat, rgba, cv.COLOR_BGR2RGBA);
  } else {
    cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
  }
  const imageData = new ImageData(new Uint8ClampedArray(rgba.data), size, size);
  rgba.delete();
  return imageData;
}
