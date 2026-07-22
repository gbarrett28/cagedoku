#!/usr/bin/env vite-node
/**
 * Drives one puzzle image through the browser pipeline and dumps its
 * bit-check stage checkpoints to JSON, for comparison against
 * killer_sudoku/scripts/bitcheck_dump.py's output.
 *
 * Requires: npm run build && npm run preview (in another terminal)
 *
 * Run from web/:
 *   npx vite-node --script scripts/bitcheck-dump.ts <image_path> [--out FILE]
 */
import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { waitForPipelineReady } from '../e2e/helpers.js';

const BASE_URL = 'http://localhost:4173';

interface OutcomeJson {
  puzzleType: string | null;
  specError: string | null;
  borderX?: boolean[][] | null;
  borderY?: boolean[][] | null;
  cageTotals?: number[][] | null;
  givenDigits?: number[][] | null;
  gray?: number[];
  graySize?: [number, number];
  gridCorners?: number[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const imagePath = args[0];
  if (!imagePath) {
    console.error('Usage: bitcheck-dump.ts <image_path> [--out FILE]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1]! : imagePath.replace(/\.jpe?g$/i, '.ts.bitcheck.json');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE_URL);
  await waitForPipelineReady(page);
  await page.evaluate(() => { (window as unknown as Record<string, unknown>)['__reportContourTree'] = true; });

  const liveMatsBefore = await page.evaluate(
    () => (window as unknown as { __cvLiveMats?: () => number }).__cvLiveMats?.() ?? -1,
  );

  const outcomePromise = page.evaluate(() => new Promise<OutcomeJson>(resolve => {
    (window as unknown as { __reportOutcome?: (o: OutcomeJson) => void }).__reportOutcome = resolve;
  }));
  await page.locator('#file-input').setInputFiles(path.resolve(imagePath));
  const outcome = await outcomePromise;

  const liveMatsAfter = await page.evaluate(
    () => (window as unknown as { __cvLiveMats?: () => number }).__cvLiveMats?.() ?? -1,
  );

  await browser.close();

  fs.writeFileSync(outPath, JSON.stringify({
    gray: outcome.gray,
    graySize: outcome.graySize,
    gridCorners: outcome.gridCorners,
    puzzleType: outcome.puzzleType,
    borderX: outcome.borderX ?? null,
    borderY: outcome.borderY ?? null,
    cageTotals: outcome.cageTotals ?? null,
    givenDigits: outcome.givenDigits ?? null,
    specError: outcome.specError,
    liveMatsBefore,
    liveMatsAfter,
  }));
  console.log(`Wrote ${outPath}`);
  if (liveMatsAfter > liveMatsBefore) {
    console.warn(`WARNING: leaked ${liveMatsAfter - liveMatsBefore} cv.Mat objects processing this image`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
