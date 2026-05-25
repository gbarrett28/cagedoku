/**
 * Stress-test runner — processes every puzzle image in STRESS_PUZZLE_DIR
 * through the production image pipeline and records solver metrics.
 *
 * Each image becomes one Playwright test so workers can distribute them
 * automatically. All tests within a worker share a single browser page;
 * OpenCV.js WASM compiles once per worker (~60 s) and stays resident.
 *
 * Usage: see scripts/run-stress-test.sh
 *
 * Per-worker results are written to <STRESS_PUZZLE_DIR>/eval_results_<pid>.json.
 * Run scripts/merge-stress-results.mjs afterwards to combine into eval_report.json.
 */

import { test, type Browser, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { waitForPipelineReady } from './helpers.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PUZZLE_DIR = process.env['STRESS_PUZZLE_DIR'];
const IMAGE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors PuzzleSpec from web/src/solver/puzzleSpec.ts — serialised over page.evaluate(). */
interface PuzzleSpecData {
  regions: number[][];
  cageTotals: number[][];
  borderX: boolean[][];
  borderY: boolean[][];
}

interface SolverResult {
  usedBacktracking: boolean;
  stalledCandidates: number[][][] | null;
  spec: PuzzleSpecData | null;
}

interface ImageResult {
  file: string;
  pipeline_ok: boolean;
  solution_found: boolean;
  backtracker_required: boolean;
  unsolved_cells: number;
  total_candidates: number;
  duration_ms: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Worker-local state (one page shared across all tests in this worker)
// ---------------------------------------------------------------------------

let sharedPage: Page | null = null;
const workerResults: ImageResult[] = [];

async function getSharedPage(browser: Browser): Promise<Page> {
  if (sharedPage === null || sharedPage.isClosed()) {
    sharedPage = await browser.newPage();
    await sharedPage.addInitScript(() => {
      localStorage.setItem('coach_tutorial_suppressed', 'true');
      // Suppress training-consent modal. Consent is stored as a cookie, not
      // localStorage. 'granted' is the only value that bypasses the modal;
      // there is no "permanently declined" state in the consent state machine.
      document.cookie = 'training_consent=granted; max-age=31536000; SameSite=Strict';
    });
    await sharedPage.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForPipelineReady(sharedPage, 90_000);
  }
  return sharedPage;
}

// ---------------------------------------------------------------------------
// Per-image processing
// ---------------------------------------------------------------------------

async function processImage(page: Page, imagePath: string): Promise<ImageResult> {
  const file = path.basename(imagePath);
  const t0 = Date.now();

  try {
    await page.locator('#file-input').setInputFiles(imagePath);
    await page.locator('#process-btn').click();

    // Wait for the review panel OR playing mode (auto-confirm may skip the review screen).
    // '#action-group:not([hidden])' uniquely identifies playing mode — it is hidden in
    // review mode and shown only after the user (or auto-confirm) transitions to playing.
    await page.waitForSelector(
      '#review-panel:not([hidden]), #action-group:not([hidden])',
      { timeout: IMAGE_TIMEOUT_MS },
    );

    // A non-empty error status means OCR or validation failed.
    const statusText = (await page.locator('#status-msg').textContent() ?? '').trim();
    const pipelineError = statusText.length > 0 &&
      /failed|error|could not|no solution/i.test(statusText);

    if (pipelineError) {
      return {
        file, pipeline_ok: false, solution_found: false, backtracker_required: false,
        unsolved_cells: 0, total_candidates: 0, duration_ms: Date.now() - t0,
        error: statusText,
      };
    }

    // If the assertion checker fired, the solver produced an invalid solution
    // (e.g. duplicate digit in a unit — typically caused by corrupted cage totals).
    // Record as a pipeline error so the eval_report reflects the real failure mode.
    const assertionOpen = await page.evaluate(
      () => (document.getElementById('assertion-modal') as HTMLDialogElement | null)?.open ?? false,
    );
    if (assertionOpen) {
      const desc = (await page.locator('#assertion-desc').textContent() ?? '').trim();
      return {
        file, pipeline_ok: false, solution_found: false, backtracker_required: false,
        unsolved_cells: 0, total_candidates: 0, duration_ms: Date.now() - t0,
        error: `Assertion violation: ${desc}`,
      };
    }

    // Read solver stats exposed by main.ts.
    const solverResult = await page.evaluate((): SolverResult => {
      const w = window as unknown as { __lastSolverResult?: SolverResult | null };
      return w.__lastSolverResult ?? { usedBacktracking: false, stalledCandidates: null, spec: null };
    });

    const sc = solverResult.stalledCandidates;
    const unsolvedCells = sc === null ? 0
      : sc.flat().filter(c => c.length > 1).length;
    const totalCandidates = sc === null ? 0
      : sc.flat().filter(c => c.length > 1).reduce((sum, c) => sum + c.length, 0);

    // Write a stall fixture alongside the source image when backtracking was required.
    if (solverResult.usedBacktracking && solverResult.stalledCandidates !== null &&
        solverResult.spec !== null && PUZZLE_DIR) {
      const name = path.basename(imagePath, path.extname(imagePath));
      const source = path.basename(PUZZLE_DIR);
      // Repo-root-relative path using forward slashes (for cross-platform portability).
      const relImagePath = path.relative(process.cwd(), imagePath).replace(/\\/g, '/');
      const stallFixture = {
        version: 1 as const,
        source,
        name,
        addedAt: new Date().toISOString().slice(0, 10),
        puzzleType: 'killer' as const,
        imagePath: relImagePath,
        spec: solverResult.spec,
        stalledCandidates: solverResult.stalledCandidates,
        unsolvedCells,
        totalCandidates,
      };
      const stallPath = path.join(PUZZLE_DIR, `${name}.stall.json`);
      fs.writeFileSync(stallPath, JSON.stringify(stallFixture, null, 2));
      console.log(`[stress] Stall fixture written: ${stallPath}`);
    }

    return {
      file,
      pipeline_ok: true,
      solution_found: true,
      backtracker_required: solverResult.usedBacktracking,
      unsolved_cells: unsolvedCells,
      total_candidates: totalCandidates,
      duration_ms: Date.now() - t0,
      error: null,
    };
  } catch (e) {
    return {
      file, pipeline_ok: false, solution_found: false, backtracker_required: false,
      unsolved_cells: 0, total_candidates: 0, duration_ms: Date.now() - t0,
      error: String(e),
    };
  } finally {
    // Dismiss assertion modal if it is still open — it intercepts all pointer
    // events and would block the #new-puzzle-btn click below.
    const assertionStillOpen = await page.evaluate(
      () => (document.getElementById('assertion-modal') as HTMLDialogElement | null)?.open ?? false,
    ).catch(() => false);
    if (assertionStillOpen) {
      await page.locator('#assertion-dismiss-btn').click().catch(() => {});
      await page.locator('#assertion-modal').waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
    }

    // Reset to the upload screen without a full page reload.
    const newPuzzleBtn = page.locator('#new-puzzle-btn');
    const btnVisible = await newPuzzleBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (btnVisible) {
      await newPuzzleBtn.click();
      await page.locator('#upload-panel')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => { /* handled by next test */ });
    } else {
      // Fallback: reload if the new-puzzle button is not reachable.
      await page.goto('/', { waitUntil: 'domcontentloaded' });
    }
  }
}

// ---------------------------------------------------------------------------
// Image list — evaluated at module load so Playwright sees the full test count
// ---------------------------------------------------------------------------

const images: string[] = PUZZLE_DIR
  ? fs.readdirSync(PUZZLE_DIR)
      .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
      .map(f => path.resolve(PUZZLE_DIR, f))
      .sort()
  : [];

// ---------------------------------------------------------------------------
// Tests — one per image; workers distribute these, each compiling WASM once
// ---------------------------------------------------------------------------

test.describe('stress', () => {
  test.skip(!PUZZLE_DIR || images.length === 0,
    'Set STRESS_PUZZLE_DIR to a directory of puzzle images to run this suite.');

  test.afterAll(async () => {
    if (workerResults.length === 0 || !PUZZLE_DIR) return;
    const outPath = path.join(PUZZLE_DIR, `eval_results_${process.pid}.json`);
    fs.writeFileSync(outPath, JSON.stringify(workerResults, null, 2));
    console.log(`[stress] Worker ${process.pid}: wrote ${workerResults.length} results → ${outPath}`);
  });

  for (const imagePath of images) {
    test(path.basename(imagePath), async ({ browser }) => {
      test.setTimeout(IMAGE_TIMEOUT_MS + 15_000);
      const page = await getSharedPage(browser);
      const result = await processImage(page, imagePath);
      workerResults.push(result);
    });
  }
});
