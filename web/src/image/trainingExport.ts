/**
 * Exports confirmed cage-total thumbnails as labelled training samples for the
 * digit recogniser.  Re-runs the same contour-detection + splitNum pipeline used
 * by buildCageTotals, but uses user-verified cageTotals as ground-truth labels
 * instead of classifier output.
 */

import type { OpenCVModule } from './opencv.js';
type Cv = OpenCVModule;

import { adaptiveBlockSize, defaultImagePipelineConfig, subres as cfgSubres } from './config.js';
import type { ImagePipelineConfig } from './config.js';
import { contourHier, getNumContours, splitNum } from './numberRecognition.js';

export interface TrainingSample {
  /** Digit label (0–9). */
  digit: number;
  /** Flattened 64×64 uint8 binary pixel values (0 or 255). */
  pixels: number[];
}

export interface TrainingExport {
  version: 1;
  exportedAt: string;
  puzzleType: 'killer' | 'classic';
  /** Pixels per cell side used during pipeline processing (default 128). */
  subres: number;
  /** Side length of each thumbnail square in pixels (always 64). */
  thumbnailSize: number;
  sampleCount: number;
  samples: TrainingSample[];
}

/**
 * Loads the warped grid JPEG, applies the same adaptive-threshold + contour
 * pipeline used during OCR, and pairs each extracted digit thumbnail with the
 * user-confirmed digit from cageTotals.
 *
 * @param cv          Loaded OpenCV module.
 * @param warpedImageUrl  Blob URL of the perspective-corrected grid image.
 * @param cageTotals  Confirmed totals in [row][col] order; 0 = not a cage head.
 * @param puzzleType  Stored verbatim in the export for downstream filtering.
 */
export async function extractTrainingData(
  cv: Cv,
  warpedImageUrl: string,
  cageTotals: readonly (readonly number[])[],
  puzzleType: 'killer' | 'classic',
  config: ImagePipelineConfig = defaultImagePipelineConfig(),
): Promise<TrainingExport> {
  const subres = cfgSubres(config);

  // Load the warped JPEG from its blob URL into ImageData.
  const response = await fetch(warpedImageUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();

  // Grayscale → adaptive threshold — identical parameters to parsePuzzleImage.
  const srcMat = cv.matFromImageData(imageData);
  const gryMat = new cv.Mat();
  cv.cvtColor(srcMat, gryMat, cv.COLOR_RGBA2GRAY);
  srcMat.delete();

  const blkMat = new cv.Mat();
  cv.adaptiveThreshold(
    gryMat, blkMat, 255,
    cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
    adaptiveBlockSize(config), config.borderDetection.adaptiveC,
  );
  gryMat.delete();

  // Contour detection — mirrors buildCageTotals exactly.
  const contours = new cv.MatVector();
  const hierMat = new cv.Mat();
  cv.findContours(blkMat, contours, hierMat, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

  const samples: TrainingSample[] = [];

  if (contours.size() > 0 && hierMat.rows > 0) {
    const chiers = contourHier(cv, contours, hierMat, new Set<number>(), 0);
    const rawNums = getNumContours(chiers, subres);
    // Sort left-to-right so multi-contour digits accumulate in the correct order.
    rawNums.sort((a, b) => a[1][0] - b[1][0]);

    // Group thumbnails by cell, mirroring buildCageTotals exactly.
    // A single cage total can produce multiple contours (e.g. "16" → two strokes),
    // so we must accumulate all thumbnails for a cell before matching the label.
    const cellThumbs = new Map<string, Uint8Array[]>();

    for (const [, br] of rawNums) {
      let thumbArr: Uint8Array[];
      try {
        [thumbArr] = splitNum(cv, br, blkMat, subres);
      } catch {
        continue;
      }

      const [brx, bry, brw, brh] = br;
      const col = ((brx + (brw >> 1)) / subres) | 0;
      const row = ((bry + (brh >> 1)) / subres) | 0;
      if (col < 0 || col >= 9 || row < 0 || row >= 9) continue;

      const key = `${row},${col}`;
      const existing = cellThumbs.get(key);
      if (existing) existing.push(...thumbArr);
      else cellThumbs.set(key, [...thumbArr]);
    }

    // Match each cell's accumulated thumbnails to the confirmed total.
    for (const [key, thumbArr] of cellThumbs) {
      const [row, col] = key.split(',').map(Number) as [number, number];
      const confirmed = cageTotals[row]?.[col] ?? 0;
      if (confirmed <= 0) continue;

      const digits = String(confirmed).split('').map(Number);
      if (digits.length !== thumbArr.length) continue;

      for (let i = 0; i < digits.length; i++) {
        samples.push({ digit: digits[i]!, pixels: Array.from(thumbArr[i]!) });
      }
    }
  }

  contours.delete();
  hierMat.delete();
  blkMat.delete();

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    puzzleType,
    subres,
    thumbnailSize: 64,
    sampleCount: samples.length,
    samples,
  };
}
