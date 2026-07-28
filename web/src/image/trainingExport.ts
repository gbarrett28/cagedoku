/**
 * Exports confirmed cage-total thumbnails as labelled training samples for the
 * digit recogniser.  Uses the thumbnails captured during OCR — the same images
 * the recogniser actually saw — so no JPEG re-processing is needed.
 */

import { cellLabel } from '../engine/rules/_labels.js';
import type { RawDigitCrop, WarpStrategy } from './numberRecognition.js';
import type {
  TrainingExport as SharedTrainingExport,
  TrainingSample as SharedTrainingSample,
} from '../../../shared/src/reports/TrainingExport.js';

export type TrainingSample = SharedTrainingSample;

export type TrainingExport = SharedTrainingExport;

/**
 * Build a TrainingExport from the thumbnails captured during OCR and the
 * user-confirmed cage totals.  Does NOT re-load or re-process any image.
 *
 * @param cellThumbs  Map keyed "row,col" → thumbnails from buildCageTotals.
 * @param cageTotals  Confirmed totals [row][col]; 0 = not a cage head.
 * @param puzzleType  Stored verbatim in the export for downstream filtering.
 * @param subres      Pixels per cell side (from ImagePipelineConfig).
 */
export function extractTrainingData(
  cellThumbs: ReadonlyMap<string, readonly Uint8Array[]>,
  cellSourceCrops: ReadonlyMap<string, readonly RawDigitCrop[]>,
  cageTotals: readonly (readonly number[])[],
  puzzleType: 'killer' | 'classic',
  subres: number,
  warpStrategy: WarpStrategy,
): TrainingExport {
  const samples: TrainingSample[] = [];

  for (const [key, thumbArr] of cellThumbs) {
    const [row, col] = key.split(',').map(Number) as [number, number];
    const confirmed = cageTotals[row]?.[col] ?? 0;
    if (confirmed <= 0) continue;

    const digits = String(confirmed).split('').map(Number);
    const sourceArr = cellSourceCrops.get(key);
    if (digits.length !== thumbArr.length || sourceArr === undefined || sourceArr.length !== thumbArr.length) {
      console.warn(
        `[trainingExport] ${cellLabel([row, col])}: evidence count mismatch ` +
        `(digits=${digits.length}, thumbnails=${thumbArr.length}, sourceCrops=${sourceArr?.length ?? 0}) — skipped`,
      );
      continue;
    }

    for (let i = 0; i < digits.length; i++) {
      const source = sourceArr[i]!;
      samples.push({
        digit: digits[i]!,
        sourceRect: [source.x, source.y, source.width, source.height],
        sourceWidth: source.width,
        sourceHeight: source.height,
        sourcePixels: Array.from(source.pixels),
        recognitionPixels: Array.from(thumbArr[i]!),
        warpStrategy,
      });
    }
  }

  return {
    reportType: 'training-export',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    puzzleType,
    subres,
    thumbnailSize: 64,
    sampleCount: samples.length,
    samples,
  };
}
