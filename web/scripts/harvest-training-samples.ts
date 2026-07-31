#!/usr/bin/env vite-node
/**
 * Harvest OCR-misread digit thumbnails as labelled training samples.
 *
 * For each puzzle in the input JSON, loads the image in the browser pipeline,
 * compares the OCR's digit reading against the user-provided ground-truth grid,
 * and collects the 64×64 cell thumbnails for every misread cell.
 *
 * Outputs a file in the same format as corpus_train.json so it can be merged
 * directly:
 *   python web/train_recogniser.py --browser-weight 1000 --svm-c 100 \
 *     web/corpus_train.json web/harvested_samples.json
 *
 * Usage:
 *   cd web
 *   npx vite-node scripts/harvest-training-samples.ts --input scripts/correct-grids.json
 *   npx vite-node scripts/harvest-training-samples.ts --input scripts/correct-grids.json --out scripts/harvested_samples.json
 */

import * as path from 'path';
import * as fs from 'fs';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { waitForPipelineReady } from '../e2e/helpers.js';

const PREVIEW_BASE_URL = 'http://localhost:4173';
const THUMBNAIL_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 30_000;

interface PuzzleInput {
  name: string;           // e.g. "killer_sudoku_104"
  path: string;           // absolute path to the puzzle image
  correctGrid: number[][]; // 9x9, 0 = empty
}

interface InputFile {
  puzzles: PuzzleInput[];
}

interface TrainingSample {
  digit: number;
  pixels: number[];
}

interface TrainingExport {
  reportType: 'training-export';
  exportedAt: string;
  appVersion: string;
  puzzleType: 'classic';
  subres: number;
  thumbnailSize: 64;
  sampleCount: number;
  samples: TrainingSample[];
}

interface OcrResult {
  givenDigits: number[][] | null;
  cellThumbs: Record<string, number[][]>; // key "row,col" → array of flat pixel arrays
}

interface ReportOutcome {
  bucket: string;
  puzzleType: string | null;
}

function parseArgs(): { input: string; out: string; baseUrl: string } {
  const args = process.argv.slice(2);
  let input = '';
  let out = path.resolve(__dirname, 'harvested_samples.json');
  let baseUrl = PREVIEW_BASE_URL;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) input = args[++i]!;
    if (args[i] === '--out' && args[i + 1]) out = args[++i]!;
    if (args[i] === '--base-url' && args[i + 1]) baseUrl = args[++i]!;
  }
  if (!input) {
    console.error('Usage: harvest-training-samples.ts --input <correct-grids.json> [--out <output.json>] [--base-url <url>]');
    process.exit(1);
  }
  return { input: path.resolve(input), out: path.resolve(out), baseUrl };
}

async function main(): Promise<void> {
  const { input, out, baseUrl } = parseArgs();

  const inputData: InputFile = JSON.parse(fs.readFileSync(input, 'utf-8'));
  const puzzles = inputData.puzzles;
  console.log(`Harvesting ${puzzles.length} puzzle(s) from ${baseUrl}…`);

  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  // Suppress tutorial modal and consent modal.
  await page.addInitScript(() => localStorage.setItem('coach_tutorial_suppressed', 'true'));
  await page.addInitScript(() => { HTMLDialogElement.prototype.showModal = () => {}; });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 90_000);

  // One-shot outcome resolver (same pattern as evaluate-corpus.ts).
  let resolveOutcome: ((o: ReportOutcome) => void) | null = null;
  await page.exposeFunction('__reportOutcome', (o: ReportOutcome) => {
    resolveOutcome?.(o);
    resolveOutcome = null;
  });

  const allSamples: TrainingSample[] = [];
  const appVersion = `harvested-${new Date().toISOString().slice(0, 10)}`;

  for (const puzzle of puzzles) {
    console.log(`\nProcessing ${puzzle.name}…`);

    const outcomePromise = new Promise<ReportOutcome>(r => { resolveOutcome = r; });
    const timeoutPromise = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${DEFAULT_TIMEOUT_MS}ms`)), DEFAULT_TIMEOUT_MS),
    );

    await page.locator('#file-input').setInputFiles(puzzle.path);
    let outcome: ReportOutcome;
    try {
      outcome = await Promise.race([outcomePromise, timeoutPromise]);
    } catch (e) {
      console.error(`  SKIP — ${e}`);
      continue;
    }

    // Accept both 'classic' and 'bigapple': both go through the classic OCR path.
    if (outcome.puzzleType !== 'classic' && outcome.puzzleType !== 'bigapple') {
      console.warn(`  SKIP — detected type '${outcome.puzzleType}', expected classic/bigapple`);
      continue;
    }

    const ocrResult: OcrResult | null = await page.evaluate(() =>
      (window as any).__ocrResult ?? null
    );

    if (ocrResult === null || ocrResult.givenDigits === null) {
      console.warn(`  SKIP — no OCR result available`);
      continue;
    }


    const ocrGrid = ocrResult.givenDigits;
    const correctGrid = puzzle.correctGrid;
    let harvested = 0;
    let mismatches = 0;

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const ocrDigit = ocrGrid[r]?.[c] ?? 0;
        const correctDigit = correctGrid[r]?.[c] ?? 0;

        if (correctDigit === 0) continue;       // empty cell — nothing to harvest
        if (ocrDigit === correctDigit) continue; // OCR was right

        mismatches++;
        const key = `${r},${c}`;
        const thumbArrays = ocrResult.cellThumbs[key];
        if (!thumbArrays || thumbArrays.length === 0) {
          console.warn(`  r${r + 1}c${c + 1}: OCR=${ocrDigit} correct=${correctDigit} — no thumbnail`);
          continue;
        }

        // Use the first (and typically only) thumbnail for a classic given-digit cell.
        allSamples.push({ digit: correctDigit, pixels: thumbArrays[0]! });
        harvested++;
        console.log(`  r${r + 1}c${c + 1}: OCR read ${ocrDigit === 0 ? '(nothing)' : ocrDigit} → correct ${correctDigit}`);
      }
    }

    console.log(`  ${mismatches} mismatch(es), ${harvested} sample(s) harvested`);
  }

  await browser.close();

  const exportData: TrainingExport = {
    reportType: 'training-export',
    exportedAt: new Date().toISOString(),
    appVersion,
    puzzleType: 'classic',
    subres: 128,
    thumbnailSize: THUMBNAIL_SIZE,
    sampleCount: allSamples.length,
    samples: allSamples,
  };

  fs.writeFileSync(out, JSON.stringify(exportData, null, 2), 'utf-8');
  console.log(`\nWrote ${allSamples.length} sample(s) to ${out}`);
  console.log(`\nTo retrain: python web/train_recogniser.py --browser-weight 1000 --svm-c 100 web/corpus_train.json ${out}`);
}

main().catch(err => { console.error(err); process.exit(1); });
