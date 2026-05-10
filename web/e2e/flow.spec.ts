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

// ---------------------------------------------------------------------------
// Classic puzzle flow
// ---------------------------------------------------------------------------

/** Inject the 'classic' spec (partial given-digits grid) and wait for review. */
async function loadClassicPuzzle(page: Page): Promise<void> {
  await loadSpec(page, 'classic');
}

/** Load Classic puzzle then confirm to reach playing mode. */
async function loadClassicAndConfirm(page: Page): Promise<void> {
  await loadClassicPuzzle(page);
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 5_000 });
}

test('classic puzzle: review panel shows Classic heading and type dropdown', async ({ page }) => {
  await loadClassicPuzzle(page);
  // Heading changes to "Classic Sudoku" for classic puzzles
  await expect(page.locator('#detected-layout-heading')).toContainText(/classic/i);
  // Type dropdown reflects the detected type
  const dropdownValue = await page.locator('#puzzle-type-select').inputValue();
  expect(dropdownValue).toBe('classic');
});

test('classic puzzle: digit pad visible during review (action buttons hidden)', async ({ page }) => {
  await loadClassicPuzzle(page);
  // The digit pad is inside #playing-actions which is shown for Classic review
  await expect(page.locator('#playing-actions')).toBeVisible();
  // The action-group (undo, hints, candidates) is hidden during review
  await expect(page.locator('#action-group')).toBeHidden();
  // Individual digit buttons are reachable
  await expect(page.locator('#digit-5')).toBeVisible();
});

test('classic puzzle: classic-edit-hint is visible during review', async ({ page }) => {
  await loadClassicPuzzle(page);
  await expect(page.locator('#classic-edit-hint')).toBeVisible();
});

test('classic puzzle: digit button click during review corrects blank cell', async ({ page }) => {
  await loadClassicPuzzle(page);
  // The fixture has cell (row=0, col=0) blanked — click it then press a digit button.
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } }); // top-left cell
  await page.locator('#digit-5').click();
  // After clicking a digit button the cell should now hold that digit;
  // no error (the undo button is irrelevant here — undo is in action-group which is hidden).
  // Verify by confirming: the solver should run and accept the digit.
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('#action-group')).toBeVisible();
});

test('classic puzzle: keyboard digit entry during review is accepted', async ({ page }) => {
  await loadClassicPuzzle(page);
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } }); // top-left cell
  await page.keyboard.press('5');
  // Confirm should succeed (digit fills the blank, puzzle is solvable)
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 5_000 });
});

test('classic puzzle: confirm transitions to playing mode', async ({ page }) => {
  await loadClassicAndConfirm(page);
  await expect(page.locator('#review-actions')).toBeHidden();
  await expect(page.locator('#action-group')).toBeVisible();
});

test('classic puzzle: inspect-cage and virtual-cage buttons hidden in Classic playing mode', async ({ page }) => {
  await loadClassicAndConfirm(page);
  await expect(page.locator('#inspect-cage-btn')).toBeHidden();
  await expect(page.locator('#virtual-cage-btn')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Killer playing screen — button visibility
// ---------------------------------------------------------------------------

test('killer playing: inspect-cage and virtual-cage buttons visible from start', async ({ page }) => {
  // These are Killer-only controls visible as soon as playing mode begins.
  await loadBoxCageAndConfirm(page);
  await expect(page.locator('#inspect-cage-btn')).toBeVisible();
  await expect(page.locator('#virtual-cage-btn')).toBeVisible();
});

test('candidates button shows edit-candidates and help-candidates buttons', async ({ page }) => {
  await loadBoxCageAndConfirm(page);
  // Before toggling candidates these extra buttons are hidden
  await expect(page.locator('#edit-candidates-btn')).toBeHidden();
  await expect(page.locator('#help-candidates-btn')).toBeHidden();
  await page.locator('#candidates-btn').click();
  await expect(page.locator('#edit-candidates-btn')).toBeVisible();
  await expect(page.locator('#help-candidates-btn')).toBeVisible();
});

test('hiding candidates re-hides edit-candidates and help-candidates buttons', async ({ page }) => {
  await loadBoxCageAndConfirm(page);
  await page.locator('#candidates-btn').click(); // show
  await expect(page.locator('#edit-candidates-btn')).toBeVisible();
  await page.locator('#candidates-btn').click(); // hide
  await expect(page.locator('#edit-candidates-btn')).toBeHidden();
  await expect(page.locator('#help-candidates-btn')).toBeHidden();
});

test('reveal button hidden initially; visible after cell selected', async ({ page }) => {
  await loadBoxCageAndConfirm(page);
  await expect(page.locator('#reveal-btn')).toBeHidden();
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } });
  await expect(page.locator('#reveal-btn')).toBeVisible();
});

test('digit button click places digit and enables undo', async ({ page }) => {
  // Uses box-cage so no cells are auto-placed and digit entry creates a user turn.
  await loadBoxCageAndConfirm(page);
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } });
  await page.locator('#digit-5').click();
  await expect(page.locator('#undo-btn')).not.toBeDisabled();
});

test('digit-0 button clears a placed digit', async ({ page }) => {
  await loadBoxCageAndConfirm(page);
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } });
  await page.locator('#digit-5').click();
  await expect(page.locator('#undo-btn')).not.toBeDisabled();
  await page.locator('#digit-0').click(); // clear
  // Undo stack now has two turns (place then clear), so undo is still enabled
  await expect(page.locator('#undo-btn')).not.toBeDisabled();
});

// ---------------------------------------------------------------------------
// Header modals
// ---------------------------------------------------------------------------

test('help button opens general-help-modal', async ({ page }) => {
  await loadAndConfirm(page);
  await page.locator('#help-btn').click();
  await expect(page.locator('#general-help-modal')).toBeVisible();
  await page.locator('#general-help-close-btn').click();
  await expect(page.locator('#general-help-modal')).toBeHidden();
});

test('config button opens config-modal', async ({ page }) => {
  await loadAndConfirm(page);
  await page.locator('#config-btn').click();
  await expect(page.locator('#config-modal')).toBeVisible();
  await page.locator('#config-cancel-btn').click();
  await expect(page.locator('#config-modal')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Hints dropdown
// ---------------------------------------------------------------------------

test('hints button opens dropdown after confirm', async ({ page }) => {
  await loadAndConfirm(page);
  await expect(page.locator('#hints-dropdown')).toBeHidden();
  await page.locator('#hints-btn').click();
  await expect(page.locator('#hints-dropdown')).toBeVisible();
  // Toggle off
  await page.locator('#hints-btn').click();
  await expect(page.locator('#hints-dropdown')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Training consent modal
// ---------------------------------------------------------------------------

async function openConsentModal(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__testShowConsentModal' in window);
  await page.evaluate(() => {
    (window as unknown as Record<string, () => void>)['__testShowConsentModal']!();
  });
  await expect(page.locator('#training-consent-modal')).toBeVisible({ timeout: 3_000 });
}

test('consent modal appears and closes on Skip without setting cookie', async ({ page }) => {
  await openConsentModal(page);
  await page.locator('#training-consent-skip-btn').click();
  await expect(page.locator('#training-consent-modal')).toBeHidden();
  const cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'training_consent')).toBeUndefined();
});

test('consent modal Always send sets training_consent=granted cookie', async ({ page }) => {
  await openConsentModal(page);
  await page.locator('#training-consent-always-btn').click();
  await expect(page.locator('#training-consent-modal')).toBeHidden();
  const cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'training_consent')?.value).toBe('granted');
});

test('consent modal Send this time closes modal without setting cookie', async ({ page }) => {
  await openConsentModal(page);
  await page.locator('#training-consent-once-btn').click();
  await expect(page.locator('#training-consent-modal')).toBeHidden();
  const cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'training_consent')).toBeUndefined();
});
