# Bug 102: OCR Review Screen — Layout, Completion Message, Classic Auto-Confirm

## Overview

Three related problems reported for a Classic sudoku on a 411×748 mobile viewport:

1. **Layout**: The warped grid image is too small and not square on mobile Classic review; the bottom of the warped image is obscured.
2. **Stale completion message**: "Puzzle solved — well done!" appears on the OCR review screen before the user has solved anything.
3. **Classic auto-confirm + back option**: A Classic sudoku whose OCR-detected given digits already form a complete valid grid should skip the review screen and go straight to playing mode, with an "Edit OCR" escape hatch in case the OCR was wrong.

---

## Fix 1 — CSS: warped image on Classic review (mobile portrait)

### Root cause

On mobile portrait (`max-width: 620px`) in Classic OCR review, both `#playing-actions` and `#review-actions` are visible. The combined `:has()` selector in `styles.css` overrides `#warped-img` to:

```css
#warped-img { width: auto; height: 100%; max-width: 100%; }
```

`height: 100%` resolves relative to the parent `#warped-col`. Because `#warped-col` has no defined height (it sizes itself around its content), `height: 100%` on the image is effectively zero. The image collapses. `overflow: hidden` on `#warped-col` then clips whatever small rendering appears.

### Fix

Remove both overrides from the `body:has(#playing-actions:not([hidden])):has(#review-actions:not([hidden]))` block in `styles.css`:

```css
/* Remove: */
body:has(#playing-actions:not([hidden])):has(#review-actions:not([hidden])) #warped-col {
  overflow: hidden;
}
body:has(#playing-actions:not([hidden])):has(#review-actions:not([hidden])) #warped-img {
  width: auto;
  height: 100%;
  max-width: 100%;
}
```

The base rule `#warped-img { width: 100%; aspect-ratio: 1; }` is correct: it makes the image square and fills its container's width (411px on mobile). The page scrolls naturally to reach the confirm button. The user confirmed that scrolling is acceptable.

The `min-height: 120px` on `#canvas-wrapper` for Classic review is kept — it remains useful to keep the grid canvas visible when the digit pad takes vertical space.

---

## Fix 2 — Stale completion message

### Root cause

`#completion-msg` is inside `#playing-actions`. When a prior Killer puzzle auto-confirms and `checkCompletion` sets `completion-msg.hidden = false`, that visibility persists across page state transitions. When the user then uploads a Classic puzzle, `applyUploadResult` shows `#playing-actions` (for the digit pad) but never resets `#completion-msg`, so the "solved" banner from the previous puzzle appears on the new review screen.

### Fix

Add one line to `applyUploadResult` in `main.ts`:

```typescript
el<HTMLElement>('completion-msg').hidden = true;
```

This runs before `playing-actions` is shown and ensures a clean state on every review screen entry.

---

## Fix 3 — Classic auto-confirm

### Trigger condition

When `handleProcess` receives a Classic result with no OCR warning AND `state.givenDigits` is a complete valid sudoku (all 81 cells non-zero, `validateSudokuSolution(state.givenDigits) === null`), skip the review screen and auto-confirm.

This mirrors the existing Killer auto-confirm path. The check is intentionally strict: any OCR warning, any missing digit, or any row/col/box conflict still sends the user to the review screen for manual correction.

`validateSudokuSolution` is already imported in `actions.ts`; it must also be imported in `main.ts`.

### Flow (new Classic path in `handleProcess`)

```
if (warning === null && state.puzzleType === 'classic' && state.givenDigits !== null) {
  const allFilled = state.givenDigits.every(row => row.every(d => d > 0));
  if (allFilled && validateSudokuSolution(state.givenDigits) === null) {
    // Store OCR state before confirming so the user can revert
    lastOcrState = state;
    lastWarpedUrl = warpedImageUrl;
    await new Promise<void>(resolve => setTimeout(resolve, 0)); // yield for loading indicator
    const { board } = solveCurrentSpec();
    logAction('auto_confirmed', 'classic');
    const playing = confirmPuzzle(board);
    renderPlayingMode(playing);
    appendCallouts(buildPlayingCallouts(false));
    const autoViolation = checkSolutionAssertions(playing);
    if (autoViolation !== null) showAssertionModal(autoViolation);
    setStatus('');
    return;
  }
}
// Fall through: show review screen as before
```

---

## Fix 4 — "Edit OCR" button (back option after auto-confirm)

### Purpose

After any auto-confirm (Classic or Killer), the user has no way to fix an OCR digit error without uploading the image again. The "Edit OCR" button returns them to the review screen with the original OCR result.

### State storage

Add two module-level variables to `main.ts`:

```typescript
let lastOcrState: PuzzleState | null = null;
let lastWarpedUrl: string | null = null;
```

Both are set immediately before every auto-confirm (Classic and Killer). For Killer auto-confirm, add the same assignment to the existing path in `handleProcess`.

### Session revert action

Add to `actions.ts`:

```typescript
export function revertToOcr(ocrState: PuzzleState): void {
  setState(ocrState);
}
```

This is the only change needed to the session layer. `setState` is already a module-level function in `actions.ts`; `revertToOcr` makes it available externally for this one purpose.

### HTML button

Add an "Edit OCR" button to the playing-mode action bar in `index.html`. Place it near the existing "New Puzzle" button. The button is hidden by default and shown only when `lastOcrState !== null`.

```html
<button id="edit-ocr-btn" hidden>Edit OCR</button>
```

### Click handler

```typescript
el<HTMLButtonElement>('edit-ocr-btn').addEventListener('click', () => {
  if (lastOcrState === null) return;
  revertToOcr(lastOcrState);
  applyUploadResult(lastOcrState, lastWarpedUrl, null);
  appendCallouts([{ id: 'confirm-btn', text: 'Correct any OCR errors, then confirm to re-solve.' }]);
  el<HTMLButtonElement>('edit-ocr-btn').hidden = true;
});
```

After clicking, the review screen appears with the original OCR layout and warped image. The user edits as needed and clicks "Confirm & Solve" to re-run from scratch.

### Show/hide logic

Show `#edit-ocr-btn` after any auto-confirm (Classic or Killer). Hide it: in the click handler above, in `applyUploadResult` (covers all review-screen entries), and at the start of `handleProcess` (new upload). Show it only after a successful auto-confirm.

---

## Testing

- Visual regression on mobile (411×748): warped image fills width, is square, confirm button reachable by scroll
- Completion message: load a Classic puzzle after a solved Killer — verify the banner does not carry over
- Classic auto-confirm: upload a pre-solved Classic grid (all 81 digits valid) — verify it goes straight to playing mode, "Edit OCR" button appears
- Classic review (non-auto): upload a partially-filled Classic grid — verify review screen appears, no "Edit OCR" button
- "Edit OCR" flow: auto-confirm → click Edit OCR → fix a digit → re-confirm → playing mode
- Bronze gate (tsc + tests) must pass before commit
