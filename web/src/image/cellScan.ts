/**
 * Cell scanning: Stage 3 of the image pipeline.
 *
 * Mirrors Python's `killer_sudoku.image.cell_scan` module.
 *
 * Classifies each of the 81 cells for cage-total digits (small contour in
 * the top-left quadrant) and classic pre-filled digits (large centred
 * contour). Also detects puzzle rotation and puzzle type (killer vs classic).
 */

import type { OpenCVModule, OpenCVMat } from './opencv.js';
type Cv = OpenCVModule;

/**
 * Roll constant: given dominant quadrant index → number of corner positions
 * to roll so that the dominant corner maps to TL.
 * Indices: 0=TL, 1=TR, 2=BL, 3=BR.
 */
const DOMINANT_TO_ROT90_K: readonly number[] = [0, 1, 3, 2];

/**
 * Scan all 81 cells for cage totals and classic pre-filled digits.
 *
 * For each cell, checks for small contours in the top-left quadrant (cage
 * total indicator) and large centred contours (classic sudoku pre-filled digit).
 *
 * @param cv - OpenCV.js module.
 * @param warpedGry - Perspective-corrected grayscale Mat, (9*subres × 9*subres).
 * @param subres - Pixels per cell side.
 * @param classicMinSizeFraction - Min contour dimension fraction for classic digits.
 * @returns [cageTotalConfidence, classicDigitConfidence], each (9×9) [row][col]
 *   with values in {0.0, 1.0}.
 */
export function scanCells(
  cv: Cv,
  warpedGry: OpenCVMat,
  subres: number,
  classicMinSizeFraction: number,
): [number[][], number[][]] {
  const cageConf: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const classicConf: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  const half = subres >> 1;
  const minW = subres >> 4;
  const maxW = subres >> 1;
  const minH = subres >> 3;
  const maxH = subres >> 1;
  const blockSize = Math.max(3, (half >> 2) | 1);

  const classicMin = Math.floor(subres * classicMinSizeFraction);
  const margin = (subres / 6) | 0;
  const patchSize = subres - 2 * margin;
  const classicBlock = Math.max(3, (patchSize >> 2) | 1);

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const y0 = row * subres;
      const x0 = col * subres;

      // --- Cage total detection (top-left quadrant) ---
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

      for (let i = 0; i < contoursTL.size(); i++) {
        const br = cv.boundingRect(contoursTL.get(i));
        if (br.width >= minW && br.width < maxW && br.height >= minH && br.height < maxH) {
          cageConf[row]![col] = 1.0;
          break;
        }
      }
      contoursTL.delete();

      // --- Classic digit detection (central region) ---
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

  return [cageConf, classicConf];
}

/**
 * Sum per-cell ink in each of the four inner quadrants across all 81 cells.
 *
 * A border margin (subres // 6) is excluded from each cell so that cage-border
 * lines do not contribute to the signal.
 *
 * @param warpedGry - Perspective-corrected grayscale Mat.
 * @param subres - Pixels per cell side.
 * @returns [TL, TR, BL, BR] summed ink values.
 */
export function computeQuadSums(warpedGry: OpenCVMat, subres: number): [number, number, number, number] {
  const margin = (subres / 6) | 0;
  const inner = subres - 2 * margin;
  const halfInner = inner >> 1;
  const data: Uint8Array = warpedGry.data as Uint8Array;
  const width: number = warpedGry.cols as number;

  let tl = 0, tr = 0, bl = 0, br = 0;

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const y0 = row * subres + margin;
      const x0 = col * subres + margin;

      // Accumulate ink (255 - grey) for each quadrant within the inner patch.
      let tlSum = 0, trSum = 0, blSum = 0, brSum = 0;
      let tlN = 0, trN = 0, blN = 0, brN = 0;

      for (let dy = 0; dy < inner; dy++) {
        for (let dx = 0; dx < inner; dx++) {
          const ink = 255 - data[(y0 + dy) * width + (x0 + dx)]!;
          if (dy < halfInner && dx < halfInner) { tlSum += ink; tlN++; }
          else if (dy < halfInner) { trSum += ink; trN++; }
          else if (dx < halfInner) { blSum += ink; blN++; }
          else { brSum += ink; brN++; }
        }
      }

      tl += tlN > 0 ? tlSum / tlN : 0;
      tr += trN > 0 ? trSum / trN : 0;
      bl += blN > 0 ? blSum / blN : 0;
      br += brN > 0 ? brSum / brN : 0;
    }
  }

  return [tl, tr, bl, br];
}

/**
 * Return the k parameter to roll the corner array to normalise puzzle orientation.
 *
 * Killer-sudoku cage totals always appear in one corner of their cells. When
 * the image is rotated the dominant corner will be TR, BL, or BR instead of
 * TL. This function identifies the dominant corner and returns the roll count
 * so that re-warping places it at the canonical TL position.
 *
 * Returns 0 when TL is already dominant, the image is blank, or the ink is too
 * uniformly spread to reliably infer orientation.
 *
 * @param warpedGry - Perspective-corrected grayscale Mat.
 * @param subres - Pixels per cell side.
 * @param rotationDominanceThreshold - Minimum dominant-quadrant fraction to trigger.
 */
export function detectRotation(
  warpedGry: OpenCVMat,
  subres: number,
  rotationDominanceThreshold: number,
): number {
  const quads = computeQuadSums(warpedGry, subres);
  const total = quads[0] + quads[1] + quads[2] + quads[3];
  if (total < 1.0) return 0;

  let dominant = 0;
  for (let i = 1; i < 4; i++) if (quads[i]! > quads[dominant]!) dominant = i;

  if (dominant === 0) return 0;
  if (quads[dominant]! / total < rotationDominanceThreshold) return 0;

  return DOMINANT_TO_ROT90_K[dominant]!;
}

/**
 * Classify puzzle type from per-cell inner-quadrant ink distribution.
 *
 * Killer puzzles concentrate cage-total ink in one corner (dominant quadrant
 * fraction 0.65–0.98). Classic puzzles distribute digits centrally (~0.25 per
 * quadrant). The 0.40 threshold gives comfortable margins on both sides.
 *
 * @param warpedGry - Perspective-corrected grayscale Mat.
 * @param subres - Pixels per cell side.
 * @param tlFractionThreshold - Minimum dominant-quadrant fraction for killer.
 */
export function detectPuzzleType(
  warpedGry: OpenCVMat,
  subres: number,
  tlFractionThreshold: number,
): 'killer' | 'classic' {
  const quads = computeQuadSums(warpedGry, subres);
  const total = quads[0] + quads[1] + quads[2] + quads[3];
  if (total < 1.0) return 'killer';

  const maxFraction = Math.max(...quads) / total;
  return maxFraction >= tlFractionThreshold ? 'killer' : 'classic';
}
