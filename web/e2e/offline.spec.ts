/**
 * Offline / service-worker tests for the COACH killer sudoku app.
 *
 * These tests run against `vite preview` (http://localhost:4173), the same
 * production build used by app.spec.ts. The service worker is active in
 * production builds; it is skipped during `npm run dev` (import.meta.env.DEV).
 *
 * Test strategy:
 *   Fast tests  — SW registration, offline page load (no pipeline, < 30 s).
 *   Slow tests  — offline image upload + process; gated on PLAYWRIGHT_PIPELINE_TESTS=1
 *                 because OpenCV WASM init takes 150–180 s in headless Chromium.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { stubOpenCV, waitForPipelineReady, waitForSwController } from './helpers.js';

const PIPELINE = process.env['PLAYWRIGHT_PIPELINE_TESTS'] === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUZZLE_IMAGE =
  process.env['PUZZLE_IMAGE'] ??
  path.resolve(__dirname, '../../guardian/killer_sudoku_0.jpg');

// ---------------------------------------------------------------------------
// Test: SW registers in the production build  (fast)
// ---------------------------------------------------------------------------

test('service worker is registered and controls the page', async ({ page }) => {
  test.setTimeout(20_000);
  await stubOpenCV(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // waitForSwController polls until navigator.serviceWorker.controller is non-null.
  await waitForSwController(page);

  const controlled = await page.evaluate(() => navigator.serviceWorker?.controller !== null);
  expect(controlled).toBe(true);
});

// ---------------------------------------------------------------------------
// Test: page loads from SW cache when network is offline  (fast)
// ---------------------------------------------------------------------------

test('page loads from cache when offline', async ({ page, context }) => {
  test.setTimeout(30_000);
  await stubOpenCV(page);

  // First visit: SW installs, caches assets, and claims the page.
  await page.goto('/', { waitUntil: 'networkidle' });
  await waitForSwController(page);

  // Simulate going offline — all network requests will now fail.
  await context.setOffline(true);

  // Reload should be served entirely from the SW cache.
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page).toHaveTitle(/COACH/);
  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#review-panel')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Test: image pipeline loads from cache when offline  (slow)
// ---------------------------------------------------------------------------

test('image pipeline loads from SW cache when offline', async ({ page, context }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1 — OpenCV WASM blocks headless Chromium for 6+ min without the minimal build');
  test.setTimeout(720_000); // two pipeline inits (online + offline reload)

  // Online visit: let the SW cache opencv.js, model files, and JS bundle.
  await page.goto('/', { waitUntil: 'networkidle' });
  await waitForSwController(page);
  await waitForPipelineReady(page, 330_000);

  // Go offline and reload — everything must come from the SW cache.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });

  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  await waitForPipelineReady(page, 330_000);

  const pipelineErrors = errors.filter(e =>
    (e.includes('opencv') || e.includes('recogniser') || e.includes('RangeError')) &&
    !e.includes('chrome-extension'),
  );
  expect(pipelineErrors, `Pipeline errors offline:\n${pipelineErrors.join('\n')}`).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: upload and process an image while offline  (slow)
// ---------------------------------------------------------------------------

test('upload puzzle image and process it while offline', async ({ page, context }) => {
  test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
  test.setTimeout(720_000);

  // Online: prime the SW cache.
  await page.goto('/', { waitUntil: 'networkidle' });
  await waitForSwController(page);
  await waitForPipelineReady(page, 330_000);

  // Go offline before the actual test interaction.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 330_000);

  // Upload and process — all computation is local (WebAssembly + JS).
  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();

  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('#upload-panel')).toBeHidden();

  const canvas = page.locator('#grid-canvas');
  await expect(canvas).toBeVisible();
  const width = await canvas.evaluate((el: HTMLCanvasElement) => el.width);
  expect(width).toBeGreaterThan(0);
});
