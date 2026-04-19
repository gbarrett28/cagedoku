/**
 * End-to-end tests for the COACH killer sudoku app.
 *
 * Tests run against the Vite dev server (http://localhost:5173).
 * A real Guardian puzzle image is used for the upload flow.
 *
 * Timeout strategy:
 *   - Structural tests (title, panel visibility): global 10 s default.
 *   - Pipeline-dependent tests (opencv load, upload, playing): 90 s override
 *     because opencv.js (~10 MB) typically takes 20–35 s to load.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUZZLE_IMAGE = path.resolve(
  __dirname,
  '../../../guardian/killer_sudoku_0.jpg',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stub opencv.js with an empty script so it "loads" without starting WASM
 * compilation.  Without this, DOMContentLoaded triggers loadCV() which kicks
 * off a 10 MB download + WASM init that blocks browserContext.close() for 10+
 * seconds.  Structural tests do not exercise the image pipeline at all.
 */
async function stubOpenCV(page: Page) {
  await page.route('**/opencv.js', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: '// opencv.js stubbed for structural tests',
  }));
}

/** Wait for the image pipeline (opencv + model) to finish loading. */
async function waitForPipelineReady(page: Page, timeoutMs = 75_000) {
  // Wait until window.cv is initialised (opencv.js fully loaded) or an error fires.
  // Returns the status text: 'ok' on success, or an error string to surface.
  const result = await page.waitForFunction(
    () => {
      const status = document.getElementById('status-msg')?.textContent ?? '';
      if (status.includes('failed') || status.includes('Error')) return `ERR:${status}`;
      // OpenCV sets window.cv.getBuildInformation once fully initialised.
      const w = window as unknown as { cv?: { getBuildInformation?: () => string } };
      return w.cv?.getBuildInformation ? 'ok' : null; // null → keep polling
    },
    { timeout: timeoutMs },
  );
  const msg = await result.jsonValue() as string;
  if (msg.startsWith('ERR:')) throw new Error(`Pipeline load error: ${msg.slice(4)}`);
}

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
  test.setTimeout(180_000); // opencv.js WASM init can take 60–90 s in headless Chrome

  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 150_000);

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
  test.setTimeout(180_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 150_000);

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
  test.setTimeout(180_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 150_000);

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
  test.setTimeout(180_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 150_000);

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
  test.setTimeout(180_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 150_000);

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
  test.setTimeout(180_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 150_000);

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
  test.setTimeout(180_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 150_000);

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
  test.setTimeout(180_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 150_000);

  await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
  await page.locator('#process-btn').click();
  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });

  await expect(page.locator('#new-puzzle-btn')).toBeVisible();
  await page.locator('#new-puzzle-btn').click();

  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#review-panel')).toBeHidden();
});
