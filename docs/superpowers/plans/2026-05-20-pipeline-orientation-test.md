# Pipeline Orientation Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace two `it.todo` stubs in `inpImage.test.ts` with a real Playwright pipeline test that verifies `buildCageTotals` stores digits in row-major order.

**Architecture:** Expose `{ cageTotals, borderX, borderY }` on `window.__lastPipelineResult` unconditionally in `handleProcess()` (same pattern as `window.__pipelineReady`). The Playwright test reads this result, computes a connectivity score inline, and asserts it is ≥ 10 — a threshold that an orientation-correct pipeline passes easily but a transposed one fails.

**Tech Stack:** TypeScript, Playwright (Chromium, production build via `vite preview`), Vitest.

---

## File Map

| File | Change |
|---|---|
| `web/src/main.ts` | Add `window.__lastPipelineResult` assignment in `handleProcess()` after borders are set |
| `web/e2e/app.spec.ts` | Add one gated Playwright test with inline connectivity score check |
| `web/src/image/inpImage.test.ts` | Remove two `it.todo` entries; replace `describe` block with a reference comment |

---

## Task 0: Feature branch

- [ ] **Create branch**

```
git checkout -b feature/pipeline-orientation-test-85
```

---

## Task 1: Remove the `it.todo` stubs

**Files:**
- Modify: `web/src/image/inpImage.test.ts`

The two `it.todo` entries currently appear at lines 24–27 and 29–32 inside `describe('buildCageTotals — row-major orientation (T1)')`. The Playwright test we add in Task 2 replaces them.

- [ ] **Step 1: Replace the `describe` block with a reference comment**

  Find and replace the entire `describe('buildCageTotals — row-major orientation (T1)')` block (lines 23–33):

  ```ts
  describe('buildCageTotals — row-major orientation (T1)', () => {
    it.todo(
      'cageTotals[row][col] stores digit from pixel (x=col*subres, y=row*subres)' +
      ' — requires OpenCV WASM; port to Playwright when browser tests are available',
    );

    it.todo(
      'cageTotals[row=3][col=1] is non-zero when digit is centred at' +
      ' y=3.5*subres, x=1.5*subres — requires OpenCV WASM',
    );
  });
  ```

  Replace with:

  ```ts
  // buildCageTotals row-major orientation (T1)
  // Ported to Playwright: web/e2e/app.spec.ts
  // 'cageTotals row-major orientation — connectivityScore ≥ threshold'
  // Run with: PLAYWRIGHT_PIPELINE_TESTS=1 npx playwright test app.spec.ts
  ```

- [ ] **Step 2: Run Vitest to confirm the 2 todos are gone**

  ```
  cd web && npm test -- inpImage.test
  ```

  Expected: 1 test file, 4 tests pass (the `connectivityScore` describe blocks), 0 todo.

---

## Task 2: Add `window.__lastPipelineResult` hook

**Files:**
- Modify: `web/src/main.ts` (inside `handleProcess`, after line ~869 where `draftEdited = false`)

- [ ] **Step 1: Add the hook assignment**

  In `handleProcess()`, find:

  ```ts
    draftBorderX = ocrSpec.borderX.map(col => [...col]);
    draftBorderY = ocrSpec.borderY.map(row => [...row]);
    draftEdited = false;
  ```

  Replace with:

  ```ts
    draftBorderX = ocrSpec.borderX.map(col => [...col]);
    draftBorderY = ocrSpec.borderY.map(row => [...row]);
    draftEdited = false;
    // Expose pipeline result for Playwright integration tests (app.spec.ts).
    (window as unknown as Record<string, unknown>)['__lastPipelineResult'] = {
      cageTotals: state.specData.cageTotals,
      borderX: draftBorderX,
      borderY: draftBorderY,
    };
  ```

  This fires for every successful pipeline run — before auto-confirm and before review-screen rendering — so the hook is always set when processing succeeds.

- [ ] **Step 2: Type-check**

  ```
  cd web && tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 3: Run unit tests (no regression)**

  ```
  cd web && npm test
  ```

  Expected: 274 tests pass, 0 todo in the engine/image suites.

- [ ] **Step 4: Commit**

  ```
  git add web/src/main.ts web/src/image/inpImage.test.ts
  git commit -m "feat: window.__lastPipelineResult hook + remove it.todo stubs (#85)"
  ```

---

## Task 3: Add the Playwright test

**Files:**
- Modify: `web/e2e/app.spec.ts`

The new test is gated by `PLAYWRIGHT_PIPELINE_TESTS=1` (same as tests 7–14). Add it after the last existing slow test (currently "new puzzle button returns to upload panel", around line 275).

- [ ] **Step 1: Add the test**

  Append after the last `test.skip(!PIPELINE, …)` block:

  ```ts
  // ---------------------------------------------------------------------------
  // Test: cageTotals row-major orientation (replaces it.todo in inpImage.test.ts)
  // ---------------------------------------------------------------------------

  test('cageTotals row-major orientation — connectivityScore ≥ threshold', async ({ page }) => {
    test.skip(!PIPELINE, 'Needs PLAYWRIGHT_PIPELINE_TESTS=1');
    test.setTimeout(360_000);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForPipelineReady(page, 330_000);

    await page.locator('#file-input').setInputFiles(PUZZLE_IMAGE);
    await page.locator('#process-btn').click();
    await expect(page.locator('#review-panel')).toBeVisible({ timeout: 40_000 });

    // Read the pipeline result exposed by the dev hook and compute connectivity score.
    // The inline union-find mirrors buildUnionFind in validation.ts.
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
  ```

- [ ] **Step 2: Type-check**

  ```
  cd web && tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 3: Verify normal (non-pipeline) tests still skip correctly**

  ```
  cd web && npx playwright test app.spec.ts
  ```

  Expected: 4 passed, 11 skipped (the new test is skipped along with tests 7–14).

- [ ] **Step 4: Run with PLAYWRIGHT_PIPELINE_TESTS=1 (takes ~6 min)**

  This requires the Chunk 4 minimal OpenCV build to be in `web/public/`. If it is not present, the test times out. Skip this step if the build is not available and record a note.

  ```
  cd web && PLAYWRIGHT_PIPELINE_TESTS=1 npx playwright test app.spec.ts --grep "cageTotals"
  ```

  Expected: 1 test passes, score ≥ 10 printed in test output.

- [ ] **Step 5: Commit**

  ```
  git add web/e2e/app.spec.ts
  git commit -m "test: Playwright cageTotals row-major orientation test (#85)"
  ```

---

## Task 4: Push + PR + merge

- [ ] **Step 1: Push and open PR**

  ```
  git push -u origin feature/pipeline-orientation-test-85
  gh pr create --title "test: Playwright cageTotals row-major orientation test (#85)" \
    --body "Replaces two it.todo stubs in inpImage.test.ts with a real Playwright pipeline test. Adds window.__lastPipelineResult hook in handleProcess(). Closes #85."
  ```

- [ ] **Step 2: Merge and clean up**

  ```
  gh pr merge --merge --delete-branch
  git checkout master && git pull
  ```
