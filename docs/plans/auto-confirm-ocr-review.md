# Plan: Auto-Confirm OCR Review

Spec: `docs/specs/auto-confirm-ocr-review.md`

---

## Step 1 — Add `solverFindsCompleteSolution()` to `actions.ts`

- [ ] In `web/src/session/actions.ts`, add a new exported function after
  `confirmPuzzle()`:

  ```typescript
  export function solverFindsCompleteSolution(): boolean {
    const state = requireState();
    if (state.userGrid !== null) throw new Error('Already confirmed');
    const spec = cageStatesToSpec(state.cageStates, state.specData);
    const givenDigits = state.givenDigits ?? undefined;
    const board = solve(spec, givenDigits);
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (board.cands(r, c).size !== 1) return false;
    return true;
  }
  ```

- [ ] Add `solverFindsCompleteSolution` to the import list in `main.ts`.

---

## Step 2 — Extract draft border initialization in `handleProcess()`

Currently `applyUploadResult()` initialises `draftBorderX`, `draftBorderY`, and
`draftEdited`. These must now also be available in `handleProcess()` before the
auto-confirm attempt, so extract them:

- [ ] In `handleProcess()`, after `uploadPuzzle()` returns, add:
  ```typescript
  const spec = dataToSpec(state.specData);
  draftBorderX = spec.borderX.map(col => [...col]);
  draftBorderY = spec.borderY.map(row => [...row]);
  draftEdited = false;
  ```

- [ ] Remove those same three assignments from `applyUploadResult()` (they will
  already be set by the time `applyUploadResult()` is called from `handleProcess()`).
  Confirm no other callers of `applyUploadResult()` relied on this initialization
  (`__testLoad` path in the dev harness — check and update if needed).

---

## Step 3 — Add auto-confirm attempt in `handleProcess()`

- [ ] After initializing draft borders and `currentState = state`, add the
  auto-confirm block (before the existing `applyUploadResult()` call):

  ```typescript
  // Attempt auto-confirm: skip review screen if puzzle is clean and solvable.
  const layoutResult = applyDraftLayout(
    draftBorderX, draftBorderY, state.specData.cageTotals,
  );
  if (layoutResult.errorCells.size === 0 && layoutResult.warnings.length === 0
      && solverFindsCompleteSolution()) {
    const playing = confirmPuzzle();
    renderPlayingMode(playing);
    pendingCellThumbs = new Map();
    setStatus('');
    return;
  }
  ```

- [ ] After the auto-confirm block, in the fallback path that calls
  `applyUploadResult()`, determine the correct error message and pass it as the
  `warning` argument (or set it with `setStatus` immediately after):

  - Structural errors (`layoutResult.errorCells.size > 0`):
    - Pass `null` to `applyUploadResult()` (warning)
    - After the call: `reviewErrorCells = layoutResult.errorCells; redrawGrid();`
    - Then: `setStatus('Each cage needs exactly one total in its valid range — highlighted in red', true)`
  - Sum warnings (`layoutResult.warnings.length > 0`):
    - After `applyUploadResult()`: `setStatus(layoutResult.warnings.join('; ') + ' — please correct the totals before confirming', true)`
  - Validation passed but `solverFindsCompleteSolution()` returned false:
    - After `applyUploadResult()`: `setStatus('Solver could not determine all cells — please check the cage layout and totals', true)`

  Note: `applyUploadResult()` currently sets `currentState` via `renderState()`. In
  the fallback, pass `layoutResult.state` (the updated state from `applyDraftLayout()`)
  rather than the raw `state` from `uploadPuzzle()`, so the canvas reflects any
  cage-total normalisation that `applyDraftLayout()` applied. Exception: when
  `layoutResult.errorCells.size > 0`, `applyDraftLayout()` returns the original
  `state` unchanged, so pass `state`.

---

## Step 4 — Update `applyUploadResult()` signature

- [ ] Remove the draft border initialization lines from `applyUploadResult()` (done in
  Step 2). Verify the function is otherwise unchanged.

- [ ] Check the `__testLoad` / `loadSpecDirect` dev-harness path in `main.ts`
  (around line 1166). It calls a different initialization flow — confirm it still
  initializes `draftBorderX`/`draftBorderY` correctly, and add the explicit
  initialization there if needed.

---

## Step 5 — Update `docs/ui.md`

- [ ] Update the **Application Flow** diagram:

  ```
  Upload Screen
      │  image processed
      ▼
  Auto-confirm attempt
      │ clean OCR + unique solution           │ validation error / no unique solution
      ▼                                        ▼
  Playing Screen ──► Solution Screen      OCR Review Screen (always has error message)
                                               │ "Confirm & Solve" pressed, layout valid
                                               ▼
                                          Playing Screen ──► Solution Screen
  ```

- [ ] Update the **Upload Screen → Behaviour** section: note that the OCR Review
  Screen is only shown when auto-confirm fails.

- [ ] Update the **OCR Review Screen** introduction: note it always has a non-empty
  error/warning in the status bar when it appears.

---

## Step 6 — Bronze gate

Run from `web/`:

```bash
tsc --noEmit
tsc -p tsconfig.node.json --noEmit
npm test
```

All must pass. Fix any failures before committing.

---

## Step 7 — Playwright (Silver gate check, run after Step 6)

The flow tests in `e2e/flow.spec.ts` exercise `window.__testLoad`, which bypasses the
image pipeline entirely and goes straight to the review screen. These tests are
unaffected by this change.

The pipeline Playwright tests (`e2e/app.spec.ts`, `e2e/offline.spec.ts`) use test
fixtures that may need to be verified against the new flow. Check that no test
asserts the review panel is always visible after upload.

Run:

```bash
npx playwright test
npx playwright test --config playwright.dev.config.ts
```
