# Pipeline Orientation Test Design

**Date:** 2026-05-20
**Issue:** #85
**Scope:** `web/src/main.ts`, `web/e2e/app.spec.ts`, `web/src/image/inpImage.test.ts`

---

## Context

Two `it.todo` tests in `web/src/image/inpImage.test.ts` test the row-major orientation contract of `buildCageTotals` but were deferred because they require OpenCV WASM. The Playwright pipeline tests (`app.spec.ts`, gated by `PLAYWRIGHT_PIPELINE_TESTS=1`) now provide the required browser environment. This design ports those tests there.

---

## Design

### 1. Dev Hook — `window.__lastPipelineResult`

In `main.ts`, inside `handleProcess()`, immediately after the call to `applyUploadResult()`, add a guarded assignment. The hook stores the three arrays needed to compute the connectivity score:

```ts
if (import.meta.env.DEV) {
  (window as Record<string, unknown>)['__lastPipelineResult'] = {
    cageTotals: state.specData.cageTotals,  // 9×9 row-major array from buildCageTotals
    borderX: draftBorderX,                  // 9×8 [col][rowGap] — true = wall
    borderY: draftBorderY,                  // 8×9 [colGap][row] — true = wall
  };
}
```

`draftBorderX` and `draftBorderY` are already module-level variables populated during the pipeline run. `state.specData.cageTotals` is the direct output of `buildCageTotals`.

The hook is only set on success — if `parsePuzzleImage` throws, `applyUploadResult` is never called and the hook is not set. Tests must assert the hook is set before reading it.

### 2. Gated Playwright Test — `app.spec.ts`

Add one new test inside the `if (PLAYWRIGHT_PIPELINE_TESTS === '1')` conditional at the bottom of the file (alongside the existing pipeline tests 7–14):

**Test: `cageTotals row-major orientation — connectivityScore ≥ threshold`**

Steps:
1. Upload `guardian/killer_sudoku_0.jpg` via `#file-input`.
2. Click `#process-btn`.
3. Call `waitForPipelineReady(page)`.
4. Assert `#review-panel` is visible (timeout 30s).
5. Read `window.__lastPipelineResult` via `page.evaluate()`.
6. Inside `evaluate()`, run a self-contained union-find over `borderX`/`borderY` (mirrors `buildUnionFind` from `validation.ts`) and count regions with exactly one non-zero `cageTotals` cell — the connectivity score.
7. Assert `score >= 10`.

**Threshold rationale:** A Guardian killer sudoku has ~26 cages. Correct orientation → score ≈ 26. Transposed orientation → most cage heads land in the wrong region → score ≤ 2. Threshold 10 is very conservative and immune to minor OCR misses.

**Inline union-find** (embedded in `evaluate()` — no imports needed):

```ts
const score = await page.evaluate(() => {
  const { cageTotals, borderX, borderY } =
    (window as Record<string, unknown>)['__lastPipelineResult'] as {
      cageTotals: number[][]; borderX: boolean[][]; borderY: boolean[][];
    };
  const rep: Record<string, string> = {};
  const members: Record<string, string[]> = {};
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const k = `${r},${c}`; rep[k] = k; members[k] = [k];
  }
  const find = (k: string): string => rep[k]!;
  const union = (a: string, b: string) => {
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
```

### 3. Remove `it.todo` from `inpImage.test.ts`

Replace the `describe('buildCageTotals — row-major orientation (T1)')` block with a comment referencing the new Playwright test. The two `it.todo` entries are deleted — they are no longer pending.

---

## Files Changed

| File | Change |
|---|---|
| `web/src/main.ts` | Add `window.__lastPipelineResult` assignment in dev mode after `applyUploadResult` |
| `web/e2e/app.spec.ts` | Add one gated pipeline test with inline connectivity-score check |
| `web/src/image/inpImage.test.ts` | Remove `describe('buildCageTotals...')` block; replace with reference comment |

---

## Testing

- Run with `PLAYWRIGHT_PIPELINE_TESTS=1 npx playwright test e2e/app.spec.ts` to execute the new test.
- `npm test` still passes (no Vitest changes).
- `tsc --noEmit` is clean (the evaluate callback is typed via cast, no extra imports).
