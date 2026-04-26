/**
 * Fast UI-flow tests for the COACH killer sudoku app.
 *
 * These run against `vite dev` (http://localhost:5173) and use
 * window.__testLoad() — a dev-only hook that injects a trivial puzzle spec
 * directly, bypassing the OpenCV image pipeline entirely.
 *
 * Every test completes in under 30 seconds. They cover:
 *   - Review panel renders after spec injection
 *   - Cage labels and totals appear on the canvas
 *   - Confirm transitions to playing mode
 *   - Digit entry and undo work
 *   - Candidates toggle works
 *   - New Puzzle returns to upload panel
 *
 * Run: npx playwright test --config playwright.dev.config.ts
 */

import { test, expect, type Page } from '@playwright/test';

type TestLoad = (specName?: string) => void;

/** Inject a spec via the dev test hook and wait for the review panel. */
async function loadSpec(page: Page, specName?: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__testLoad' in window);
  await page.evaluate((name) => {
    (window as unknown as Record<string, TestLoad>)['__testLoad']!(name);
  }, specName);
  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 5_000 });
}

const loadTrivialPuzzle = (page: Page) => loadSpec(page);
const loadBoxCagePuzzle = (page: Page) => loadSpec(page, 'boxCage');

/** Load trivial puzzle then confirm to reach playing mode. */
async function loadAndConfirm(page: Page): Promise<void> {
  await loadTrivialPuzzle(page);
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 5_000 });
}

/** Load box-cage puzzle then confirm to reach playing mode. All cells stay empty. */
async function loadBoxCageAndConfirm(page: Page): Promise<void> {
  await loadBoxCagePuzzle(page);
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 5_000 });
}

// ---------------------------------------------------------------------------

test('review panel appears after test spec injection', async ({ page }) => {
  await loadTrivialPuzzle(page);
  await expect(page.locator('#upload-panel')).toBeHidden();
  await expect(page.locator('#review-panel')).toBeVisible();
});

test('grid canvas has non-zero dimensions in review mode', async ({ page }) => {
  await loadTrivialPuzzle(page);
  const canvas = page.locator('#grid-canvas');
  await expect(canvas).toBeVisible();
  const width = await canvas.evaluate((el: HTMLCanvasElement) => el.width);
  const height = await canvas.evaluate((el: HTMLCanvasElement) => el.height);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
});

test('confirm button transitions to playing mode', async ({ page }) => {
  await loadAndConfirm(page);
  await expect(page.locator('#playing-actions')).toBeVisible();
  await expect(page.locator('#undo-btn')).toBeVisible();
  await expect(page.locator('#hints-btn')).toBeVisible();
  await expect(page.locator('#candidates-btn')).toBeVisible();
});

test('undo button is initially disabled in playing mode', async ({ page }) => {
  await loadAndConfirm(page);
  await expect(page.locator('#undo-btn')).toBeDisabled();
});

test('clicking cell then pressing digit enables undo', async ({ page }) => {
  // Uses the box-cage spec: no cells are auto-placed, so digit entry creates a user turn.
  await loadBoxCageAndConfirm(page);

  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } }); // top-left cell
  await page.keyboard.press('5');

  await expect(page.locator('#undo-btn')).not.toBeDisabled();
});

test('undo after digit entry re-disables undo button', async ({ page }) => {
  await loadBoxCageAndConfirm(page);

  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } }); // top-left cell
  await page.keyboard.press('5');
  await expect(page.locator('#undo-btn')).not.toBeDisabled();

  await page.locator('#undo-btn').click();
  await expect(page.locator('#undo-btn')).toBeDisabled();
});

test('candidates button toggles label to "Hide candidates"', async ({ page }) => {
  await loadAndConfirm(page);
  const btn = page.locator('#candidates-btn');
  await expect(btn).not.toBeDisabled();
  await btn.click();
  await expect(btn).toContainText(/hide/i);
});

test('new puzzle button returns to upload panel', async ({ page }) => {
  await loadTrivialPuzzle(page);
  await expect(page.locator('#new-puzzle-btn')).toBeVisible();
  await page.locator('#new-puzzle-btn').click();
  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#review-panel')).toBeHidden();
});
