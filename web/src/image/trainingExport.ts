/**
 * Exports confirmed cage-total thumbnails as labelled training samples for the
 * digit recogniser.  Uses the thumbnails captured during OCR — the same images
 * the recogniser actually saw — so no JPEG re-processing is needed.
 *
 * Also provides PuzzleSpecExport for uploading puzzles that required MRV
 * backtracking, so they can be used to improve the constraint-propagation rules.
 */

import { cellLabel } from '../engine/rules/_labels.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';

export interface TrainingSample {
  /** Digit label (0–9). */
  digit: number;
  /** Flattened 64×64 uint8 pixel values. */
  pixels: number[];
}

/**
 * Uploaded when a killer puzzle required MRV backtracking to solve — i.e.
 * the constraint-propagation rules alone stalled before finding a complete
 * assignment.  Used offline to identify hard puzzles that could improve the
 * rule engine.
 */
export interface PuzzleSpecExport {
  version: 2;
  exportedAt: string;
  appVersion: string;
  puzzleType: 'killer';
  /** (9,9) 1-based cage index per cell [row][col]. */
  regions: number[][];
  /** (9,9) cage totals at head cells, 0 elsewhere [row][col]. */
  cageTotals: number[][];
  /** (9,8) horizontal cage-wall flags [col][rowGap]. */
  borderX: boolean[][];
  /** (8,9) vertical cage-wall flags [colGap][row]. */
  borderY: boolean[][];
}

export function buildPuzzleSpecExport(spec: PuzzleSpec): PuzzleSpecExport {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    puzzleType: 'killer',
    regions: spec.regions.map(row => [...row]),
    cageTotals: spec.cageTotals.map(row => [...row]),
    borderX: spec.borderX.map(col => [...col]),
    borderY: spec.borderY.map(colGap => [...colGap]),
  };
}

export interface TrainingExport {
  version: 1;
  exportedAt: string;
  /** App build timestamp — identifies which recogniser generated these samples. */
  appVersion: string;
  puzzleType: 'killer' | 'classic';
  /** Pixels per cell side used during pipeline processing (default 128). */
  subres: number;
  /** Side length of each thumbnail square in pixels (always 64). */
  thumbnailSize: number;
  sampleCount: number;
  samples: TrainingSample[];
}

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
  cellThumbs: ReadonlyMap<string, Uint8Array[]>,
  cageTotals: readonly (readonly number[])[],
  puzzleType: 'killer' | 'classic',
  subres: number,
): TrainingExport {
  const samples: TrainingSample[] = [];

  for (const [key, thumbArr] of cellThumbs) {
    const [row, col] = key.split(',').map(Number) as [number, number];
    const confirmed = cageTotals[row]?.[col] ?? 0;
    if (confirmed <= 0) continue;

    const digits = String(confirmed).split('').map(Number);
    if (digits.length !== thumbArr.length) {
      console.warn(
        `[trainingExport] ${cellLabel([row, col])}: confirmed=${confirmed} ` +
        `(${digits.length} digit${digits.length > 1 ? 's' : ''}) ` +
        `but found ${thumbArr.length} thumbnail${thumbArr.length !== 1 ? 's' : ''} — skipped`,
      );
      continue;
    }

    for (let i = 0; i < digits.length; i++) {
      samples.push({ digit: digits[i]!, pixels: Array.from(thumbArr[i]!) });
    }
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    puzzleType,
    subres,
    thumbnailSize: 64,
    sampleCount: samples.length,
    samples,
  };
}
