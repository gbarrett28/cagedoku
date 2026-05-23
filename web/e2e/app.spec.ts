/**
 * End-to-end tests for the COACH sudoku app.
 *
 * Tests run against `vite preview` (http://localhost:4173), serving the
 * production build from `dist/`.  Run `npm run build` before running tests
 * if the source has changed since the last build.
 *
 * Timeout strategy:
 *   - Structural tests (title, panel visibility): 8 s; opencv.js is stubbed
 *     so WASM compilation never starts and teardown is instant.
 *   - Pipeline-dependent tests (opencv load, upload, playing): 360 s; see
 *     PIPELINE note below for why these are slow in headless Chromium.
 *
 * Why pipeline tests are slow in headless (PIPELINE gate):
 *   opencv.js is a SINGLE_FILE emscripten build — the WASM binary is
 *   base64-encoded inside the JS.  V8 cannot stream-compile a base64 data
 *   URI; it must decode the whole string, then call WebAssembly.instantiate
 *   (non-streaming, blocking).  In a real browser the compiled module is
 *   persisted in V8's code cache so reloads are instant; each Playwright
 *   test context starts with a clean profile and no cache, so it cold-
 *   compiles the full WASM (~20–40 s) every time.  9 pipeline tests ×
 *   ~30 s each ≈ 4–5 min total.
 *
 *   Fix: rebuild opencv.js as a two-file output (opencv.js + opencv.wasm)
 *   so loadCV can use WebAssembly.instantiateStreaming — V8 compiles as
 *   bytes arrive and the result is cacheable.  Until then, opt in with
 *   PLAYWRIGHT_PIPELINE_TESTS=1.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { stubOpenCV, waitForPipelineReady } from './helpers.js';

// Pipeline tests require real opencv.js loading. They are slow in headless Chromium
// because opencv.js is a SINGLE_FILE base64 build that cannot be stream-compiled
// (see file header). Set PLAYWRIGHT_PIPELINE_TESTS=1 to opt in.
const PIPELINE = process.env['PLAYWRIGHT_PIPELINE_TESTS'] === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUZZLE_IMAGE = path.resolve(
  __dirname,
  '../../guardian/killer_sudoku_0.jpg',
);

// ---------------------------------------------------------------------------
// Helpers — see e2e/helpers.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test: page structure  (fast — structural only)
// ---------------------------------------------------------------------------

test('page loads with correct title and upload panel visible', async ({ page }) => {
  test.setTimeout(8_000);
  await stubOpenCV(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/COACH/);
  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#review-panel')).toBeHidden();
  await expect(page.locator('#process-btn')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test: no JS errors on load  (fast — waits 2 s then checks)
// ---------------------------------------------------------------------------

test('no console errors on page load', async ({ page }) => {
  test.setTimeout(8_000);
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await stubOpenCV(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);

  const fatal = errors.filter(e =>
    !e.includes('runtime.lastError') &&
    !e.includes('chrome-extension') &&
    !e.includes('favicon'),
  );
  expect(fatal, `Unexpected console errors:\n${fatal.join('\n')}`).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: opencv + model load successfully  (slow — pipeline load)
// ---------------------------------------------------------------------------

test('image pipeline loads without error', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1 — cold WASM compile in headless (~30 s); see file header');
  test.setTimeout(360_000); // WASM init in headless Chromium takes 150–180 s on this hardware

  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000); // 330 s ceiling; leaves 30 s for assertions

  // Use evaluate (not locator) — after waitForPipelineReady, the DOM is settled.
  const statusText = await page.evaluate(
    () => document.getElementById('status-msg')?.textContent ?? '',
  );
  expect(statusText).not.toContain('failed');

  const pipelineErrors = errors.filter(e =>
    (e.includes('opencv') || e.includes('recogniser') || e.includes('RangeError')) &&
    !e.includes('chrome-extension'),
  );
  expect(pipelineErrors, `Pipeline errors:\n${pipelineErrors.join('\n')}`).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: upload and process a real puzzle image  (slow)
// ---------------------------------------------------------------------------

test('upload puzzle image → review panel appears with canvas', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000);

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();

  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('#upload-panel')).toBeHidden();

  const canvas = page.locator('#grid-canvas');
  await expect(canvas).toBeVisible();
  const width = await canvas.evaluate((el: HTMLCanvasElement) => el.width);
  expect(width).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test: status message clears after successful processing  (slow)
// ---------------------------------------------------------------------------

test('status message is empty after successful image process', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000);

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();

  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });

  const status = await page.locator('#status-msg').textContent();
  expect(status ?? '').toBe('');
});

// ---------------------------------------------------------------------------
// Test: confirm → playing mode  (slow)
// ---------------------------------------------------------------------------

test('confirm puzzle → playing actions panel appears', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000);

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();
  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });

  await page.locator('#confirm-btn').click();

  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#undo-btn')).toBeVisible();
  await expect(page.locator('#hints-btn')).toBeVisible();
  await expect(page.locator('#candidates-btn')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test: place a digit  (slow)
// ---------------------------------------------------------------------------

test('click cell then press digit → digit appears in canvas, undo enabled', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000);

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();
  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 15_000 });

  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cellSize = box!.width / 9;
  await canvas.click({
    position: { x: cellSize * 4.5, y: cellSize * 4.5 },
  });

  await page.keyboard.press('5');

  const undoDisabled = await page.locator('#undo-btn').getAttribute('disabled');
  expect(undoDisabled).toBeNull();
});

// ---------------------------------------------------------------------------
// Test: undo removes the digit  (slow)
// ---------------------------------------------------------------------------

test('undo after placing digit re-disables undo button', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000);

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();
  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 15_000 });

  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 4.5, y: cellSize * 4.5 } });
  await page.keyboard.press('5');

  await expect(page.locator('#undo-btn')).not.toBeDisabled();
  await page.locator('#undo-btn').click();

  await expect(page.locator('#undo-btn')).toBeDisabled();
});

// ---------------------------------------------------------------------------
// Test: show candidates  (slow)
// ---------------------------------------------------------------------------

test('show candidates button toggles candidate display', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000);

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();
  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 15_000 });

  const candidatesBtn = page.locator('#candidates-btn');
  await expect(candidatesBtn).not.toBeDisabled();
  await candidatesBtn.click();

  await expect(candidatesBtn).toContainText(/hide/i);
});

// ---------------------------------------------------------------------------
// Test: new puzzle resets to upload panel  (slow)
// ---------------------------------------------------------------------------

test('new puzzle button returns to upload panel', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000);

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();
  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });

  await expect(page.locator('#new-puzzle-btn')).toBeVisible();
  await page.locator('#new-puzzle-btn').click();

  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#review-panel')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Test: cageTotals row-major orientation (replaces it.todo in inpImage.test.ts)
// ---------------------------------------------------------------------------

test('cageTotals row-major orientation — connectivityScore ≥ threshold', async ({ page }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  // 10 min: WASM compilation takes 150–300 s when run in isolation (no cache
  // warm-up from prior tests). 600 s gives ~300 s for WASM + 300 s for processing.
  test.setTimeout(600_000);

  // Suppress the tutorial modal so it doesn't block #process-btn (same fix as flow.spec.ts).
  await page.addInitScript(() => localStorage.setItem('coach_tutorial_suppressed', 'true'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 540_000); // 9 min ceiling for WASM load

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();
  // The hook is set as soon as borders are computed, regardless of whether the puzzle
  // auto-confirms (goes directly to playing mode) or shows the review screen.
  // Classic puzzles always go to review; killer puzzles may auto-confirm.
  await page.waitForFunction(
    () => (window as unknown as Record<string, unknown>)['__lastPipelineResult'] !== undefined,
    { timeout: 60_000 },
  );

  // Read the pipeline result exposed by window.__lastPipelineResult and compute
  // connectivity score inline. Mirrors buildUnionFind in validation.ts.
  // Correct row-major orientation → score ≈ 26 (one head per cage).
  // Transposed orientation → score ≤ 2 (heads land in wrong regions).
  const score = await page.evaluate(() => {
    const result = (window as unknown as Record<string, unknown>)['__lastPipelineResult'] as {
      cageTotals: number[][]; borderX: boolean[][]; borderY: boolean[][];
    } | undefined;
    if (!result) throw new Error('__lastPipelineResult not set — hook missing in main.ts');

    const { cageTotals, borderX, borderY } = result;
    const rep: Record<string, string> = {};
    const members: Record<string, string[]> = {};
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      const k = `${r},${c}`; rep[k] = k; members[k] = [k];
    }
    const find = (k: string): string => rep[k]!;
    const union = (a: string, b: string): void => {
      const [ra, rb] = [find(a), find(b)]; if (ra === rb) return;
      const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
      for (const p of members[drop]!) { rep[p] = keep; members[keep]!.push(p); }
      delete members[drop];
    };
    for (let col = 0; col < 9; col++) for (let rowGap = 0; rowGap < 8; rowGap++)
      if (!borderX[col]![rowGap]) union(`${rowGap},${col}`, `${rowGap+1},${col}`);
    for (let colGap = 0; colGap < 8; colGap++) for (let row = 0; row < 9; row++)
      if (!borderY[colGap]![row]) union(`${row},${colGap}`, `${row},${colGap+1}`);
    let score = 0;
    for (const cells of Object.values(members)) {
      const heads = cells.filter(k => {
        const [r, c] = k.split(',').map(Number) as [number, number];
        return (cageTotals[r]?.[c] ?? 0) > 0;
      });
      if (heads.length === 1) score++;
    }
    return score;
  });

  expect(score).toBeGreaterThanOrEqual(10);
});
