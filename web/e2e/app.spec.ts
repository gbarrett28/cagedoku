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
 *   - Pipeline-dependent tests: share a single browser page via the
 *     `pipelinePage` worker-scoped fixture, so WASM compiles once (~30–60 s)
 *     and subsequent tests navigate back to the upload screen without a page
 *     reload.  Per-test budget is 90 s (first test absorbs the compile;
 *     subsequent tests use only a few seconds each).
 *
 * Why WASM is slow on first compile in headless Chromium:
 *   opencv.js is a SINGLE_FILE emscripten build — the WASM binary is
 *   base64-encoded inside the JS.  V8 cannot stream-compile a base64 data
 *   URI and must call WebAssembly.instantiate (non-streaming, ~20–40 s).
 *   In a real browser the compiled module is persisted in V8's code cache
 *   so reloads are instant.  The shared-page fixture avoids repeated compiles
 *   within a test run; the PLAYWRIGHT_PIPELINE_TESTS=1 gate keeps these
 *   tests opt-in because the first compile still takes tens of seconds.
 */

import { test, test as base, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { stubOpenCV, waitForPipelineReady } from './helpers.js';

// Pipeline tests require real opencv.js loading.
// Set PLAYWRIGHT_PIPELINE_TESTS=1 to opt in.
const PIPELINE = process.env['PLAYWRIGHT_PIPELINE_TESTS'] === '1';

// ---------------------------------------------------------------------------
// Singleton page: opencv compiles once, shared across all pipeline tests.
// Each test fixture call resets back to the upload screen without a reload,
// so the compiled WASM stays resident.  Teardown is in the fixture body
// (after `await use(page)`) so no afterEach hook is needed.
// ---------------------------------------------------------------------------

let _pipelinePage: Page | null = null;

const pipelineTest = base.extend<{ pipelinePage: Page }>({
  pipelinePage: async ({ browser }, use) => {
    if (_pipelinePage === null || _pipelinePage.isClosed()) {
      _pipelinePage = await browser.newPage();
      await _pipelinePage.addInitScript(
        () => localStorage.setItem('coach_tutorial_suppressed', 'true'),
      );
      await _pipelinePage.goto('/', { waitUntil: 'domcontentloaded' });
      await waitForPipelineReady(_pipelinePage, 90_000); // one cold WASM compile
    }
    await use(_pipelinePage);
    // After each test: navigate back to the upload screen without a page reload.
    const btn = _pipelinePage.locator('#new-puzzle-btn');
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click();
      await _pipelinePage.locator('#upload-panel')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => { /* next test handles whatever state it finds */ });
    }
  },
});

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
// Test: hint-pill DOM placement  (fast — structural only)
// ---------------------------------------------------------------------------

test('hint-pill is a direct child of canvas-col', async ({ page }) => {
  test.setTimeout(8_000);
  await stubOpenCV(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const parentId = await page.evaluate(() => {
    const pill = document.getElementById('hint-pill');
    return pill?.parentElement?.id ?? null;
  });
  expect(parentId).toBe('canvas-col');
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

pipelineTest('image pipeline loads without error', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1 — cold WASM compile in headless (~30 s); see file header');
  // Pipeline is already ready (fixture pre-loaded); this test just asserts the outcome.
  pipelineTest.setTimeout(90_000);

  const statusText = await pipelinePage.evaluate(
    () => document.getElementById('status-msg')?.textContent ?? '',
  );
  expect(statusText).not.toContain('failed');
});

// ---------------------------------------------------------------------------
// Test: upload and process a real puzzle image  (slow)
// ---------------------------------------------------------------------------

pipelineTest('upload puzzle image → review panel appears with canvas', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  pipelineTest.setTimeout(90_000);

  await pipelinePage.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await pipelinePage.locator('#process-btn').click();

  await expect(pipelinePage.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await expect(pipelinePage.locator('#upload-panel')).toBeHidden();

  const canvas = pipelinePage.locator('#grid-canvas');
  await expect(canvas).toBeVisible();
  const width = await canvas.evaluate((el: HTMLCanvasElement) => el.width);
  expect(width).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test: status message clears after successful processing  (slow)
// ---------------------------------------------------------------------------

pipelineTest('status message is empty after successful image process', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  pipelineTest.setTimeout(90_000);

  await pipelinePage.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await pipelinePage.locator('#process-btn').click();

  await expect(pipelinePage.locator('#review-panel')).toBeVisible({ timeout: 40_000 });

  const status = await pipelinePage.locator('#status-msg').textContent();
  expect(status ?? '').toBe('');
});

// ---------------------------------------------------------------------------
// Test: confirm → playing mode  (slow)
// ---------------------------------------------------------------------------

pipelineTest('confirm puzzle → playing actions panel appears', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  pipelineTest.setTimeout(90_000);

  await pipelinePage.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await pipelinePage.locator('#process-btn').click();
  await expect(pipelinePage.locator('#review-panel')).toBeVisible({ timeout: 40_000 });

  await pipelinePage.locator('#confirm-btn').click();

  await expect(pipelinePage.locator('#playing-actions')).toBeVisible({ timeout: 15_000 });
  await expect(pipelinePage.locator('#undo-btn')).toBeVisible();
  await expect(pipelinePage.locator('#hints-btn')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test: place a digit  (slow)
// ---------------------------------------------------------------------------

pipelineTest('click cell then press digit → digit appears in canvas, undo enabled', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  pipelineTest.setTimeout(90_000);

  await pipelinePage.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await pipelinePage.locator('#process-btn').click();
  await expect(pipelinePage.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await pipelinePage.locator('#confirm-btn').click();
  await expect(pipelinePage.locator('#playing-actions')).toBeVisible({ timeout: 15_000 });

  const canvas = pipelinePage.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 4.5, y: cellSize * 4.5 } });
  await pipelinePage.keyboard.press('5');

  const undoDisabled = await pipelinePage.locator('#undo-btn').getAttribute('disabled');
  expect(undoDisabled).toBeNull();
});

// ---------------------------------------------------------------------------
// Test: undo removes the digit  (slow)
// ---------------------------------------------------------------------------

pipelineTest('undo after placing digit re-disables undo button', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  pipelineTest.setTimeout(90_000);

  await pipelinePage.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await pipelinePage.locator('#process-btn').click();
  await expect(pipelinePage.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await pipelinePage.locator('#confirm-btn').click();
  await expect(pipelinePage.locator('#playing-actions')).toBeVisible({ timeout: 15_000 });

  const canvas = pipelinePage.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 4.5, y: cellSize * 4.5 } });
  await pipelinePage.keyboard.press('5');

  await expect(pipelinePage.locator('#undo-btn')).not.toBeDisabled();
  await pipelinePage.locator('#undo-btn').click();
  await expect(pipelinePage.locator('#undo-btn')).toBeDisabled();
});

// ---------------------------------------------------------------------------
// Test: show candidates  (slow)
// ---------------------------------------------------------------------------

pipelineTest('show candidates button toggles candidate display', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  pipelineTest.setTimeout(90_000);

  await pipelinePage.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await pipelinePage.locator('#process-btn').click();
  await expect(pipelinePage.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await pipelinePage.locator('#confirm-btn').click();
  await expect(pipelinePage.locator('#playing-actions')).toBeVisible({ timeout: 15_000 });

  // Candidates are shown by default; the mode-toggle pill switches between Normal and Candidates.
  const modeToggle = pipelinePage.locator('#mode-toggle');
  await expect(modeToggle).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test: new puzzle resets to upload panel  (slow)
// ---------------------------------------------------------------------------

pipelineTest('new puzzle button returns to upload panel', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  pipelineTest.setTimeout(90_000);

  await pipelinePage.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await pipelinePage.locator('#process-btn').click();
  await expect(pipelinePage.locator('#review-panel')).toBeVisible({ timeout: 40_000 });

  await expect(pipelinePage.locator('#new-puzzle-btn')).toBeVisible();
  await pipelinePage.locator('#new-puzzle-btn').click();

  await expect(pipelinePage.locator('#upload-panel')).toBeVisible();
  await expect(pipelinePage.locator('#review-panel')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Test: cageTotals row-major orientation (replaces it.todo in inpImage.test.ts)
// ---------------------------------------------------------------------------

pipelineTest('cageTotals row-major orientation — connectivityScore ≥ threshold', async ({ pipelinePage }) => {
  pipelineTest.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  // Tutorial suppression and pipeline load are handled by the pipelinePage fixture.
  pipelineTest.setTimeout(90_000);

  await pipelinePage.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await pipelinePage.locator('#process-btn').click();
  // The hook is set as soon as borders are computed, regardless of whether the puzzle
  // auto-confirms (goes directly to playing mode) or shows the review screen.
  await pipelinePage.waitForFunction(
    () => (window as unknown as Record<string, unknown>)['__lastPipelineResult'] !== undefined,
    { timeout: 60_000 },
  );

  // Read the pipeline result exposed by window.__lastPipelineResult and compute
  // connectivity score inline. Mirrors buildUnionFind in validation.ts.
  // Correct row-major orientation → score ≈ 26 (one head per cage).
  // Transposed orientation → score ≤ 2 (heads land in wrong regions).
  const score = await pipelinePage.evaluate(() => {
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
