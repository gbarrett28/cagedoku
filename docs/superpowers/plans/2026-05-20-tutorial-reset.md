# Tutorial Reset via K Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user restart the tutorial by clicking the K badge (`#logo-k`), and add a callout to the playing-screen sequence explaining this.

**Architecture:** Extract the `playingCallouts` array into a `buildPlayingCallouts(isKiller)` helper (DRY — used by both `renderPlayingMode` and the reset handler). The `#logo-k` click handler clears the suppression key, calls `initTutorial()`, and pre-fills the queue before the user dismisses the re-shown modal. No new `tutorial.ts` exports needed.

**Tech Stack:** TypeScript, Playwright (Chromium), Vitest.

---

## File Map

| File | Change |
|---|---|
| `web/src/main.ts` | Extract `buildPlayingCallouts`; add `logo-k` callout step; add `#logo-k` click handler |
| `web/e2e/flow.spec.ts` | Add 2 Playwright tests for the reset behaviour |

---

## Task 0: Feature branch

- [ ] **Create branch**

```
git checkout -b feature/tutorial-reset-84
```

---

## Task 1: Failing Playwright tests

**Files:**
- Modify: `web/e2e/flow.spec.ts`

- [ ] **Step 1: Add two tests at the end of `flow.spec.ts`**

  Append after the last `test(...)` block:

  ```ts
  test('logo-k resets tutorial — re-shows help modal when tutorial was suppressed', async ({ page }) => {
    await loadAndConfirm(page); // tutorial is suppressed via addInitScript in loadSpec
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
  ```

- [ ] **Step 2: Run dev Playwright to confirm the tests fail**

  ```
  cd web && npx playwright test --config playwright.dev.config.ts --grep "logo-k"
  ```

  Expected: 2 tests fail (clicking `#logo-k` currently does nothing).

---

## Task 2: Extract `buildPlayingCallouts` + add `logo-k` step

**Files:**
- Modify: `web/src/main.ts`

- [ ] **Step 1: Add `buildPlayingCallouts` before `renderPlayingMode`**

  Find the line `function renderPlayingMode(state: PuzzleState): void {` and insert this function immediately before it:

  ```ts
  function buildPlayingCallouts(isKiller: boolean): { id: string; text: string }[] {
    const callouts: { id: string; text: string }[] = [
      { id: 'undo-btn',       text: 'Undo your last move.' },
      { id: 'hints-btn',      text: 'Request a logical hint to guide your next step.' },
      { id: 'mode-toggle',    text: 'Switch between Normal mode (place digits) and Candidate mode (edit pencil marks). The digit buttons work the same way in both modes.' },
      { id: 'reveal-btn',     text: 'Reveal the correct digit for the selected cell.' },
      { id: 'digit-1',        text: 'Use these buttons to enter digits. In Candidate mode, they toggle pencil marks instead. On a keyboard, Ctrl+digit works in the opposite mode.' },
      { id: 'help-btn',       text: 'Re-open this guide at any time.' },
      { id: 'feedback-btn',   text: 'Found a bug or have a suggestion? Tap the envelope to send feedback.' },
      { id: 'config-btn',     text: 'Configure which logical rules run automatically.' },
      { id: 'new-puzzle-btn', text: 'Start a fresh puzzle.' },
      { id: 'logo-k',         text: 'Tap the K badge at any time to restart this tutorial.' },
    ];
    if (isKiller) {
      callouts.splice(3, 0,
        { id: 'inspect-cage-btn', text: 'Show remaining valid digit combinations for a cage.' },
        { id: 'virtual-cage-btn', text: 'Add a virtual cage constraint derived from the current board state.' },
      );
    }
    return callouts;
  }
  ```

  Note: the inline type `{ id: string; text: string }` matches how callouts are typed throughout `main.ts` — no import change needed.

- [ ] **Step 2: Replace the inline `playingCallouts` in `renderPlayingMode` with a call to the helper**

  Inside `renderPlayingMode`, find and replace:

  ```ts
    const playingCallouts: { id: string; text: string }[] = [
      { id: 'undo-btn',      text: 'Undo your last move.' },
      { id: 'hints-btn',     text: 'Request a logical hint to guide your next step.' },
      { id: 'mode-toggle',   text: 'Switch between Normal mode (place digits) and Candidate mode (edit pencil marks). The digit buttons work the same way in both modes.' },
      { id: 'reveal-btn',    text: 'Reveal the correct digit for the selected cell.' },
      { id: 'digit-1',       text: 'Use these buttons to enter digits. In Candidate mode, they toggle pencil marks instead. On a keyboard, Ctrl+digit works in the opposite mode.' },
      { id: 'help-btn',      text: 'Re-open this guide at any time.' },
      { id: 'feedback-btn',  text: 'Found a bug or have a suggestion? Tap the envelope to send feedback.' },
      { id: 'config-btn',    text: 'Configure which logical rules run automatically.' },
      { id: 'new-puzzle-btn', text: 'Start a fresh puzzle.' },
    ];
    if (isKiller) {
      playingCallouts.splice(3, 0,
        { id: 'inspect-cage-btn', text: 'Show remaining valid digit combinations for a cage.' },
        { id: 'virtual-cage-btn', text: 'Add a virtual cage constraint derived from the current board state.' },
      );
    }
    appendCallouts(playingCallouts);
  ```

  With:

  ```ts
    appendCallouts(buildPlayingCallouts(isKiller));
  ```

- [ ] **Step 3: Type-check**

  ```
  cd web && tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 4: Run full unit tests to confirm nothing broke**

  ```
  cd web && npm test
  ```

  Expected: all tests pass (274+).

---

## Task 3: Add `#logo-k` click handler

**Files:**
- Modify: `web/src/main.ts`

- [ ] **Step 1: Add the click handler in the DOMContentLoaded event listener block**

  In `main.ts`, find the line:

  ```ts
  el<HTMLButtonElement>('process-btn').addEventListener('click', () => { void handleProcess(); });
  ```

  Insert the following immediately **before** it:

  ```ts
  el<HTMLDivElement>('logo-k').addEventListener('click', () => {
    const calloutEl = el<HTMLElement>('callout');
    const modalEl  = el<HTMLDialogElement>('general-help-modal');
    // No-op if a callout is showing or the modal is already open.
    if (!calloutEl.hidden || modalEl.open) return;

    localStorage.removeItem('coach_tutorial_suppressed');
    initTutorial(); // resets calloutQueue/calloutStarted/tutorialActive; shows modal

    // Pre-fill the queue for the current screen BEFORE the user dismisses the modal.
    // appendCallouts() skips advanceCallout() while calloutStarted === false, so the
    // sequence only starts when the modal closes and sets calloutStarted = true.
    const inPlaying = currentState !== null;
    const inReview  = !inPlaying && !el<HTMLElement>('review-panel').hidden;
    if (inPlaying) {
      appendCallouts(buildPlayingCallouts(currentState!.puzzleType !== 'classic'));
    } else if (inReview) {
      appendCallouts([{ id: 'confirm-btn', text: 'When the grid looks correct, confirm to start solving.' }]);
    } else {
      appendCallouts([{ id: 'process-btn', text: 'Tap here to analyse your photo and detect the grid and cages.' }]);
    }
  });
  ```

- [ ] **Step 2: Type-check**

  ```
  cd web && tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 3: Run dev Playwright tests for logo-k**

  ```
  cd web && npx playwright test --config playwright.dev.config.ts --grep "logo-k"
  ```

  Expected: 2 tests pass.

- [ ] **Step 4: Run full Playwright dev suite to confirm no regressions**

  ```
  cd web && npx playwright test --config playwright.dev.config.ts
  ```

  Expected: 37 passed → 39 passed (2 new tests).

---

## Task 4: Bronze gate + commit

- [ ] **Step 1: Full bronze gate**

  ```
  cd web && tsc --noEmit && tsc -p tsconfig.node.json --noEmit && npm test
  ```

  Expected: type check clean, all unit tests pass.

- [ ] **Step 2: Commit**

  ```
  git add web/src/main.ts web/e2e/flow.spec.ts
  git commit -m "feat: K badge resets tutorial; logo-k added as final callout step (#84)"
  ```

---

## Task 5: Push + PR + merge

- [ ] **Step 1: Push and open PR**

  ```
  git push -u origin feature/tutorial-reset-84
  gh pr create --title "feat: K badge resets tutorial (#84)" --body "Clicking the K badge (logo-k) clears the tutorial suppression and re-shows the help modal. After dismissal, callouts restart for the current screen. logo-k is also the last step of the playing-mode callout sequence. Closes #84."
  ```

- [ ] **Step 2: Merge and clean up**

  ```
  gh pr merge --merge --delete-branch
  git checkout master && git pull
  ```
