/**
 * Fast UI-flow tests for the COACH sudoku app.
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
  // Suppress the first-visit tutorial modal before the page loads so it doesn't
  // block interaction with buttons during tests (dialog.showModal() is blocking).
  await page.addInitScript(() => localStorage.setItem('coach_tutorial_suppressed', 'true'));
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
  await expect(page.locator('#mode-toggle')).toBeVisible();
});

test('undo button is initially disabled in playing mode', async ({ page }) => {
  await loadAndConfirm(page);
  await expect(page.locator('#undo-btn')).toBeDisabled();
});

test('upload help disclosure starts collapsed and does not shift the primary upload buttons', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('coach_tutorial_suppressed', 'true'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const chooseBtn = page.locator('#choose-btn');
  const before = await chooseBtn.boundingBox();
  expect(before).not.toBeNull();

  await expect(page.locator('.upload-help-body')).toBeHidden();

  await page.locator('#upload-help summary').click();
  await expect(page.locator('.upload-help-body')).toBeVisible();
  await expect(page.getByRole('link', { name: 'The Guardian' })).toBeVisible();

  const after = await chooseBtn.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.y).toBeCloseTo(before!.y, 0);
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

test('mode-toggle pill visible and toggles active state', async ({ page }) => {
  // Use box-cage spec: no cells are auto-placed after confirm, so the puzzle
  // is not immediately solved and mode-toggle remains enabled.
  await loadBoxCageAndConfirm(page);
  const pill = page.locator('#mode-toggle');
  await expect(pill).toBeVisible();
  await expect(pill).not.toBeDisabled();
  // Initially Normal is active (no .active class on pill)
  await expect(pill).not.toHaveClass(/active/);
  await pill.click();
  // After click, Candidates is active
  await expect(pill).toHaveClass(/active/);
  await pill.click();
  // Toggle back
  await expect(pill).not.toHaveClass(/active/);
});

test('new puzzle button returns to upload panel', async ({ page }) => {
  await loadTrivialPuzzle(page);
  await expect(page.locator('#new-puzzle-btn')).toBeVisible();
  await page.locator('#new-puzzle-btn').click();
  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#review-panel')).toBeHidden();
});

test('new puzzle with pending SW update posts SKIP_WAITING to waiting worker', async ({ page }) => {
  await loadTrivialPuzzle(page);

  // Inject a fake waiting SW via the dev-only hook exposed by main.ts.
  await page.evaluate(() => {
    const messages: unknown[] = [];
    const fakeSW = {
      postMessage: (msg: unknown) => { messages.push(msg); },
    } as unknown as ServiceWorker;
    (window as unknown as Record<string, unknown>)['__swPostedMessages'] = messages;
    const hook = (window as unknown as Record<string, unknown>)['__setWaitingSW'] as
      ((sw: ServiceWorker) => void) | undefined;
    if (!hook) throw new Error('__setWaitingSW not found — dev hook missing in main.ts');
    hook(fakeSW);
  });

  await page.locator('#new-puzzle-btn').click();
  await expect(page.locator('#upload-panel')).toBeVisible();

  const posted = await page.evaluate(
    () => (window as unknown as Record<string, unknown>)['__swPostedMessages'] as unknown[],
  );
  expect(posted).toContainEqual({ type: 'SKIP_WAITING' });
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

/**
 * Load the partial classic spec (rows 0–2 blank) then confirm.
 * No cells are auto-placed because naked-single stalls with ≥3 candidates
 * per blank cell, so the puzzle is not immediately solved and action buttons
 * remain enabled.
 */
async function loadClassicPartialAndConfirm(page: Page): Promise<void> {
  await loadSpec(page, 'classicPartial');
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

test('big apple: manual dropdown switch synthesizes state and confirms to playing mode', async ({ page }) => {
  await loadClassicPuzzle(page);
  await page.locator('#puzzle-type-select').selectOption('bigapple');
  await expect(page.locator('#puzzle-type-select')).toHaveValue('bigapple');
  await expect(page.locator('#review-panel')).toHaveAttribute('data-puzzle-type', 'bigapple');
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 5_000 });
  // Killer-only controls stay hidden for Big Apple, same as Classic.
  await expect(page.locator('#inspect-cage-btn')).toBeHidden();
  await expect(page.locator('#virtual-cage-btn')).toBeHidden();
});

test('big apple: misread given is detected once corrected during review', async ({ page }) => {
  await loadSpec(page, 'bigAppleMisread');
  // Detection ran once on the OCR-misread digits and concluded false: banner hidden, dropdown defaults to classic.
  await expect(page.locator('#bigapple-banner')).toBeHidden();
  await expect(page.locator('#puzzle-type-select')).toHaveValue('classic');

  // Correct the misread given at (row2, col5) — 0-based [1][4] — from 7 back to 6.
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 4.5, y: cellSize * 1.5 } });
  await page.locator('#digit-6').click();

  // Re-running detection on the corrected grid should now flag Big Apple.
  await expect(page.locator('#bigapple-banner')).toBeVisible();
  await expect(page.locator('#puzzle-type-select')).toHaveValue('bigapple');
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

test('classic puzzle: confirm with duplicate digit stays on review with error', async ({ page }) => {
  await loadClassicPuzzle(page);
  // Cell (0,0) is blank. Row 0 already contains 3 — entering 3 creates a row duplicate.
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } }); // cell (0,0)
  await page.locator('#digit-3').click(); // creates a duplicate 3 in row 0
  // Duplicates disable the confirm button — cannot transition to playing mode.
  await expect(page.locator('#confirm-btn')).toBeDisabled();
  // Must remain on the review screen
  await expect(page.locator('#review-actions')).toBeVisible();
  await expect(page.locator('#action-group')).toBeHidden();
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

test('killer playing: opening cage inspector does not collapse the playing-mode layout', async ({ page }) => {
  // Regression test for issue #171: renderCageInspector() used to set
  // playing-actions.hidden = true directly, which breaks body:has(#playing-actions:not([hidden]))
  // -- the selector driving the entire playing-mode flex/grid layout chain -- collapsing
  // #canvas-col from its full-viewport size down to a cramped default-flow size.
  await loadBoxCageAndConfirm(page);
  const canvasCol = page.locator('#canvas-col');
  const before = await canvasCol.boundingBox();
  expect(before).not.toBeNull();

  await page.locator('#inspect-cage-btn').click();
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cellSize = box!.width / 9;
  await canvas.click({ position: { x: cellSize * 0.5, y: cellSize * 0.5 } });
  await expect(page.locator('#cage-inspector')).not.toBeEmpty();

  const after = await canvasCol.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.width).toBeCloseTo(before!.width, 0);
  expect(after!.height).toBeCloseTo(before!.height, 0);
  // Visually hidden via the CSS class, not the hidden attribute.
  await expect(page.locator('#playing-actions')).toHaveJSProperty('hidden', false);
  await expect(page.locator('#playing-actions')).not.toBeVisible();
});

test('mode-toggle pill visible in killer playing mode', async ({ page }) => {
  await loadBoxCageAndConfirm(page);
  await expect(page.locator('#mode-toggle')).toBeVisible();
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
// Hard puzzles panel toggle
// ---------------------------------------------------------------------------

/** Navigate to the home screen without loading a spec. */
async function goHome(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('coach_tutorial_suppressed', 'true'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#upload-panel')).toBeVisible({ timeout: 5_000 });
}

test('hard-puzzles-btn toggles fixture panel and hides upload panel', async ({ page }) => {
  await goHome(page);
  await expect(page.locator('#fixture-panel')).toBeHidden();

  // First click — show fixture panel
  await page.locator('#hard-puzzles-btn').click();
  await expect(page.locator('#fixture-panel')).toBeVisible();
  await expect(page.locator('#upload-panel')).toBeHidden();

  // Second click — return to upload panel
  await page.locator('#hard-puzzles-btn').click();
  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#fixture-panel')).toBeHidden();
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

test('config modal consent checkbox grants and revokes training_consent cookie immediately', async ({ page }) => {
  await loadAndConfirm(page);
  await page.locator('#config-btn').click();
  await expect(page.locator('#config-modal')).toBeVisible();

  const checkbox = page.locator('#consent-toggle');
  await expect(checkbox).not.toBeChecked();

  await checkbox.check();
  let cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'training_consent')?.value).toBe('granted');

  await checkbox.uncheck();
  cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'training_consent')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Hints list modal
// ---------------------------------------------------------------------------


test('hints button opens hints-list-modal dialog after confirm', async ({ page }) => {
  await loadAndConfirm(page);
  // Dialog is initially closed — no 'open' attribute
  await expect(page.locator('#hints-list-modal')).not.toHaveAttribute('open');
  await page.locator('#hints-btn').click();
  // showModal() adds the 'open' attribute
  await expect(page.locator('#hints-list-modal')).toHaveAttribute('open', '');
  // Close button dismisses the dialog
  await page.locator('#hints-list-close-btn').click();
  await expect(page.locator('#hints-list-modal')).not.toHaveAttribute('open');
});

// ---------------------------------------------------------------------------
// Classic playing mode — button audit
// ---------------------------------------------------------------------------

test('classic playing: hints and mode-toggle enabled after confirm', async ({ page }) => {
  // Use the partial fixture (rows 0–2 blank) so the puzzle is not immediately
  // auto-solved; buttons remain enabled until the user solves it.
  await loadClassicPartialAndConfirm(page);
  // These are valid for Classic — candidates use row/col/box rules, hints work without cages.
  await expect(page.locator('#hints-btn')).not.toBeDisabled();
  await expect(page.locator('#mode-toggle')).not.toBeDisabled();
});

test('classic playing: undo is disabled (all cells are given digits)', async ({ page }) => {
  // makeClassicGivenDigits blanks only one cell; the test flow fills it before confirm,
  // so every cell is a given digit — undo must not undo given placements.
  await loadClassicAndConfirm(page);
  await expect(page.locator('#undo-btn')).toBeDisabled();
});

test('classic playing: type dropdown absent (it lives in review-actions which is hidden)', async ({ page }) => {
  await loadClassicAndConfirm(page);
  await expect(page.locator('#review-actions')).toBeHidden();
  // Type dropdown is inside review-actions, so it is implicitly hidden.
  await expect(page.locator('#puzzle-type-select')).toBeHidden();
});

// ---------------------------------------------------------------------------
// Mobile layout — 375 × 667 viewport
// ---------------------------------------------------------------------------

/** Run a test at iPhone-SE width to exercise the responsive layout. */
async function atMobileViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 667 });
}

/** Return true if any content is wider than the viewport (horizontal overflow). */
async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

test('mobile: killer review — no horizontal overflow', async ({ page }) => {
  await atMobileViewport(page);
  await loadTrivialPuzzle(page);
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test('mobile: killer playing — action buttons visible at 375 px', async ({ page }) => {
  await atMobileViewport(page);
  await loadBoxCageAndConfirm(page);
  await expect(page.locator('#undo-btn')).toBeVisible();
  await expect(page.locator('#hints-btn')).toBeVisible();
  await expect(page.locator('#mode-toggle')).toBeVisible();
});

test('mobile: killer playing — digit pad visible at 375 px', async ({ page }) => {
  await atMobileViewport(page);
  await loadBoxCageAndConfirm(page);
  // All digit buttons should be on-screen
  for (const d of [1, 5, 9]) {
    await expect(page.locator(`#digit-${d}`)).toBeVisible();
  }
});

test('mobile: killer playing — no horizontal overflow', async ({ page }) => {
  await atMobileViewport(page);
  await loadBoxCageAndConfirm(page);
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test('mobile: classic review — digit pad visible and no overflow', async ({ page }) => {
  await atMobileViewport(page);
  await loadClassicPuzzle(page);
  await expect(page.locator('#digit-5')).toBeVisible();
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test('mobile: classic review — digit pad visible when warped image present (bug 112)', async ({ page }) => {
  // Reproduce bug 112: at 411×748 with a real warped image, warped-col's
  // aspect-ratio image claimed ~426px, leaving canvas-col only 112px and the
  // digit pad invisible. Simulate by showing #warped-col with a 1×1 SVG.
  await page.setViewportSize({ width: 411, height: 748 });
  await loadClassicPuzzle(page);
  await page.evaluate(() => {
    const col = document.getElementById('warped-col')!;
    const img = document.getElementById('warped-img') as HTMLImageElement;
    img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="%23ccc"/></svg>';
    col.hidden = false;
  });
  // All digit buttons must be visible — not buried under the warped image
  for (const d of [1, 5, 9]) {
    await expect(page.locator(`#digit-${d}`)).toBeVisible();
  }
  // Grid canvas must be usably large (broken state was 120px; fix brings it to ~193px).
  const canvasWidth = await page.locator('#grid-canvas').evaluate(el => el.getBoundingClientRect().width);
  expect(canvasWidth).toBeGreaterThanOrEqual(180);
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test('mobile: classic playing — key buttons visible; killer-only buttons absent', async ({ page }) => {
  await atMobileViewport(page);
  await loadClassicAndConfirm(page);
  await expect(page.locator('#hints-btn')).toBeVisible();
  await expect(page.locator('#mode-toggle')).toBeVisible();
  await expect(page.locator('#inspect-cage-btn')).toBeHidden();
  await expect(page.locator('#virtual-cage-btn')).toBeHidden();
});

test('mobile: classic playing — no horizontal overflow', async ({ page }) => {
  await atMobileViewport(page);
  await loadClassicAndConfirm(page);
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test('mobile: header buttons visible at 375 px', async ({ page }) => {
  await atMobileViewport(page);
  await loadBoxCageAndConfirm(page);
  await expect(page.locator('#help-btn')).toBeVisible();
  await expect(page.locator('#config-btn')).toBeVisible();
  await expect(page.locator('#new-puzzle-btn')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Landscape layout — desktop widths
// ---------------------------------------------------------------------------

test('landscape: classic review — grid canvas visible with warped+original images present (bug 164)', async ({ page }) => {
  // Reproduce bug 164: at 1440×731 landscape with both the warped-grid and
  // original-photo columns visible (the real-upload state), #detected-layout-heading
  // and #canvas-wrapper are flex row-siblings inside #canvas-col under the
  // landscape playing-mode CSS. The heading's auto flex-basis plus the fixed-width
  // side-panel left #canvas-wrapper (flex-grow:1, basis:0) almost no room, collapsing
  // the grid canvas to 0×0 while the heading label remained visible above it.
  await page.setViewportSize({ width: 1440, height: 731 });
  await loadClassicPuzzle(page);
  await page.evaluate(() => {
    const placeholder = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="%23ccc"/></svg>';
    const warpedCol = document.getElementById('warped-col')!;
    (document.getElementById('warped-img') as HTMLImageElement).src = placeholder;
    warpedCol.hidden = false;
    const originalCol = document.getElementById('original-col')!;
    (document.getElementById('original-img') as HTMLImageElement).src = placeholder;
    originalCol.hidden = false;
  });
  // Grid canvas must be usably large (broken state was 0px).
  const canvasRect = await page.locator('#grid-canvas').evaluate(el => el.getBoundingClientRect());
  expect(canvasRect.width).toBeGreaterThanOrEqual(150);
  expect(canvasRect.height).toBeGreaterThanOrEqual(150);
});

// ---------------------------------------------------------------------------
// Training consent modal
// ---------------------------------------------------------------------------

test('classic confirm triggers training-consent modal when OCR thumbnails are pending', async ({ page }) => {
  // This test covers the manual-confirm path for Classic puzzles.  The classic
  // auto-confirm path (all 81 given digits detected) is not exercisable via
  // __testLoad because loadClassicDirect always returns warning != null, which
  // bypasses auto-confirm; a dedicated image-pipeline test with a fully-filled
  // puzzle image would be needed for that branch.
  //
  // Key: "0,1" → row 0, col 1; KNOWN_SOLUTION[0][1] = 3 (single digit).
  // One thumbnail entry per digit so extractTrainingData produces sampleCount=1.
  const fakePixels = Array<number>(4096).fill(128);

  await page.addInitScript(() => localStorage.setItem('coach_tutorial_suppressed', 'true'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__testLoad' in window && '__testSetPendingThumbs' in window);

  // Inject fake thumbnails BEFORE __testLoad so they survive into the confirm step.
  // (__testLoad('classic') does not reset pendingCellThumbs.)
  await page.evaluate((pixels) => {
    type SetThumbs = (e: Record<string, number[][]>) => void;
    (window as unknown as Record<string, SetThumbs>)['__testSetPendingThumbs']!({ '0,1': [pixels] });
    (window as unknown as Record<string, (s?: string) => void>)['__testLoad']!('classic');
  }, fakePixels);

  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 5_000 });

  // Confirm without a consent cookie — the training modal must appear.
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#training-consent-modal')).toBeVisible({ timeout: 3_000 });

  // Clean up.
  await page.locator('#training-consent-skip-btn').click();
  await expect(page.locator('#training-consent-modal')).toBeHidden();
});

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

test('logo-k resets tutorial — re-shows help modal when tutorial was suppressed', async ({ page }) => {
  await loadAndConfirm(page); // tutorial suppressed via addInitScript in loadSpec
  await expect(page.locator('#general-help-modal')).toBeHidden();

  await page.locator('#logo-k').click();
  await expect(page.locator('#general-help-modal')).toBeVisible({ timeout: 2_000 });
});

test('logo-k reset — callouts restart after modal is dismissed', async ({ page }) => {
  await loadAndConfirm(page);
  await page.locator('#logo-k').click();
  await expect(page.locator('#general-help-modal')).toBeVisible({ timeout: 2_000 });
  await page.locator('#general-help-close-btn').click();
  await expect(page.locator('#callout')).toBeVisible({ timeout: 2_000 });
});

test('tutorial callouts do not re-trigger when cage inspector eliminates a solution', async ({ page }) => {
  // Tutorial NOT suppressed — we want the full callout system active.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__testLoad' in window);
  await page.evaluate(() => (window as unknown as Record<string, (s?: string) => void>)['__testLoad']!('boxCage'));
  await expect(page.locator('#review-panel')).toBeVisible({ timeout: 5_000 });

  // Close tutorial modal to start the callout sequence.
  await page.locator('#general-help-close-btn').click();

  // Drain all upload-screen and review-screen callouts before confirming.
  while (await page.locator('#callout').isVisible()) {
    await page.locator('#callout-got-it').click();
  }

  // Confirm to enter playing mode (queues the playing-mode callouts).
  await page.locator('#confirm-btn').click();
  await expect(page.locator('#playing-actions')).toBeVisible({ timeout: 5_000 });

  // Drain every playing-mode callout.
  while (await page.locator('#callout').isVisible()) {
    await page.locator('#callout-got-it').click();
  }
  await expect(page.locator('#callout')).toBeHidden();

  // Open cage inspector and click a cell to reveal its cage solutions.
  await page.locator('#inspect-cage-btn').click();
  const canvas = page.locator('#grid-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const CELL = box!.width / 9;
  await canvas.click({ position: { x: CELL * 0.5, y: CELL * 0.5 } });

  // Click the first active solution span to trigger eliminateCageSolution.
  const activeSolution = page.locator('#cage-inspector .soln-item.active').first();
  await expect(activeSolution).toBeVisible({ timeout: 2_000 });
  await activeSolution.click();

  // The callout must stay hidden — eliminating a solution must not re-queue callouts.
  await page.waitForTimeout(300);
  await expect(page.locator('#callout')).toBeHidden();
});
